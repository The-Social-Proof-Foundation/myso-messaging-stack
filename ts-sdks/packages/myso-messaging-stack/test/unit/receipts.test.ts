// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { tickStatus, upsertMemberReceipt } from '../../src/relayer/receipts.js';

describe('tickStatus', () => {
	const self = '0xSELF';
	const peer = '0xPEER';

	it('returns none with no peers', () => {
		expect(tickStatus(5, [{ member: self, deliveredUpto: 99, readUpto: 99 }], self)).toBe(
			'none',
		);
	});

	it('returns delivered when all others delivered but not all read', () => {
		expect(
			tickStatus(
				5,
				[
					{ member: self, deliveredUpto: 0, readUpto: 0 },
					{ member: peer, deliveredUpto: 5, readUpto: 4 },
				],
				self,
			),
		).toBe('delivered');
	});

	it('returns read when all others have read', () => {
		expect(
			tickStatus(
				5,
				[
					{ member: peer, deliveredUpto: 10, readUpto: 5 },
					{ member: '0xOTHER', deliveredUpto: 5, readUpto: 5 },
				],
				self,
			),
		).toBe('read');
	});

	it('uses min over peers (straggler blocks ticks)', () => {
		expect(
			tickStatus(
				5,
				[
					{ member: peer, deliveredUpto: 10, readUpto: 10 },
					{ member: '0xSLOW', deliveredUpto: 4, readUpto: 4 },
				],
				self,
			),
		).toBe('none');
	});

	it('scopes to peerAddresses so orphan zero rows do not block 1:1 ticks', () => {
		expect(
			tickStatus(
				5,
				[
					{ member: peer, deliveredUpto: 5, readUpto: 0 },
					{ member: '0xORPHAN', deliveredUpto: 0, readUpto: 0 },
				],
				self,
				{ peerAddresses: [peer] },
			),
		).toBe('delivered');
	});
});

describe('upsertMemberReceipt', () => {
	it('max-wins on update and appends new members', () => {
		const base = [{ member: '0xa', deliveredUpto: 3, readUpto: 1 }];
		expect(
			upsertMemberReceipt(base, { member: '0xA', deliveredUpto: 2, readUpto: 5 }),
		).toEqual([{ member: '0xa', deliveredUpto: 3, readUpto: 5 }]);
		expect(
			upsertMemberReceipt(base, { member: '0xb', deliveredUpto: 1, readUpto: 0 }),
		).toEqual([
			{ member: '0xa', deliveredUpto: 3, readUpto: 1 },
			{ member: '0xb', deliveredUpto: 1, readUpto: 0 },
		]);
	});
});
