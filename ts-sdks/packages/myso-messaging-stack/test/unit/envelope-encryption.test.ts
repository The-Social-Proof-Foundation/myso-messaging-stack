// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { SessionKey } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import { ClientCache, type ClientWithCoreApi } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MySoMessagingStackView } from '../../src/view.js';
import { MySoMessagingStackDerive } from '../../src/derive.js';
import { EnvelopeEncryption } from '../../src/encryption/envelope-encryption.js';
import { NONCE_LENGTH } from '../../src/encryption/dek-manager.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';

const MOCK_PACKAGE_ID = '0x' + 'ab'.repeat(32);
const MOCK_NAMESPACE_ID = '0x' + '99'.repeat(32);
const MOCK_VERSION_ID = '0x' + '11'.repeat(32);

const mockMyDataMySoClient = {} as MyDataCompatibleClient;

function createTestSessionKey(): SessionKey {
	const keypair = Ed25519Keypair.generate();
	return SessionKey.import(
		{
			address: keypair.getPublicKey().toMySoAddress(),
			packageId: '0x' + '00'.repeat(32),
			creationTimeMs: Date.now(),
			ttlMin: 30,
			sessionKey: keypair.getSecretKey(),
		},
		mockMyDataMySoClient,
	);
}

function createMockMySoClient(): ClientWithCoreApi {
	return {
		cache: new ClientCache(),
	} as unknown as ClientWithCoreApi;
}

function createMockView(currentKeyVersion = 0n): MySoMessagingStackView {
	return {
		getCurrentKeyVersion: async () => currentKeyVersion,
	} as unknown as MySoMessagingStackView;
}

function createMockDerive(): MySoMessagingStackDerive {
	return new MySoMessagingStackDerive({
		packageConfig: {
			originalPackageId: MOCK_PACKAGE_ID,
			latestPackageId: MOCK_PACKAGE_ID,
			namespaceId: MOCK_NAMESPACE_ID,
			versionId: MOCK_VERSION_ID,
		},
	});
}

function createEnvelopeEncryption(currentKeyVersion = 0n) {
	const sessionKey = createTestSessionKey();
	const derive = createMockDerive();
	return new EnvelopeEncryption({
		mydataClient: createMockMyDataClient(),
		mysoClient: createMockMySoClient(),
		view: createMockView(currentKeyVersion),
		derive,
		originalPackageId: MOCK_PACKAGE_ID,
		latestPackageId: MOCK_PACKAGE_ID,
		versionId: MOCK_VERSION_ID,
		encryption: {
			sessionKey: { getSessionKey: () => sessionKey },
		},
	});
}

