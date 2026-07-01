// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { fromHex } from '@socialproof/myso/utils';
import { EncryptedObject } from '@socialproof/mydata';
import {
	DefaultMyDataPolicy,
	buildMessageAad,
	messagingPermissionTypes,
} from '@socialproof/myso-messaging-stack';

import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Full Flows', () => {
	let adminClient: MySoMessagingStackTestClient;
	let adminKeypair: Ed25519Keypair;
	let messagingPackageId: string;
	let faucetUrl: string;

	// Stored so new per-user clients can be created with the same config
	let clientConfig: {
		mysoClientUrl: string;
		packageConfig: ReturnType<typeof inject<'genesisConfig'>>;
	};

	beforeAll(() => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const adminAccount = inject('adminAccount');
		const faucetPort = inject('faucetPort');

		messagingPackageId = genesisConfig.messaging.originalPackageId;
		faucetUrl = `http://localhost:${faucetPort}`;
		adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		clientConfig = { mysoClientUrl, packageConfig: genesisConfig };

		adminClient = createMySoMessagingStackClient({
			url: clientConfig.mysoClientUrl,
			network: 'localnet',
			packageConfig: clientConfig.packageConfig,
			keypair: adminKeypair,
		});
	});

	describe('group creation', () => {
		it('should create a messaging group transaction', () => {
			const tx = adminClient.messaging.tx.createAndShareGroup({
				name: 'Test Group',
				sender: adminKeypair.toMySoAddress(),
			});
			expect(tx).toBeDefined();
			expect(tx.getData).toBeDefined();
		});

		it('should create and share a messaging group on-chain', async () => {
			const uuid = crypto.randomUUID();

			const { digest, effects } = await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			expect(digest).toBeDefined();
			expect(digest).toMatch(/^[A-Za-z0-9+/=]+$/);

			// Verify effects contain created objects
			expect(effects).toBeDefined();
			const createdObjects = effects!.changedObjects.filter((obj) => obj.idOperation === 'Created');
			expect(createdObjects.length).toBeGreaterThanOrEqual(2); // group + encryption history

			// Verify the derived group and encryption history exist on-chain
			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			const createdIds = createdObjects.map((obj) => obj.objectId);
			expect(createdIds).toContain(groupId);
			expect(createdIds).toContain(encryptionHistoryId);
		});

		it('should create and share a group without a MemoryAccount (wallet-only path)', async () => {
			const walletAccount = await createFundedAccount({ faucetUrl });
			const walletClient = createMySoMessagingStackClient({
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				packageConfig: clientConfig.packageConfig,
				keypair: walletAccount.keypair,
			});

			const memoryAccountId = await walletClient.messaging.view.memoryAccountIdForOwner({
				owner: walletAccount.address,
			});
			expect(memoryAccountId).toBeNull();

			const uuid = crypto.randomUUID();
			const { digest } = await walletClient.messaging.createAndShareGroup({
				signer: walletAccount.keypair,
				uuid,
				name: 'Wallet-only Group',
			});

			expect(digest).toBeDefined();
		});

		it('should store a valid EncryptedObject DEK on group creation', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const encryptedKeyBytes = await adminClient.messaging.view.currentEncryptedKey({
				uuid,
			});
			expect(encryptedKeyBytes).toBeInstanceOf(Uint8Array);
			expect(encryptedKeyBytes.length).toBeGreaterThan(0);

			const parsed = EncryptedObject.parse(encryptedKeyBytes);
			expect(parsed.version).toBe(0);
			expect(parsed.packageId).toBe(messagingPackageId);
			expect(parsed.threshold).toBe(2);

			const identity = DefaultMyDataPolicy.decodeIdentity(fromHex(parsed.id));
			const expectedGroupId = adminClient.messaging.derive.groupId({ uuid });
			expect(identity.groupId).toBe(expectedGroupId);
			expect(identity.keyVersion).toBe(0n);
		});
	});

	describe('encryption round-trip', () => {
		it('should round-trip encrypt and decrypt data via EnvelopeEncryption', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			const message = 'End-to-end encryption works.';
			const data = new TextEncoder().encode(message);

			const envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data,
			});

			expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);
			expect(envelope.nonce).toBeInstanceOf(Uint8Array);
			expect(envelope.nonce.length).toBe(12);
			expect(envelope.keyVersion).toBe(0n);
			expect(envelope.ciphertext).not.toEqual(data);

			const decrypted = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope,
			});

			expect(new TextDecoder().decode(decrypted)).toBe(message);
		});

		it('should produce consistent identity bytes across derive, store, and parse', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			const encryptedKeyBytes = await adminClient.messaging.view.currentEncryptedKey({
				uuid,
			});
			const parsed = EncryptedObject.parse(encryptedKeyBytes);
			const identity = DefaultMyDataPolicy.decodeIdentity(fromHex(parsed.id));

			expect(identity.groupId).toBe(groupId);
			expect(identity.keyVersion).toBe(0n);

			// Raw identity bytes: 32 address + 8 u64 LE = 40 bytes
			const identityBytes = fromHex(parsed.id);
			expect(identityBytes.length).toBe(40);

			const addressHex = '0x' + Buffer.from(identityBytes.slice(0, 32)).toString('hex');
			expect(addressHex).toBe(groupId);

			const versionBytes = identityBytes.slice(32, 40);
			expect(Array.from(versionBytes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		});
	});

	describe('access control', () => {
		it('should grant mydata_approve access to creator but deny non-members', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			// Creator should succeed
			const adminDek = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope: await adminClient.messaging.encryption.encrypt({
					groupId,
					encryptionHistoryId,
					keyVersion: 0n,
					data: new TextEncoder().encode('test'),
				}),
			});
			expect(adminDek).toEqual(new TextEncoder().encode('test'));

			// Non-member should be denied
			const outsider = await createFundedAccount({ faucetUrl });
			const outsiderClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: outsider.keypair,
			});

			await expect(
				outsiderClient.messaging.encryption.encrypt({
					groupId,
					encryptionHistoryId,
					keyVersion: 0n,
					data: new TextEncoder().encode('should fail'),
				}),
			).rejects.toThrow(/mydata_approve/);
		});

		it('should allow access after granting MessagingReader permission', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			const member = await createFundedAccount({ faucetUrl });
			const memberKeypair = member.keypair;
			const memberAddress = member.address;
			const memberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: memberKeypair,
			});

			// Before granting: denied
			await expect(
				memberClient.messaging.encryption.encrypt({
					groupId,
					encryptionHistoryId,
					keyVersion: 0n,
					data: new TextEncoder().encode('before grant'),
				}),
			).rejects.toThrow(/mydata_approve/);

			// Grant all messaging permissions
			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: memberAddress,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});

			// Admin encrypts a message
			const envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('hello member'),
			});

			// Member can now decrypt
			const plaintext = await memberClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope,
			});
			expect(new TextDecoder().decode(plaintext)).toBe('hello member');
		});
	});

	describe('key rotation', () => {
		it('should rotate encryption key and decrypt both versions', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			// Encrypt with v0
			const v0Message = 'version zero';
			const v0Envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode(v0Message),
			});
			expect(v0Envelope.keyVersion).toBe(0n);

			// Rotate key -> v1
			await adminClient.messaging.rotateEncryptionKey({
				signer: adminKeypair,
				uuid,
			});

			const currentVersion = await adminClient.messaging.view.getCurrentKeyVersion({
				uuid,
			});
			expect(currentVersion).toBe(1n);

			// Encrypt with v1
			const v1Message = 'version one';
			const v1Envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 1n,
				data: new TextEncoder().encode(v1Message),
			});
			expect(v1Envelope.keyVersion).toBe(1n);

			// Decrypt both versions
			const v0Decrypted = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope: v0Envelope,
			});
			expect(new TextDecoder().decode(v0Decrypted)).toBe(v0Message);

			const v1Decrypted = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope: v1Envelope,
			});
			expect(new TextDecoder().decode(v1Decrypted)).toBe(v1Message);

			// v0 and v1 encrypted DEKs should be distinct
			const v0Key = await adminClient.messaging.view.encryptedKey({
				uuid,
				version: 0,
			});
			const v1Key = await adminClient.messaging.view.encryptedKey({
				uuid,
				version: 1,
			});
			expect(Array.from(v0Key)).not.toEqual(Array.from(v1Key));

			// v1 identity should have keyVersion=1
			const v1Parsed = EncryptedObject.parse(v1Key);
			const v1Identity = DefaultMyDataPolicy.decodeIdentity(fromHex(v1Parsed.id));
			expect(v1Identity.groupId).toBe(groupId);
			expect(v1Identity.keyVersion).toBe(1n);
		});
	});

	describe('leave', () => {
		it('should allow a member to leave a messaging group', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			// Fund a member and add them to the group
			const member = await createFundedAccount({ faucetUrl });
			const memberKeypair = member.keypair;
			const memberAddress = member.address;
			const memberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: memberKeypair,
			});

			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: memberAddress,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});

			expect(await adminClient.groups.view.isMember({ groupId, member: memberAddress })).toBe(true);

			// Member leaves via the messaging leave (GroupLeaver actor)
			await memberClient.messaging.leave({
				signer: memberKeypair,
				groupId,
			});

			expect(await adminClient.groups.view.isMember({ groupId, member: memberAddress })).toBe(
				false,
			);
		});

		it('should reject PermissionsAdmin from using leave (EPermissionsAdminCannotLeave)', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			// PermissionsAdmin holders cannot use leave() — they should use
			// remove_member() for their own address instead.
			await expect(
				adminClient.messaging.leave({
					signer: adminKeypair,
					groupId,
				}),
			).rejects.toThrow();
		});
	});

	describe('AAD encryption round-trip', () => {
		it('should encrypt and decrypt with AAD successfully', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			const senderAddress = adminKeypair.getPublicKey().toMySoAddress();
			const aad = buildMessageAad({ groupId, keyVersion: 0n, senderAddress });

			const message = 'AAD-protected message';
			const data = new TextEncoder().encode(message);

			const envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data,
				aad,
			});

			// Decrypt with same AAD succeeds
			const decrypted = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope,
			});
			expect(new TextDecoder().decode(decrypted)).toBe(message);
		});

		it('should fail to decrypt when AAD mismatches', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			const senderAddress = adminKeypair.getPublicKey().toMySoAddress();
			const correctAad = buildMessageAad({ groupId, keyVersion: 0n, senderAddress });

			const envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('secret'),
				aad: correctAad,
			});

			// Tamper AAD: use a different sender address
			const wrongSender = '0x' + '00'.repeat(31) + 'ff';
			const wrongAad = buildMessageAad({ groupId, keyVersion: 0n, senderAddress: wrongSender });

			await expect(
				adminClient.messaging.encryption.decrypt({
					groupId,
					encryptionHistoryId,
					envelope: { ...envelope, aad: wrongAad },
				}),
			).rejects.toThrow();
		});
	});

	describe('removeMembersAndRotateKey', () => {
		it('should atomically remove a member and rotate key in one transaction', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			// Add a member
			const member = await createFundedAccount({ faucetUrl });
			const memberAddress = member.address;

			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: memberAddress,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});

			expect(await adminClient.groups.view.isMember({ groupId, member: memberAddress })).toBe(true);

			// Atomic remove + rotate
			await adminClient.messaging.removeMembersAndRotateKey({
				signer: adminKeypair,
				groupId,
				encryptionHistoryId,
				members: [memberAddress],
			});

			// Member should be removed
			expect(await adminClient.groups.view.isMember({ groupId, member: memberAddress })).toBe(
				false,
			);

			// Key should have rotated to v1
			const version = await adminClient.messaging.view.getCurrentKeyVersion({ uuid });
			expect(version).toBe(1n);

			// Admin can encrypt with the new key
			const envelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 1n,
				data: new TextEncoder().encode('post-removal'),
			});
			expect(envelope.keyVersion).toBe(1n);
		});

		it('should remove multiple members with a single key rotation', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			// Add two members
			const member1 = await createFundedAccount({ faucetUrl });
			const member2 = await createFundedAccount({ faucetUrl });

			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: member1.address,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});
			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: member2.address,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});

			// Remove both in one PTB
			await adminClient.messaging.removeMembersAndRotateKey({
				signer: adminKeypair,
				groupId,
				encryptionHistoryId,
				members: [member1.address, member2.address],
			});

			// Both removed
			expect(await adminClient.groups.view.isMember({ groupId, member: member1.address })).toBe(
				false,
			);
			expect(await adminClient.groups.view.isMember({ groupId, member: member2.address })).toBe(
				false,
			);

			// Only one rotation (v0 -> v1, not v2)
			const version = await adminClient.messaging.view.getCurrentKeyVersion({ uuid });
			expect(version).toBe(1n);
		});
	});

	describe('member removal', () => {
		it('should remove member via groups extension and deny removed member on current key', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const encryptionHistoryId = adminClient.messaging.derive.encryptionHistoryId({
				uuid,
			});

			// Add a member
			const member = await createFundedAccount({ faucetUrl });
			const memberKeypair = member.keypair;
			const memberAddress = member.address;
			const memberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: memberKeypair,
			});

			await adminClient.groups.grantPermissions({
				signer: adminKeypair,
				groupId,
				member: memberAddress,
				permissionTypes: Object.values(messagingPermissionTypes(messagingPackageId)),
			});

			// Member can access v0
			const preRemovalEnvelope = await memberClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('before removal'),
			});
			expect(preRemovalEnvelope.keyVersion).toBe(0n);

			// Remove member via the groups extension (no automatic key rotation)
			await adminClient.groups.removeMember({
				signer: adminKeypair,
				groupId,
				member: memberAddress,
			});

			// Key version should remain at 0 (no automatic rotation)
			const versionAfter = await adminClient.messaging.view.getCurrentKeyVersion({
				uuid,
			});
			expect(versionAfter).toBe(0n);

			// Removed member should be denied on v0 (mydata_approve checks membership)
			const removedMemberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: memberKeypair,
			});

			await expect(
				removedMemberClient.messaging.encryption.encrypt({
					groupId,
					encryptionHistoryId,
					keyVersion: 0n,
					data: new TextEncoder().encode('should fail'),
				}),
			).rejects.toThrow(/mydata_approve/);

			// Admin should still succeed on v0
			const postRemovalEnvelope = await adminClient.messaging.encryption.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: new TextEncoder().encode('after removal'),
			});

			const decrypted = await adminClient.messaging.encryption.decrypt({
				groupId,
				encryptionHistoryId,
				envelope: postRemovalEnvelope,
			});
			expect(new TextDecoder().decode(decrypted)).toBe('after removal');
		});
	});
});
