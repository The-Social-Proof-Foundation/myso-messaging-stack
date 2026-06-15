// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E tests for permission-specific operations.
// Tests each permission type in isolation:
// 1. MessagingSender - can create messages
// 2. MessagingReader - can read messages
// 3. MessagingEditor - can update own messages (not others')
// 4. MessagingDeleter - can delete messages
// 5. No Permission User - blocked from all operations
// 6. Permission Combinations

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

describe('Permission-Specific Operations', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const adminAccount = inject('adminAccount');
	const mydataServerConfigs = inject('mydataServerConfigs');

	const SYNC_WAIT_TIME = 15_000;

	let admin: GroupUser;
	let funding: AccountFunding;
	let senderOnly: GroupUser;
	let readerOnly: GroupUser;
	let editorOnly: GroupUser;
	let deleterOnly: GroupUser;
	let noPermission: GroupUser;
	let uuid: string;
	let groupId: string;
	let testMessageId: string;

	function buildClient(keypair: Ed25519Keypair): MySoMessagingStackTestClient {
		return createMySoMessagingStackClient({
			url: mysoClientUrl,
			network,
			packageConfig: genesisConfig,
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

		uuid = crypto.randomUUID();
		await adminClient.messaging.createAndShareGroup({
			signer: adminKeypair,
			uuid,
			name: 'Permission-Specific Test Group',
		});
		groupId = adminClient.messaging.derive.groupId({ uuid });

		const messagingPerms = messagingPermissionTypes(genesisConfig.messaging.originalPackageId);

		// SenderOnly
		const senderAccount = await createFundedAccount(funding);
		senderOnly = { keypair: senderAccount.keypair, client: buildClient(senderAccount.keypair) };
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: senderAccount.address,
			permissionTypes: [messagingPerms.MessagingSender, messagingPerms.MessagingReader],
		});

		// ReaderOnly
		const readerAccount = await createFundedAccount(funding);
		readerOnly = { keypair: readerAccount.keypair, client: buildClient(readerAccount.keypair) };
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: readerAccount.address,
			permissionTypes: [messagingPerms.MessagingReader],
		});

		// EditorOnly
		const editorAccount = await createFundedAccount(funding);
		editorOnly = { keypair: editorAccount.keypair, client: buildClient(editorAccount.keypair) };
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: editorAccount.address,
			permissionTypes: [messagingPerms.MessagingEditor, messagingPerms.MessagingReader],
		});

		// DeleterOnly
		const deleterAccount = await createFundedAccount(funding);
		deleterOnly = {
			keypair: deleterAccount.keypair,
			client: buildClient(deleterAccount.keypair),
		};
		await adminClient.groups.grantPermissions({
			signer: adminKeypair,
			groupId,
			member: deleterAccount.address,
			permissionTypes: [messagingPerms.MessagingDeleter],
		});

		// NoPermission
		const noPermAccount = await createFundedAccount(funding);
		noPermission = {
			keypair: noPermAccount.keypair,
			client: buildClient(noPermAccount.keypair),
		};

		await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

		// Create a test message for editor/deleter tests (via senderOnly)
		const result = await senderOnly.client.messaging.sendMessage({
			signer: senderOnly.keypair,
			groupRef: { uuid },
			text: 'Test message for permission tests',
		});
		testMessageId = result.messageId;
	}, 180_000);

	describe('MessagingSender Permission', () => {
		it('user with ONLY MessagingSender can create messages', async () => {
			const result = await senderOnly.client.messaging.sendMessage({
				signer: senderOnly.keypair,
				groupRef: { uuid },
				text: 'Sender only message',
			});

			expect(result.messageId).toBeTruthy();
		});

		it('user without MessagingSender cannot create messages', async () => {
			await expect(
				readerOnly.client.messaging.sendMessage({
					signer: readerOnly.keypair,
					groupRef: { uuid },
					text: 'Reader trying to send',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});

	describe('MessagingReader Permission', () => {
		it('user with MessagingReader can read messages', async () => {
			const result = await readerOnly.client.messaging.getMessages({
				signer: readerOnly.keypair,
				groupRef: { uuid },
			});

			expect(result.messages.length).toBeGreaterThan(0);
		});

		it('user with no permissions cannot read messages', async () => {
			await expect(
				noPermission.client.messaging.getMessages({
					signer: noPermission.keypair,
					groupRef: { uuid },
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});

	describe('MessagingEditor Permission', () => {
		it('user with ONLY MessagingEditor cannot create messages', async () => {
			await expect(
				editorOnly.client.messaging.sendMessage({
					signer: editorOnly.keypair,
					groupRef: { uuid },
					text: 'Editor trying to create',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});

		it("user with MessagingEditor cannot update others' messages", async () => {
			await expect(
				editorOnly.client.messaging.editMessage({
					signer: editorOnly.keypair,
					groupRef: { uuid },
					messageId: testMessageId,
					text: 'Editor hijacking message',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});

		it('user can update their own message if they have MessagingEditor', async () => {
			const messagingPerms = messagingPermissionTypes(genesisConfig.messaging.originalPackageId);

			// Temporarily grant Sender to EditorOnly
			await admin.client.groups.grantPermissions({
				signer: admin.keypair,
				groupId,
				member: editorOnly.keypair.toMySoAddress(),
				permissionTypes: [messagingPerms.MessagingSender],
			});
			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			// Create a message as EditorOnly
			const { messageId } = await editorOnly.client.messaging.sendMessage({
				signer: editorOnly.keypair,
				groupRef: { uuid },
				text: 'EditorOnly message',
			});

			// Update own message
			await editorOnly.client.messaging.editMessage({
				signer: editorOnly.keypair,
				groupRef: { uuid },
				messageId,
				text: 'EditorOnly updated their message',
			});

			const updated = await admin.client.messaging.getMessage({
				signer: admin.keypair,
				groupRef: { uuid },
				messageId,
			});
			expect(updated.text).toBe('EditorOnly updated their message');
			expect(updated.isEdited).toBe(true);

			// Clean up — revoke Sender
			await admin.client.groups.revokePermissions({
				signer: admin.keypair,
				groupId,
				member: editorOnly.keypair.toMySoAddress(),
				permissionTypes: [messagingPerms.MessagingSender],
			});
		}, 60_000);
	});

	describe('MessagingDeleter Permission', () => {
		it('user with ONLY MessagingDeleter cannot create messages', async () => {
			await expect(
				deleterOnly.client.messaging.sendMessage({
					signer: deleterOnly.keypair,
					groupRef: { uuid },
					text: 'Deleter trying to create',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('message owner with Deleter permission can delete their own message', async () => {
			const messagingPerms = messagingPermissionTypes(genesisConfig.messaging.originalPackageId);

			// Grant Deleter to senderOnly (already has Sender)
			await admin.client.groups.grantPermissions({
				signer: admin.keypair,
				groupId,
				member: senderOnly.keypair.toMySoAddress(),
				permissionTypes: [messagingPerms.MessagingDeleter],
			});
			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));

			const { messageId } = await senderOnly.client.messaging.sendMessage({
				signer: senderOnly.keypair,
				groupRef: { uuid },
				text: 'SenderOnly message to delete',
			});

			await senderOnly.client.messaging.deleteMessage({
				signer: senderOnly.keypair,
				groupRef: { uuid },
				messageId,
			});

			const deleted = await admin.client.messaging.getMessage({
				signer: admin.keypair,
				groupRef: { uuid },
				messageId,
			});
			expect(deleted.isDeleted).toBe(true);
		}, 30_000);
	});

	describe('No Permission User', () => {
		it('user with no permissions cannot create messages', async () => {
			await expect(
				noPermission.client.messaging.sendMessage({
					signer: noPermission.keypair,
					groupRef: { uuid },
					text: 'No permission message',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('user with no permissions cannot update messages', async () => {
			await expect(
				noPermission.client.messaging.editMessage({
					signer: noPermission.keypair,
					groupRef: { uuid },
					messageId: testMessageId,
					text: 'No permission update',
				}),
			).rejects.toBeInstanceOf(EncryptionAccessDeniedError);
		});

		it('user with no permissions cannot delete messages', async () => {
			await expect(
				noPermission.client.messaging.deleteMessage({
					signer: noPermission.keypair,
					groupRef: { uuid },
					messageId: testMessageId,
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});

	describe('Permission Combinations', () => {
		let combinedUser: GroupUser;

		beforeAll(async () => {
			const messagingPerms = messagingPermissionTypes(genesisConfig.messaging.originalPackageId);

			const account = await createFundedAccount(funding);
			combinedUser = { keypair: account.keypair, client: buildClient(account.keypair) };

			// Grant Sender + Reader (no Editor, no Deleter)
			await admin.client.groups.grantPermissions({
				signer: admin.keypair,
				groupId,
				member: account.address,
				permissionTypes: [messagingPerms.MessagingSender, messagingPerms.MessagingReader],
			});

			await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_TIME));
		}, 30_000);

		it('user with Sender+Reader but no Editor cannot update their own message', async () => {
			const { messageId } = await combinedUser.client.messaging.sendMessage({
				signer: combinedUser.keypair,
				groupRef: { uuid },
				text: 'Combined user message',
			});

			await expect(
				combinedUser.client.messaging.editMessage({
					signer: combinedUser.keypair,
					groupRef: { uuid },
					messageId,
					text: 'Trying to update without Editor',
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});

		it('user with Sender+Reader but no Deleter cannot delete their own message', async () => {
			const { messageId } = await combinedUser.client.messaging.sendMessage({
				signer: combinedUser.keypair,
				groupRef: { uuid },
				text: 'Combined user message 2',
			});

			await expect(
				combinedUser.client.messaging.deleteMessage({
					signer: combinedUser.keypair,
					groupRef: { uuid },
					messageId,
				}),
			).rejects.toSatisfy((error: RelayerTransportError) => {
				return error instanceof RelayerTransportError && error.status === 403;
			});
		});
	});
});
