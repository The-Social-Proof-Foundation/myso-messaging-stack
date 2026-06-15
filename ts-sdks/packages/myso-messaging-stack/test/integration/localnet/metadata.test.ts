// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';

import {
	createMySoMessagingStackClient,
	createFundedAccount,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('metadata', () => {
	let adminClient: MySoMessagingStackTestClient;
	let adminKeypair: Ed25519Keypair;
	let messagingPackageId: string;
	let faucetUrl: string;

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

	describe('setGroupName', () => {
		it('should set the group name (MetadataAdmin)', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Original Name',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			const { digest } = await adminClient.messaging.setGroupName({
				signer: adminKeypair,
				groupId,
				name: 'Updated Name',
			});

			expect(digest).toBeDefined();
			expect(digest).toMatch(/^[A-Za-z0-9+/=]+$/);
		});

		it('should deny setGroupName without MetadataAdmin', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Perm Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			// Fund a member with only MessagingReader
			const member = await createFundedAccount({ faucetUrl });
			const memberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: member.keypair,
			});

			await adminClient.groups.grantPermission({
				signer: adminKeypair,
				groupId,
				member: member.address,
				permissionType: messagingPermissionTypes(messagingPackageId).MessagingReader,
			});

			await expect(
				memberClient.messaging.setGroupName({
					signer: member.keypair,
					groupId,
					name: 'Unauthorized Name',
				}),
			).rejects.toThrow();
		});
	});

	describe('groupsMetadata', () => {
		it('should fetch metadata for a newly created group', async () => {
			const uuid = crypto.randomUUID();
			const name = 'Metadata View Test';

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name,
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });
			const result = await adminClient.messaging.view.groupsMetadata({ groupIds: [groupId] });
			const metadata = result[groupId];

			expect(metadata.name).toBe(name);
			expect(metadata.uuid).toBe(uuid);
			expect(metadata.creator).toBe(adminKeypair.getPublicKey().toMySoAddress());
		});

		it('should return cached value until refresh is used', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Before',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			// Populate the cache with 'Before'
			const initialResult = await adminClient.messaging.view.groupsMetadata({
				groupIds: [groupId],
			});
			expect(initialResult[groupId].name).toBe('Before');

			// Mutate on-chain
			await adminClient.messaging.setGroupName({
				signer: adminKeypair,
				groupId,
				name: 'After',
			});

			// Cached value should still be 'Before'
			const cachedResult = await adminClient.messaging.view.groupsMetadata({ groupIds: [groupId] });
			expect(cachedResult[groupId].name).toBe('Before');

			// Refresh should return 'After'
			const refreshedResult = await adminClient.messaging.view.groupsMetadata({
				groupIds: [groupId],
				refresh: true,
			});
			expect(refreshedResult[groupId].name).toBe('After');
		});
	});

	describe('insertGroupData / removeGroupData', () => {
		it('should insert and remove key-value data (MetadataAdmin)', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Data Test Group',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			// Insert a key-value pair
			const { digest: insertDigest } = await adminClient.messaging.insertGroupData({
				signer: adminKeypair,
				groupId,
				key: 'topic',
				value: 'engineering',
			});
			expect(insertDigest).toBeDefined();

			// Remove the key-value pair
			const { digest: removeDigest } = await adminClient.messaging.removeGroupData({
				signer: adminKeypair,
				groupId,
				key: 'topic',
			});
			expect(removeDigest).toBeDefined();
		});

		it('should deny insertGroupData without MetadataAdmin', async () => {
			const uuid = crypto.randomUUID();

			await adminClient.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Data Perm Test',
			});

			const groupId = adminClient.messaging.derive.groupId({ uuid });

			const member = await createFundedAccount({ faucetUrl });
			const memberClient = createMySoMessagingStackClient({
				...clientConfig,
				url: clientConfig.mysoClientUrl,
				network: 'localnet',
				keypair: member.keypair,
			});

			await adminClient.groups.grantPermission({
				signer: adminKeypair,
				groupId,
				member: member.address,
				permissionType: messagingPermissionTypes(messagingPackageId).MessagingReader,
			});

			await expect(
				memberClient.messaging.insertGroupData({
					signer: member.keypair,
					groupId,
					key: 'topic',
					value: 'unauthorized',
				}),
			).rejects.toThrow();
		});
	});
});
