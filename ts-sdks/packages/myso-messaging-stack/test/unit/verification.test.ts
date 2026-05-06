// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { toHex } from '@socialproof/myso/utils';
import { describe, expect, it } from 'vitest';

import {
	buildCanonicalMessage,
	signMessageContent,
	verifyMessageSender,
} from '../../src/verification.js';

const MOCK_GROUP_ID = '0x' + 'ab'.repeat(32);

function makeMessageParams() {
	return {
		groupId: MOCK_GROUP_ID,
		encryptedText: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
		nonce: new Uint8Array(12).fill(0x42),
		keyVersion: 3n,
	};
}

describe('buildCanonicalMessage', () => {
	it('produces deterministic output for the same inputs', () => {
		const params = makeMessageParams();
		const a = buildCanonicalMessage(params);
		const b = buildCanonicalMessage(params);
		expect(a).toEqual(b);
	});

	it('produces the expected format: groupId:hex(encryptedText):hex(nonce):keyVersion', () => {
		const params = makeMessageParams();
		const bytes = buildCanonicalMessage(params);
		const str = new TextDecoder().decode(bytes);

		expect(str).toBe(
			`${MOCK_GROUP_ID}:${toHex(params.encryptedText)}:${toHex(params.nonce)}:${params.keyVersion}`,
		);
	});

	it('changes output when any field differs', () => {
		const base = makeMessageParams();
		const baseBytes = buildCanonicalMessage(base);

		// Different groupId
		const diffGroup = buildCanonicalMessage({
			...base,
			groupId: '0x' + 'cd'.repeat(32),
		});
		expect(diffGroup).not.toEqual(baseBytes);

		// Different encryptedText
		const diffText = buildCanonicalMessage({
			...base,
			encryptedText: new Uint8Array([0xde, 0xad]),
		});
		expect(diffText).not.toEqual(baseBytes);

		// Different nonce
		const diffNonce = buildCanonicalMessage({
			...base,
			nonce: new Uint8Array(12).fill(0x99),
		});
		expect(diffNonce).not.toEqual(baseBytes);

		// Different keyVersion
		const diffVersion = buildCanonicalMessage({ ...base, keyVersion: 99n });
		expect(diffVersion).not.toEqual(baseBytes);
	});
});

describe('signMessageContent', () => {
	it('returns a 64-byte hex-encoded signature', async () => {
		const keypair = Ed25519Keypair.generate();
		const sig = await signMessageContent(keypair, makeMessageParams());

		// 64 bytes = 128 hex chars
		expect(sig).toHaveLength(128);
		// Should be valid hex
		expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
	});

	it('produces different signatures for different messages', async () => {
		const keypair = Ed25519Keypair.generate();
		const sig1 = await signMessageContent(keypair, makeMessageParams());
		const sig2 = await signMessageContent(keypair, {
			...makeMessageParams(),
			keyVersion: 999n,
		});

		expect(sig1).not.toBe(sig2);
	});
});

describe('verifyMessageSender', () => {
	it('returns true for a valid sign-then-verify roundtrip', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		const signature = await signMessageContent(keypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey,
		});

		expect(result).toBe(true);
	});

	it('returns false when encryptedText is tampered', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		const signature = await signMessageContent(keypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			encryptedText: new Uint8Array([0xde, 0xad]), // tampered
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false when nonce is tampered', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		const signature = await signMessageContent(keypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			nonce: new Uint8Array(12).fill(0xff), // tampered
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false when keyVersion is tampered', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		const signature = await signMessageContent(keypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			keyVersion: 999n, // tampered
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false when senderAddress does not match the signer', async () => {
		const keypair = Ed25519Keypair.generate();
		const otherKeypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		const signature = await signMessageContent(keypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			senderAddress: otherKeypair.toMySoAddress(), // wrong sender
			signature,
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false when signature is from a different keypair', async () => {
		const keypair = Ed25519Keypair.generate();
		const otherKeypair = Ed25519Keypair.generate();
		const params = makeMessageParams();

		// Sign with otherKeypair but present keypair's publicKey
		const signature = await signMessageContent(otherKeypair, params);
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false for garbage signature hex', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();
		const publicKey = toHex(keypair.getPublicKey().toMySoBytes());

		const result = await verifyMessageSender({
			...params,
			senderAddress: keypair.toMySoAddress(),
			signature: '00'.repeat(64),
			publicKey,
		});

		expect(result).toBe(false);
	});

	it('returns false for invalid publicKey hex', async () => {
		const keypair = Ed25519Keypair.generate();
		const params = makeMessageParams();
		const signature = await signMessageContent(keypair, params);

		const result = await verifyMessageSender({
			...params,
			senderAddress: keypair.toMySoAddress(),
			signature,
			publicKey: 'not-valid-hex',
		});

		expect(result).toBe(false);
	});
});
