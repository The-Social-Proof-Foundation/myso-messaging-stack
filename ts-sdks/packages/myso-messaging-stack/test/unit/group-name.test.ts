// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
	GROUP_NAME_PADDED_BYTES,
	formatEncryptedGroupName,
	groupNameAad,
	padGroupName,
	parseEncryptedGroupName,
	unpadGroupName,
} from '../../src/content/group-name.js';

describe('encrypted group names', () => {
	it('pads every name to the same length and round-trips', () => {
		expect(padGroupName('Book club 📚').length).toBe(GROUP_NAME_PADDED_BYTES);
		expect(unpadGroupName(padGroupName('Book club 📚'))).toBe('Book club 📚');
		expect(() => padGroupName('x'.repeat(GROUP_NAME_PADDED_BYTES + 1))).toThrow();
	});

	it('fits the 128-byte on-chain limit and parses back', () => {
		const nonce = new Uint8Array(12).fill(7);
		const ct = new Uint8Array(GROUP_NAME_PADDED_BYTES + 16).fill(9);
		const name = formatEncryptedGroupName(3n, nonce, ct);
		expect(name.length).toBeLessThanOrEqual(128);
		const parsed = parseEncryptedGroupName(name)!;
		expect(parsed.keyVersion).toBe(3n);
		expect(parsed.nonce).toEqual(nonce);
		expect(parsed.ciphertext).toEqual(ct);
		expect(parseEncryptedGroupName('Plain name')).toBeNull();
		expect(parseEncryptedGroupName('enc:v1:x:abc')).toBeNull();
	});

	it('round-trips through real AES-GCM with the name AAD', async () => {
		const keyBytes = crypto.getRandomValues(new Uint8Array(32));
		const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const aad = groupNameAad('0xAB');
		const ct = new Uint8Array(
			await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad as Uint8Array<ArrayBuffer> }, key, padGroupName('Team') as Uint8Array<ArrayBuffer>),
		);
		const parsed = parseEncryptedGroupName(formatEncryptedGroupName(0n, nonce, ct))!;
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: parsed.nonce as Uint8Array<ArrayBuffer>, additionalData: groupNameAad('0xab') as Uint8Array<ArrayBuffer> },
			key,
			parsed.ciphertext as Uint8Array<ArrayBuffer>,
		);
		expect(unpadGroupName(new Uint8Array(pt))).toBe('Team');
	});
});