describe('EnvelopeEncryption', () => {
	describe('generateGroupDEK', () => {
		it('should generate a UUID and encrypted DEK', async () => {
			const ee = createEnvelopeEncryption();

			const result = await ee.generateGroupDEK();

			expect(result.uuid).toBeDefined();
			expect(typeof result.uuid).toBe('string');
			expect(result.encryptedDek.length).toBeGreaterThan(0);
		});

		it('should use a provided UUID', async () => {
			const ee = createEnvelopeEncryption();
			const uuid = 'my-custom-uuid';

			const result = await ee.generateGroupDEK(uuid);

			expect(result.uuid).toBe(uuid);
			expect(result.encryptedDek.length).toBeGreaterThan(0);
		});
	});

	describe('generateRotationDEK', () => {
		it('should generate a rotation DEK for the next version', async () => {
			const ee = createEnvelopeEncryption(2n);
			const derive = createMockDerive();
			const uuid = 'rotation-test-uuid';
			const groupId = derive.groupId({ uuid });
			const encryptionHistoryId = derive.encryptionHistoryId({ uuid });

			const result = await ee.generateRotationDEK({ groupId, encryptionHistoryId });

			expect(result.encryptedDek.length).toBeGreaterThan(0);
			expect(result.groupId).toBe(groupId);
			expect(result.encryptionHistoryId).toBe(encryptionHistoryId);
		});

		it('should derive IDs from UUID', async () => {
			const ee = createEnvelopeEncryption(0n);
			const derive = createMockDerive();
			const uuid = 'derive-test-uuid';

			const result = await ee.generateRotationDEK({ uuid });

			expect(result.groupId).toBe(derive.groupId({ uuid }));
			expect(result.encryptionHistoryId).toBe(derive.encryptionHistoryId({ uuid }));
		});
	});

	describe('encrypt / decrypt roundtrip', () => {
		it('should roundtrip encrypt and decrypt data (by uuid)', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('hello world');

			// Generate group DEK — this warms the cache at version 0
			const { uuid } = await ee.generateGroupDEK();

			const envelope = await ee.encrypt({
				uuid,
				keyVersion: 0n,
				data: plaintext,
			});

			expect(envelope.ciphertext.length).toBeGreaterThan(plaintext.length);
			expect(envelope.nonce.length).toBe(NONCE_LENGTH);
			expect(envelope.keyVersion).toBe(0n);

			const decrypted = await ee.decrypt({
				uuid,
				envelope,
			});

			expect(new TextDecoder().decode(decrypted)).toBe('hello world');
		});

		it('should roundtrip encrypt and decrypt data (by explicit IDs)', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('hello world');
			const derive = createMockDerive();

			const { uuid } = await ee.generateGroupDEK();
			const groupId = derive.groupId({ uuid });
			const encryptionHistoryId = derive.encryptionHistoryId({ uuid });

			const envelope = await ee.encrypt({
				groupId,
				encryptionHistoryId,
				keyVersion: 0n,
				data: plaintext,
			});

			expect(envelope.keyVersion).toBe(0n);

			const decrypted = await ee.decrypt({
				groupId,
				encryptionHistoryId,
				envelope,
			});

			expect(new TextDecoder().decode(decrypted)).toBe('hello world');
		});

		it('should roundtrip with additional authenticated data', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('secret message');
			const aad = new TextEncoder().encode('metadata');

			const { uuid } = await ee.generateGroupDEK();

			const envelope = await ee.encrypt({
				uuid,
				keyVersion: 0n,
				data: plaintext,
				aad,
			});

			expect(envelope.aad).toEqual(aad);

			const decrypted = await ee.decrypt({
				uuid,
				envelope,
			});

			expect(new TextDecoder().decode(decrypted)).toBe('secret message');
		});

		it('should fail decryption with wrong AAD', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('secret');

			const { uuid } = await ee.generateGroupDEK();

			const envelope = await ee.encrypt({
				uuid,
				keyVersion: 0n,
				data: plaintext,
				aad: new TextEncoder().encode('correct aad'),
			});

			// Tamper with AAD
			envelope.aad = new TextEncoder().encode('wrong aad');

			await expect(
				ee.decrypt({
					uuid,
					envelope,
				}),
			).rejects.toThrow();
		});

		it('should fail decryption with tampered ciphertext', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('secret');

			const { uuid } = await ee.generateGroupDEK();

			const envelope = await ee.encrypt({
				uuid,
				keyVersion: 0n,
				data: plaintext,
			});

			// Tamper with ciphertext
			envelope.ciphertext[0] ^= 0xff;

			await expect(
				ee.decrypt({
					uuid,
					envelope,
				}),
			).rejects.toThrow();
		});

		it('should fail decryption with wrong nonce', async () => {
			const ee = createEnvelopeEncryption();
			const plaintext = new TextEncoder().encode('secret');

			const { uuid } = await ee.generateGroupDEK();

			const envelope = await ee.encrypt({
				uuid,
				keyVersion: 0n,
				data: plaintext,
			});

			// Replace nonce with a different random nonce
			envelope.nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

			await expect(
				ee.decrypt({
					uuid,
					envelope,
				}),
			).rejects.toThrow();
		});
	});

	describe('cache management', () => {
		it('should use cached DEK for subsequent encryptions', async () => {
			const ee = createEnvelopeEncryption();
			const data1 = new TextEncoder().encode('message 1');
			const data2 = new TextEncoder().encode('message 2');

			const { uuid } = await ee.generateGroupDEK();

			const env1 = await ee.encrypt({ uuid, keyVersion: 0n, data: data1 });
			const env2 = await ee.encrypt({ uuid, keyVersion: 0n, data: data2 });

			// Both should decrypt correctly (same DEK)
			const dec1 = await ee.decrypt({ uuid, envelope: env1 });
			const dec2 = await ee.decrypt({ uuid, envelope: env2 });

			expect(new TextDecoder().decode(dec1)).toBe('message 1');
			expect(new TextDecoder().decode(dec2)).toBe('message 2');
		});

		it('should support different key versions for the same group', async () => {
			const ee = createEnvelopeEncryption(0n);
			const data = new TextEncoder().encode('test data');
			const derive = createMockDerive();

			// Generate initial DEK (version 0) via group creation
			const { uuid } = await ee.generateGroupDEK();
			const groupId = derive.groupId({ uuid });
			const encryptionHistoryId = derive.encryptionHistoryId({ uuid });

			// Generate rotation DEK (version 1) — mock view says current is 0, so next is 1
			await ee.generateRotationDEK({ groupId, encryptionHistoryId });

			// Encrypt with version 0
			const env0 = await ee.encrypt({ uuid, keyVersion: 0n, data });

			// Encrypt with version 1
			const env1 = await ee.encrypt({ uuid, keyVersion: 1n, data });

			// Both should decrypt correctly with their respective versions
			const dec0 = await ee.decrypt({ uuid, envelope: env0 });
			const dec1 = await ee.decrypt({ uuid, envelope: env1 });

			expect(new TextDecoder().decode(dec0)).toBe('test data');
			expect(new TextDecoder().decode(dec1)).toBe('test data');

			// Ciphertexts should differ (different DEKs and nonces)
			expect(Array.from(env0.ciphertext)).not.toEqual(Array.from(env1.ciphertext));
		});
	});

	describe('cache TTL', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should serve cached DEK before TTL expires', async () => {
			const view = createMockView();
			const encryptedKeySpy = vi.fn();
			view.encryptedKey = encryptedKeySpy;

			const ee = new EnvelopeEncryption({
				mydataClient: createMockMyDataClient(),
				mysoClient: createMockMySoClient(),
				view,
				derive: createMockDerive(),
				originalPackageId: MOCK_PACKAGE_ID,
				latestPackageId: MOCK_PACKAGE_ID,
				versionId: MOCK_VERSION_ID,
				encryption: {
					sessionKey: { getSessionKey: () => createTestSessionKey() },
				},
			});

			const data = new TextEncoder().encode('hello');
			const { uuid } = await ee.generateGroupDEK();

			// Encrypt immediately — cache is warm from generateGroupDEK
			await ee.encrypt({ uuid, keyVersion: 0n, data });
			expect(encryptedKeySpy).not.toHaveBeenCalled();

			// Advance time but stay within TTL (default 10 min = 600_000ms)
			vi.advanceTimersByTime(300_000);

			await ee.encrypt({ uuid, keyVersion: 0n, data });
			// Still no call to view.encryptedKey — cache hit
			expect(encryptedKeySpy).not.toHaveBeenCalled();
		});

		it('should evict cached DEK after TTL expires and re-fetch', async () => {
			const view = createMockView();
			const encryptedKeySpy = vi.fn();
			view.encryptedKey = encryptedKeySpy;

			const ee = new EnvelopeEncryption({
				mydataClient: createMockMyDataClient(),
				mysoClient: createMockMySoClient(),
				view,
				derive: createMockDerive(),
				originalPackageId: MOCK_PACKAGE_ID,
				latestPackageId: MOCK_PACKAGE_ID,
				versionId: MOCK_VERSION_ID,
				encryption: {
					sessionKey: { getSessionKey: () => createTestSessionKey() },
				},
			});

			const data = new TextEncoder().encode('hello');
			const { uuid } = await ee.generateGroupDEK();

			// Encrypt — cache hit, no view call
			await ee.encrypt({ uuid, keyVersion: 0n, data });
			expect(encryptedKeySpy).not.toHaveBeenCalled();

			// Advance past the TTL (default 10 min for Tier 3)
			vi.advanceTimersByTime(600_001);

			// Next encrypt triggers cache miss → calls view.encryptedKey.
			// The spy will throw (no real return value), proving the cache was evicted.
			await expect(ee.encrypt({ uuid, keyVersion: 0n, data })).rejects.toThrow();
			expect(encryptedKeySpy).toHaveBeenCalledTimes(1);
		});
	});
});
