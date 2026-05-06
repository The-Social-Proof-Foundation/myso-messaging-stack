// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for multi-group scenarios.
// Tests behavior across multiple groups:
// 1. User permissions are group-specific
// 2. Cross-group access is blocked
// 3. User can be member of multiple groups
// 4. Messages are isolated to their groups

import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import {
	messagingPermissionTypes,
	RelayerTransportError,
	EncryptionAccessDeniedError,
} from '@socialproof/myso-messaging-stack';
import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
	type AccountFunding,
} from '../helpers/index.js';

import type { GroupUser } from './helpers/setup-group.js';

describe('Multi-Group Scenarios', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const publishedPackages = inject('publishedPackages');
	const adminAccount = inject('adminAccount');
	const messagingNamespaceId = inject('messagingNamespaceId');
	const messagingVersionId = inject('messagingVersionId');
	const mydataServerConfigs = inject('mydataServerConfigs');

	const SYNC_WAIT_TIME = 15_000;

	let alice: GroupUser; // Member of Group A only
	let bob: GroupUser; // Member of Group B only
	let charlie: GroupUser; // Member of both groups
	let outsider: GroupUser; // Member of neither group

	let uuidA: string;
	let uuidB: string;
	let groupAId: string;
	let groupBId: string;

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
		const funding: AccountFunding = { client: adminClient, signer: adminKeypair };
		const messagingPerms = messagingPermissionTypes(publishedPackages['messaging'].packageId);
		const senderReader = [messagingPerms.MessagingSender, messagingPerms.MessagingReader];

		// Create Group A
		uuidA = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid: uuidA,
			name: 'Multi-Group Test A',
		});
		groupAId = adminClient.messaging.derive.groupId({ uuid: uuidA });

		// Create Group B
		uuidB = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid: uuidB,
			name: 'Multi-Group Test B',
		});
		groupBId = adminClient.messaging.derive.groupId({ uuid: uuidB });

		// Create users
		const aliceAccount = await createFundedAccount(funding);
		alice = { keypair: aliceAccount.keypair, client: buildClient(aliceAccount.keypair) };

		const bobAccount = await createFundedAccount(funding);
		bob = { keypair: bobAccount.keypair, client: buildClient(bobAccount.keypair) };

		const charlieAccount = await createFundedAccount(funding);
		charlie = { keypair: charlieAccount.keypair, client: buildClient(charlieAccount.keypair) };

		const outsiderAccount = await createFundedAccount(funding);
		outsider = { keypair: outsiderAccount.keypair, client: buildClient(outsiderAccount.keypair) };

		// Alice → Group A only
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId: groupAId,
			member: aliceAccount.address,
			permissionTypes: senderReader,
		});

		// Bob → Group B only
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId: groupBId,
			member: bobAccount.address,
			permissionTypes: senderReader,
		});

		// Charlie → Both groups
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId: groupAId,
			member: charlieAccount.address,
			permissionTypes: senderReader,
		});
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId: groupBId,
			member: charlieAccount.address,
			permissionTypes: senderReader,
		});

		await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));
	}, 180_000);

	describe('Group-Specific Permissions', () => {
		it('Alice can send to Group A', async () => {
			const result = await alice.client.messaging.sendMessage({
				signer: alice.keypair,
				groupRef: { uuid: uuidA },
				text: 'Alice message to Group A',
			});
			expect(result.messageId).toBeTruthy();
		});

		it('Alice cannot send to Group B', async () => {
			await expect(
				alice.client.messaging.sendMessage({
					signer: alice.keypair,
					groupRef: { uuid: uuidB },
					text: 'Alice trying Group B',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('Bob can send to Group B', async () => {
			const result = await bob.client.messaging.sendMessage({
				signer: bob.keypair,
				groupRef: { uuid: uuidB },
				text: 'Bob message to Group B',
			});
			expect(result.messageId).toBeTruthy();
		});

		it('Bob cannot send to Group A', async () => {
			await expect(
				bob.client.messaging.sendMessage({
					signer: bob.keypair,
					groupRef: { uuid: uuidA },
					text: 'Bob trying Group A',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});
	});

	describe('Multi-Group Membership', () => {
		it('Charlie can send to Group A', async () => {
			const result = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidA },
				text: 'Charlie message to Group A',
			});
			expect(result.messageId).toBeTruthy();
		});

		it('Charlie can send to Group B', async () => {
			const result = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidB },
				text: 'Charlie message to Group B',
			});
			expect(result.messageId).toBeTruthy();
		});

		it('Charlie can send to both groups in sequence', async () => {
			const resultA = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidA },
				text: 'Charlie sequential A',
			});
			const resultB = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidB },
				text: 'Charlie sequential B',
			});

			expect(resultA.messageId).toBeTruthy();
			expect(resultB.messageId).toBeTruthy();
		});
	});

	describe('Outsider Access', () => {
		it('Outsider cannot send to Group A', async () => {
			await expect(
				outsider.client.messaging.sendMessage({
					signer: outsider.keypair,
					groupRef: { uuid: uuidA },
					text: 'Outsider trying Group A',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('Outsider cannot send to Group B', async () => {
			await expect(
				outsider.client.messaging.sendMessage({
					signer: outsider.keypair,
					groupRef: { uuid: uuidB },
					text: 'Outsider trying Group B',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('Outsider cannot read messages (requires Reader permission)', async () => {
			await expect(
				outsider.client.messaging.getMessages({
					signer: outsider.keypair,
					groupRef: { uuid: uuidA },
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});

	describe('Message Isolation', () => {
		let groupAMessageId: string;
		let groupBMessageId: string;

		beforeAll(async () => {
			const resultA = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidA },
				text: 'Group A isolation test',
			});
			groupAMessageId = resultA.messageId;

			const resultB = await charlie.client.messaging.sendMessage({
				signer: charlie.keypair,
				groupRef: { uuid: uuidB },
				text: 'Group B isolation test',
			});
			groupBMessageId = resultB.messageId;
		});

		it('Group A messages are not visible in Group B', async () => {
			const result = await charlie.client.messaging.getMessages({
				signer: charlie.keypair,
				groupRef: { uuid: uuidB },
				limit: 100,
			});

			const foundInB = result.messages.some((m) => m.messageId === groupAMessageId);
			expect(foundInB).toBe(false);
		});

		it('Group B messages are not visible in Group A', async () => {
			const result = await charlie.client.messaging.getMessages({
				signer: charlie.keypair,
				groupRef: { uuid: uuidA },
				limit: 100,
			});

			const foundInA = result.messages.some((m) => m.messageId === groupBMessageId);
			expect(foundInA).toBe(false);
		});

		it('Each group has only its own messages', async () => {
			const groupAMessages = await charlie.client.messaging.getMessages({
				signer: charlie.keypair,
				groupRef: { uuid: uuidA },
				limit: 100,
			});
			const groupBMessages = await charlie.client.messaging.getMessages({
				signer: charlie.keypair,
				groupRef: { uuid: uuidB },
				limit: 100,
			});

			const groupAIds = new Set(groupAMessages.messages.map((m) => m.messageId));
			const groupBIds = new Set(groupBMessages.messages.map((m) => m.messageId));

			const intersection = [...groupAIds].filter((id) => groupBIds.has(id));
			expect(intersection.length).toBe(0);
		});
	});

	describe('Cross-Group Operations', () => {
		let groupAMessage: string;

		beforeAll(async () => {
			const result = await alice.client.messaging.sendMessage({
				signer: alice.keypair,
				groupRef: { uuid: uuidA },
				text: 'Alice message for cross-group test',
			});
			groupAMessage = result.messageId;
		});

		it("Bob cannot update Alice's message in Group A (not a member)", async () => {
			await expect(
				bob.client.messaging.editMessage({
					signer: bob.keypair,
					groupRef: { uuid: uuidA },
					messageId: groupAMessage,
					text: 'Bob hijacking Alice',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it("Bob cannot delete Alice's message in Group A (not a member)", async () => {
			await expect(
				bob.client.messaging.deleteMessage({
					signer: bob.keypair,
					groupRef: { uuid: uuidA },
					messageId: groupAMessage,
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});
});
