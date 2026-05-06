// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Transaction } from '@socialproof/myso/transactions';
import { describe, expect, it } from 'vitest';

import { DefaultMyDataPolicy } from '../../src/encryption/mydata-policy.js';

const MOCK_PACKAGE_ID = '0x' + 'ab'.repeat(32);
const MOCK_VERSION_ID = '0x' + '11'.repeat(32);
const MOCK_GROUP_ID = '0x' + 'cd'.repeat(32);

describe('DefaultMyDataPolicy', () => {
	describe('encodeIdentity / decodeIdentity', () => {
		it('should produce exactly 40 bytes', () => {
			const bytes = DefaultMyDataPolicy.encodeIdentity(MOCK_GROUP_ID, 0n);
			expect(bytes.length).toBe(40);
		});

		it('should roundtrip identity encode/decode', () => {
			const bytes = DefaultMyDataPolicy.encodeIdentity(MOCK_GROUP_ID, 42n);
			const decoded = DefaultMyDataPolicy.decodeIdentity(bytes);

			expect(decoded.groupId).toBe(MOCK_GROUP_ID);
			expect(decoded.keyVersion).toBe(42n);
		});

		it('should encode keyVersion as little-endian u64', () => {
			const bytes = DefaultMyDataPolicy.encodeIdentity(MOCK_GROUP_ID, 1n);

			// keyVersion is the last 8 bytes
			const keyVersionBytes = bytes.slice(32);
			expect(keyVersionBytes[0]).toBe(1); // LE: least significant byte first
			expect(keyVersionBytes[7]).toBe(0);
		});

		it('should throw on invalid identity bytes length (39 bytes)', () => {
			expect(() => DefaultMyDataPolicy.decodeIdentity(new Uint8Array(39))).toThrow(
				'Invalid identity bytes length',
			);
		});

		it('should throw on invalid identity bytes length (41 bytes)', () => {
			expect(() => DefaultMyDataPolicy.decodeIdentity(new Uint8Array(41))).toThrow(
				'Invalid identity bytes length',
			);
		});

		it('should throw on invalid groupId', () => {
			expect(() => DefaultMyDataPolicy.encodeIdentity('not-a-valid-address', 0n)).toThrow(
				'Invalid groupId',
			);
		});

		it('should throw on empty groupId', () => {
			expect(() => DefaultMyDataPolicy.encodeIdentity('', 0n)).toThrow('Invalid groupId');
		});

		it('should handle max u64 keyVersion', () => {
			const maxU64 = 2n ** 64n - 1n;
			const bytes = DefaultMyDataPolicy.encodeIdentity(MOCK_GROUP_ID, maxU64);
			const decoded = DefaultMyDataPolicy.decodeIdentity(bytes);

			expect(decoded.keyVersion).toBe(maxU64);
		});
	});

	describe('mydataApproveThunk', () => {
		it('should return a Transaction thunk', () => {
			const policy = new DefaultMyDataPolicy(MOCK_PACKAGE_ID, MOCK_PACKAGE_ID, MOCK_VERSION_ID);
			const identityBytes = DefaultMyDataPolicy.encodeIdentity(MOCK_GROUP_ID, 0n);
			const thunk = policy.mydataApproveThunk(identityBytes, MOCK_GROUP_ID, '0x' + 'ee'.repeat(32));

			const tx = new Transaction();
			const result = tx.add(thunk);
			expect(result).toBeDefined();
		});
	});
});
