// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for permission synchronization.
// Tests the gRPC event subscription flow:
// 1. Grant permissions on-chain
// 2. Wait for relayer to sync via gRPC
// 3. Verify the relayer recognizes the new permissions

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import {
	messagingPermissionTypes,
	EncryptionAccessDeniedError,
	RelayerTransportError,
} from '@socialproof/myso-messaging-stack';
import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
	type AccountFunding,
} from '../helpers/index.js';

import type { GroupUser } from './helpers/setup-group.js';

describe('Permission Synchronization', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const publishedPackages = inject('publishedPackages');
	const adminAccount = inject('adminAccount');
	const messagingNamespaceId = inject('messagingNamespaceId');
	const messagingVersionId = inject('messagingVersionId');
	const mydataServerConfigs = inject('mydataServerConfigs');

	const SYNC_WAIT_TIME = 15_000;

	let admin: GroupUser;
	let funding: AccountFunding;
	let user1: GroupUser;
	let user2: GroupUser;
	let uuid: string;
	let groupId: string;

	function buildClient(keypair: Ed25519Keypair): MySoMessagingStackTestClient {
		return createMySoMessagingStackClient({
			url: mysoClientUrl,
			network,
			permissionedGroupsPackageId: publishedPackages['permissioned-groups'].packageId,
			messagingPackageId: publishedPackages['messaging'].packageId,
			namespaceId: messagingNamespaceId,
			versionId: messagingVersionId,
			keypair,
			relayer: { relayerUrl },
			mydata:
				mydataServerConfigs.length > 0
					? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
					: undefined,
		});
	}

	beforeAll(async () => {
		const adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);
		const adminClient = buildClient(adminKeypair);
		admin = { keypair: adminKeypair, client: adminClient };
		funding = { client: adminClient, signer: adminKeypair };

		// Create group
		uuid = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Permission Sync Test Group',
		});
		groupId = adminClient.messaging.derive.groupId({ uuid });

		// Create user keypairs (funded for on-chain ops, but permissions not yet granted)
		const user1Account = await createFundedAccount(funding);
		user1 = { keypair: user1Account.keypair, client: buildClient(user1Account.keypair) };

		const user2Account = await createFundedAccount(funding);
		user2 = { keypair: user2Account.keypair, client: buildClient(user2Account.keypair) };

		// Wait for group creation event to sync
		await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));
	}, 180_000);

	describe('Grant Permissions Flow', () => {
		it('user without permissions should be rejected', async () => {
			await expect(
				user1.client.messaging.sendMessage({
					signer: user1.keypair,
					groupRef: { uuid },
					text: 'Unauthorized message',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		}, 180_000);

		it('should recognize permissions after on-chain grant', async () => {
			const messagingPerms = messagingPermissionTypes(publishedPackages['messaging'].packageId);

			// MessagingReader is required for DEK decryption (mydata_approve_reader)
			await admin.client.groups.grantPermissions({
				signer: admin.keypair,
				groupId,
				member: user1.keypair.toMySoAddress(),
				permissionTypes: [messagingPerms.MessagingSender, messagingPerms.MessagingReader],
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			const result = await user1.client.messaging.sendMessage({
				signer: user1.keypair,
				groupRef: { uuid },
				text: 'Now I have permission!',
			});

			expect(result.messageId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		}, 60_000);

		it('should grant multiple permissions at once', async () => {
			const messagingPerms = messagingPermissionTypes(publishedPackages['messaging'].packageId);

			await admin.client.groups.grantPermissions({
				signer: admin.keypair,
				groupId,
				member: user2.keypair.toMySoAddress(),
				permissionTypes: [
					messagingPerms.MessagingSender,
					messagingPerms.MessagingReader,
					messagingPerms.MessagingEditor,
				],
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			const result = await user2.client.messaging.sendMessage({
				signer: user2.keypair,
				groupRef: { uuid },
				text: 'User2 with multiple permissions',
			});

			expect(result.messageId).toBeTruthy();
		}, 60_000);
	});

	describe('Revoke Permissions Flow', () => {
		it('should revoke permission and block user', async () => {
			// Verify user1 can still send
			await user1.client.messaging.sendMessage({
				signer: user1.keypair,
				groupRef: { uuid },
				text: 'Before revoke',
			});

			const messagingPerms = messagingPermissionTypes(publishedPackages['messaging'].packageId);

			await admin.client.groups.revokePermissions({
				signer: admin.keypair,
				groupId,
				member: user1.keypair.toMySoAddress(),
				permissionTypes: [messagingPerms.MessagingSender, messagingPerms.MessagingReader],
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			await expect(
				user1.client.messaging.sendMessage({
					signer: user1.keypair,
					groupRef: { uuid },
					text: 'After revoke',
				}),
			).rejects.toSatisfy(
				(error) =>
					error instanceof EncryptionAccessDeniedError ||
					(error instanceof RelayerTransportError && error.status === 403),
			);
		}, 60_000);
	});

	describe('Remove Member Flow', () => {
		it('should remove member and block all operations', async () => {
			// Verify user2 can still send
			await user2.client.messaging.sendMessage({
				signer: user2.keypair,
				groupRef: { uuid },
				text: 'Before removal',
			});

			await admin.client.groups.removeMember({
				signer: admin.keypair,
				groupId,
				member: user2.keypair.toMySoAddress(),
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			await expect(
				user2.client.messaging.sendMessage({
					signer: user2.keypair,
					groupRef: { uuid },
					text: 'After removal',
				}),
			).rejects.toSatisfy(
				(error) =>
					error instanceof EncryptionAccessDeniedError ||
					(error instanceof RelayerTransportError && error.status === 403),
			);
		}, 60_000);
	});

	describe('Admin Operations', () => {
		it('admin permissions synced from group creation', async () => {
			const result = await admin.client.messaging.sendMessage({
				signer: admin.keypair,
				groupRef: { uuid },
				text: 'Admin message',
			});

			expect(result.messageId).toBeTruthy();
		});
	});
});
