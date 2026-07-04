// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { SessionKey } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import { ClientCache, type ClientWithCoreApi } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import type { MySoMessagingStackView } from '../../src/view.js';
import { MySoMessagingStackDerive } from '../../src/derive.js';
import { EnvelopeEncryption, buildMessageAad } from '../../src/encryption/envelope-encryption.js';
import { createMockMyDataClient } from './helpers/mock-mydata-client.js';
import {
	MOCK_PACKAGE_CONFIG,
	MOCK_PACKAGE_ID,
	MOCK_VERSION_ID,
} from './helpers/mock-package-config.js';

const MOCK_GROUP_ID = '0x' + 'ab'.repeat(32);
const MOCK_SENDER = '0x' + 'cd'.repeat(32);

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

function createEnvelopeEncryption(currentKeyVersion = 0n) {
	const sessionKey = createTestSessionKey();
	const derive = new MySoMessagingStackDerive({
		packageConfig: MOCK_PACKAGE_CONFIG,
	});
	return new EnvelopeEncryption({
		mydataClient: createMockMyDataClient(),
		mysoClient: { cache: new ClientCache() } as unknown as ClientWithCoreApi,
		view: {
			getCurrentKeyVersion: async () => currentKeyVersion,
		} as unknown as MySoMessagingStackView,
		derive,
		originalPackageId: MOCK_PACKAGE_ID,
		latestPackageId: MOCK_PACKAGE_ID,
		versionId: MOCK_VERSION_ID,
		encryption: {
			sessionKey: { getSessionKey: () => sessionKey },
		},
	});
}

describe('buildMessageAad', () => {
	it('produces deterministic output for the same inputs', () => {
		const a = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		const b = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		expect(a).toEqual(b);
	});

	it('produces exactly 72 bytes (32 + 8 + 32)', () => {
		const aad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		expect(aad.byteLength).toBe(72);
	});

	it('changes output when groupId differs', () => {
		const a = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		const b = buildMessageAad({
			groupId: '0x' + 'ff'.repeat(32),
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		expect(a).not.toEqual(b);
	});

	it('changes output when keyVersion differs', () => {
		const a = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		const b = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 1n,
			senderAddress: MOCK_SENDER,
		});
		expect(a).not.toEqual(b);
	});

	it('changes output when senderAddress differs', () => {
		const a = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		const b = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: '0x' + 'ff'.repeat(32),
		});
		expect(a).not.toEqual(b);
	});

	it('throws for invalid groupId', () => {
		expect(() =>
			buildMessageAad({ groupId: 'not-an-address', keyVersion: 0n, senderAddress: MOCK_SENDER }),
		).toThrow('Invalid groupId');
	});

	it('throws for invalid senderAddress', () => {
		expect(() =>
			buildMessageAad({ groupId: MOCK_GROUP_ID, keyVersion: 0n, senderAddress: 'not-an-address' }),
		).toThrow('Invalid senderAddress');
	});
});

describe('AAD encrypt/decrypt integration', () => {
	it('roundtrips with matching AAD', async () => {
		const ee = createEnvelopeEncryption();
		const plaintext = new TextEncoder().encode('secret');
		const aad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});

		const { uuid } = await ee.generateGroupDEK();

		const envelope = await ee.encrypt({ uuid, keyVersion: 0n, data: plaintext, aad });
		const decrypted = await ee.decrypt({ uuid, envelope });

		expect(new TextDecoder().decode(decrypted)).toBe('secret');
	});

	it('fails decryption when senderAddress in AAD differs', async () => {
		const ee = createEnvelopeEncryption();
		const plaintext = new TextEncoder().encode('secret');
		const encryptAad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});

		const { uuid } = await ee.generateGroupDEK();
		const envelope = await ee.encrypt({ uuid, keyVersion: 0n, data: plaintext, aad: encryptAad });

		// Tamper: use a different sender address for decryption AAD
		const wrongAad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: '0x' + 'ff'.repeat(32),
		});
		envelope.aad = wrongAad;

		await expect(ee.decrypt({ uuid, envelope })).rejects.toThrow();
	});

	it('fails decryption when groupId in AAD differs', async () => {
		const ee = createEnvelopeEncryption();
		const plaintext = new TextEncoder().encode('secret');
		const encryptAad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});

		const { uuid } = await ee.generateGroupDEK();
		const envelope = await ee.encrypt({ uuid, keyVersion: 0n, data: plaintext, aad: encryptAad });

		// Tamper: use a different group ID for decryption AAD
		const wrongAad = buildMessageAad({
			groupId: '0x' + 'ff'.repeat(32),
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});
		envelope.aad = wrongAad;

		await expect(ee.decrypt({ uuid, envelope })).rejects.toThrow();
	});

	it('fails decryption when keyVersion in AAD differs', async () => {
		const ee = createEnvelopeEncryption();
		const plaintext = new TextEncoder().encode('secret');
		const encryptAad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 0n,
			senderAddress: MOCK_SENDER,
		});

		const { uuid } = await ee.generateGroupDEK();
		const envelope = await ee.encrypt({ uuid, keyVersion: 0n, data: plaintext, aad: encryptAad });

		// Tamper: use a different key version for decryption AAD
		const wrongAad = buildMessageAad({
			groupId: MOCK_GROUP_ID,
			keyVersion: 999n,
			senderAddress: MOCK_SENDER,
		});
		envelope.aad = wrongAad;

		await expect(ee.decrypt({ uuid, envelope })).rejects.toThrow();
	});
});
