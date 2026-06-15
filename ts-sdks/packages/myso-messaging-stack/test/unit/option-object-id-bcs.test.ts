// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { fromHex, normalizeMySoAddress, toHex } from '@socialproof/myso/utils';

import { MySoMessagingStackClientError } from '../../src/error.js';

/** Mirrors `parseOptionObjectIdBcs` in `view.ts` (Move `Option<object::ID>`). */
function parseOptionObjectIdBcs(bytes: Uint8Array): string | null {
	if (bytes.length < 1) {
		throw new MySoMessagingStackClientError('lookupGroupByHandle: empty return bytes');
	}
	const tag = bytes[0];
	if (tag === 0) return null;
	if (tag !== 1) {
		throw new MySoMessagingStackClientError(`lookupGroupByHandle: unexpected Option tag ${tag}`);
	}
	const idBytes = bytes.subarray(1);
	if (idBytes.length !== 32) {
		throw new MySoMessagingStackClientError(
			`lookupGroupByHandle: expected 32-byte object ID payload, got ${idBytes.length} bytes`,
		);
	}
	return normalizeMySoAddress(toHex(idBytes));
}

describe('Option<object::ID> BCS (lookupGroupByHandle return)', () => {
	it('parses None', () => {
		expect(parseOptionObjectIdBcs(new Uint8Array([0]))).toBeNull();
	});

	it('parses Some(address)', () => {
		const id = '0x' + 'ab'.repeat(32);
		const inner = fromHex(id.slice(2));
		const buf = new Uint8Array(33);
		buf[0] = 1;
		buf.set(inner, 1);
		expect(parseOptionObjectIdBcs(buf)).toBe(normalizeMySoAddress(id));
	});

	it('rejects bad tag', () => {
		expect(() => parseOptionObjectIdBcs(new Uint8Array([2, 0]))).toThrow(
			MySoMessagingStackClientError,
		);
	});
});
