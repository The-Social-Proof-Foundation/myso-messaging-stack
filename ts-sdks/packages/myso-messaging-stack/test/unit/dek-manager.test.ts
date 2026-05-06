// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { DEKManager, DEK_LENGTH } from '../../src/encryption/dek-manager.js';
import { DefaultMyDataPolicy } from '../../src/encryption/mydata-policy.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';

const MOCK_PACKAGE_ID = '0x' + 'ab'.repeat(32);
const MOCK_VERSION_ID = '0x' + '11'.repeat(32);
const MOCK_GROUP_ID = '0x' + 'cd'.repeat(32);

describe('DEKManager', () => {
	const mydataPolicy = new DefaultMyDataPolicy(MOCK_PACKAGE_ID, MOCK_PACKAGE_ID, MOCK_VERSION_ID);

	describe('generateDEK', () => {
		it('should generate a 32-byte DEK', async () => {
			const manager = new DEKManager({
				mydataClient: createMockMyDataClient(),
				mydataPolicy,
			});

			const result = await manager.generateDEK({ groupId: MOCK_GROUP_ID });

			expect(result.dek.length).toBe(DEK_LENGTH);
			expect(result.encryptedDek.length).toBeGreaterThan(0);
			expect(result.identityBytes.length).toBe(40);
		});

		it('should use provided keyVersion', async () => {
			const manager = new DEKManager({
				mydataClient: createMockMyDataClient(),
				mydataPolicy,
			});

			const result = await manager.generateDEK({ groupId: MOCK_GROUP_ID, keyVersion: 5n });
			const decoded = DefaultMyDataPolicy.decodeIdentity(result.identityBytes);

			expect(decoded.keyVersion).toBe(5n);
		});

		it('should default keyVersion to 0 when not provided', async () => {
			const manager = new DEKManager({
				mydataClient: createMockMyDataClient(),
				mydataPolicy,
			});

			const result = await manager.generateDEK({ groupId: MOCK_GROUP_ID });
			const decoded = DefaultMyDataPolicy.decodeIdentity(result.identityBytes);

			expect(decoded.keyVersion).toBe(0n);
		});
	});

	describe('decryptDEK', () => {
		it('should roundtrip generate + decrypt', async () => {
			const mockMyDataClient = createMockMyDataClient();
			const manager = new DEKManager({
				mydataClient: mockMyDataClient,
				mydataPolicy,
			});

			const { dek, encryptedDek } = await manager.generateDEK({ groupId: MOCK_GROUP_ID });

			// Decrypt should return the original DEK.
			// sessionKey and txBytes are unused by the mock — pass dummy values.
			const decrypted = await manager.decryptDEK({
				encryptedDek,
				sessionKey: {} as any,
				txBytes: new Uint8Array(0),
			});

			expect(Array.from(decrypted)).toEqual(Array.from(dek));
		});
	});

	describe('unhappy paths', () => {
		it('should propagate MyDataClient.encrypt errors', async () => {
			const failingMyDataClient = {
				...createMockMyDataClient(),
				encrypt: async () => {
					throw new Error('MyData encryption failed');
				},
			};
			const manager = new DEKManager({
				mydataClient: failingMyDataClient as any,
				mydataPolicy,
			});

			await expect(manager.generateDEK({ groupId: MOCK_GROUP_ID })).rejects.toThrow(
				'MyData encryption failed',
			);
		});

		it('should propagate MyDataClient.decrypt errors', async () => {
			const mockMyDataClient = createMockMyDataClient();
			const manager = new DEKManager({
				mydataClient: {
					...mockMyDataClient,
					decrypt: async () => {
						throw new Error('MyData decryption failed');
					},
				} as any,
				mydataPolicy,
			});

			const { encryptedDek } = await manager.generateDEK({ groupId: MOCK_GROUP_ID });

			await expect(
				manager.decryptDEK({
					encryptedDek,
					sessionKey: {} as any,
					txBytes: new Uint8Array(0),
				}),
			).rejects.toThrow('MyData decryption failed');
		});
	});
});
