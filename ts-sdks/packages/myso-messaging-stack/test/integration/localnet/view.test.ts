// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject, beforeAll } from 'vitest';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { fromHex } from '@socialproof/myso/utils';
import { EncryptedObject } from '@socialproof/mydata';
import { DefaultMyDataPolicy } from '@socialproof/myso-messaging-stack';

import {
	createMySoClient,
	createMySoMessagingStackClient,
	type MySoMessagingStackTestClient,
} from '../../helpers/index.js';

describe('MySoMessagingStackView', () => {
	let client: MySoMessagingStackTestClient;
	let adminKeypair: Ed25519Keypair;

	beforeAll(() => {
		const mysoClientUrl = inject('mysoClientUrl');
		const genesisConfig = inject('genesisConfig');
		const adminAccount = inject('adminAccount');

		adminKeypair = Ed25519Keypair.fromSecretKey(adminAccount.secretKey);

		client = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network: 'localnet',
			packageConfig: genesisConfig,
			keypair: adminKeypair,
		});
	});

	describe('derive', () => {
		it('should derive correct object IDs from UUID', async () => {
			const uuid = crypto.randomUUID();

			const expectedGroupId = client.messaging.derive.groupId({ uuid });
			const expectedEncryptionHistoryId = client.messaging.derive.encryptionHistoryId({
				uuid,
			});

			await client.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			// Verify derived IDs match actual on-chain objects
			const mysoClientUrl = inject('mysoClientUrl');
			const verifyClient = createMySoClient({ url: mysoClientUrl, network: 'localnet' });

			const { object: groupObj } = await verifyClient.core.getObject({
				objectId: expectedGroupId,
			});
			expect(groupObj.objectId).toBe(expectedGroupId);

			const { object: historyObj } = await verifyClient.core.getObject({
				objectId: expectedEncryptionHistoryId,
			});
			expect(historyObj.objectId).toBe(expectedEncryptionHistoryId);
		});
	});

	describe('encryptedKey', () => {
		it('should read back encrypted key via view (by UUID)', async () => {
			const uuid = crypto.randomUUID();

			await client.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const currentKey = await client.messaging.view.currentEncryptedKey({ uuid });
			expect(currentKey).toBeInstanceOf(Uint8Array);
			expect(currentKey.length).toBeGreaterThan(0);

			// Parse as EncryptedObject — valid BCS from mock MyDataClient
			const parsed = EncryptedObject.parse(currentKey);
			expect(parsed.version).toBe(0);
			expect(parsed.threshold).toBe(2);

			// Verify identity bytes encode the correct group ID and key version 0
			const identity = DefaultMyDataPolicy.decodeIdentity(fromHex(parsed.id));
			const expectedGroupId = client.messaging.derive.groupId({ uuid });
			expect(identity.groupId).toBe(expectedGroupId);
			expect(identity.keyVersion).toBe(0n);

			// Also verify encryptedKey with explicit version
			const keyV0 = await client.messaging.view.encryptedKey({ uuid, version: 0 });
			expect(Array.from(keyV0)).toEqual(Array.from(currentKey));
		});

		it('should read back encrypted key via view (by encryptionHistoryId)', async () => {
			const uuid = crypto.randomUUID();

			await client.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Test Group',
			});

			const encryptionHistoryId = client.messaging.derive.encryptionHistoryId({ uuid });

			const currentKey = await client.messaging.view.currentEncryptedKey({
				encryptionHistoryId,
			});
			expect(currentKey).toBeInstanceOf(Uint8Array);

			const parsed = EncryptedObject.parse(currentKey);
			expect(parsed.version).toBe(0);
		});
	});

	describe('lookupGroupByHandle', () => {
		it('returns null for unknown handle', async () => {
			const random = `zzz_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
			const groupId = await client.messaging.view.lookupGroupByHandle({ handle: random });
			expect(groupId).toBeNull();
		});

		it('returns group id after setGroupHandle', async () => {
			const uuid = crypto.randomUUID();
			await client.messaging.createAndShareGroup({
				signer: adminKeypair,
				uuid,
				name: 'Handle lookup test',
			});
			const groupId = client.messaging.derive.groupId({ uuid });
			const handle = `hl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

			await client.messaging.setGroupHandle({
				signer: adminKeypair,
				groupId,
				handle,
			});

			const resolved = await client.messaging.view.lookupGroupByHandle({ handle });
			expect(resolved).toBe(groupId);

			await client.messaging.clearGroupHandle({
				signer: adminKeypair,
				groupId,
			});
			const afterClear = await client.messaging.view.lookupGroupByHandle({ handle });
			expect(afterClear).toBeNull();
		});
	});
});
