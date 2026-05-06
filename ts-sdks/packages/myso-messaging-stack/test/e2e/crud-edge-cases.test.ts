// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for CRUD edge cases.
// Tests error handling and edge cases for message operations:
// 1. Delete operations (non-existent, double delete)
// 2. Update operations (non-existent, deleted message, non-owner)
// 3. Message retrieval edge cases (no permissions, invalid UUID)

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

describe('CRUD Edge Cases', () => {
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
	let owner: GroupUser;
	let editor: GroupUser;
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
		const funding: AccountFunding = { client: adminClient, signer: adminKeypair };

		uuid = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'CRUD Edge Cases Test Group',
		});
		groupId = adminClient.messaging.derive.groupId({ uuid });

		const messagingPerms = messagingPermissionTypes(publishedPackages['messaging'].packageId);

		// Owner: all permissions
		const ownerAccount = await createFundedAccount(funding);
		owner = { keypair: ownerAccount.keypair, client: buildClient(ownerAccount.keypair) };
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: ownerAccount.address,
			permissionTypes: Object.values(messagingPerms),
		});

		// Editor: only editor permission
		const editorAccount = await createFundedAccount(funding);
		editor = { keypair: editorAccount.keypair, client: buildClient(editorAccount.keypair) };
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: editorAccount.address,
			permissionTypes: [messagingPerms.MessagingEditor],
		});

		await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));
	}, 180_000);

	describe('Delete Operations', () => {
		it('should return 404 for non-existent message', async () => {
			await expect(
				owner.client.messaging.deleteMessage({
					signer: owner.keypair,
					groupRef: { uuid },
					messageId: '00000000-0000-0000-0000-000000000000',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 404;
			});
		});

		it('should handle delete of already deleted message', async () => {
			const { messageId } = await owner.client.messaging.sendMessage({
				signer: owner.keypair,
				groupRef: { uuid },
				text: 'Delete me twice',
			});

			await owner.client.messaging.deleteMessage({
				signer: owner.keypair,
				groupRef: { uuid },
				messageId,
			});

			// Second delete — could be idempotent (200) or error
			try {
				await owner.client.messaging.deleteMessage({
					signer: owner.keypair,
					groupRef: { uuid },
					messageId,
				});
				// If it succeeds, that's fine (idempotent)
			} catch (error) {
				// If it fails, it should be a transport error
				expect(error).toBeInstanceOf(RelayerTransportError);
			}
		});
	});

	describe('Update Operations', () => {
		let messageToUpdate: string;

		beforeAll(async () => {
			const result = await owner.client.messaging.sendMessage({
				signer: owner.keypair,
				groupRef: { uuid },
				text: 'Original message content',
			});
			messageToUpdate = result.messageId;
		});

		it('should return 404 when updating non-existent message', async () => {
			await expect(
				owner.client.messaging.editMessage({
					signer: owner.keypair,
					groupRef: { uuid },
					messageId: '00000000-0000-0000-0000-000000000000',
					text: 'Updated content',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 404;
			});
		});

		it('should handle update of deleted message', async () => {
			const { messageId } = await owner.client.messaging.sendMessage({
				signer: owner.keypair,
				groupRef: { uuid },
				text: 'Will be deleted then updated',
			});

			await owner.client.messaging.deleteMessage({
				signer: owner.keypair,
				groupRef: { uuid },
				messageId,
			});

			// Updating a deleted message — could be allowed (200), bad request (400), or not found (404)
			try {
				await owner.client.messaging.editMessage({
					signer: owner.keypair,
					groupRef: { uuid },
					messageId,
					text: 'Trying to update deleted',
				});
				// If it succeeds, the relayer allows editing deleted messages
			} catch (error) {
				// If it fails, it should be a transport error
				expect(error).toBeInstanceOf(RelayerTransportError);
			}
		});

		it('should reject update by user with Editor permission but not owner', async () => {
			await expect(
				editor.client.messaging.editMessage({
					signer: editor.keypair,
					groupRef: { uuid },
					messageId: messageToUpdate,
					text: 'Hijacked by editor',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});
	});

	describe('Message Retrieval Edge Cases', () => {
		it('should return 403 for group where user has no synced permissions', async () => {
			// Create a new group, don't grant owner permissions in it
			const otherUuid = crypto.randomUUID();
			await admin.client.messaging.createAndShareGroup({
				signer: admin.keypair,
				uuid: otherUuid,
				name: 'No-permissions group',
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			await expect(
				owner.client.messaging.getMessages({
					signer: owner.keypair,
					groupRef: { uuid: otherUuid },
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		}, 30_000);

		it('should return messages when fetching with valid permissions', async () => {
			const result = await owner.client.messaging.getMessages({
				signer: owner.keypair,
				groupRef: { uuid },
			});

			expect(result.messages.length).toBeGreaterThan(0);
		});
	});
});
