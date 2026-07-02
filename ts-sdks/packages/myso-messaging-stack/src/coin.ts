// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { MySoMessagingStackClientError } from './error.js';

/**
 * MIST per MYSO (10^9). All on-chain amounts (escrows, paid-messaging
 * `min_cost`, relayer dm-gate values) are denominated in MIST; UIs should
 * display and accept MYSO.
 */
export const MIST_PER_MYSO = 1_000_000_000n;

/**
 * Formats a MIST amount as a human-readable MYSO decimal string.
 * Trailing fractional zeros are trimmed: `10_500_000_000n` → `"10.5"`.
 */
export function mistToMyso(mist: bigint): string {
	if (mist < 0n) {
		throw new MySoMessagingStackClientError(`MIST amount cannot be negative: ${mist}`);
	}
	const whole = mist / MIST_PER_MYSO;
	const frac = mist % MIST_PER_MYSO;
	if (frac === 0n) return whole.toString();
	const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
	return `${whole}.${fracStr}`;
}

/**
 * Parses a human-entered MYSO amount (up to 9 decimal places) into MIST.
 * `"10"` → `10_000_000_000n`, `"0.5"` → `500_000_000n`.
 */
export function mysoToMist(myso: string): bigint {
	const trimmed = myso.trim();
	if (!/^\d+(\.\d*)?$|^\.\d+$/.test(trimmed)) {
		throw new MySoMessagingStackClientError(`Invalid MYSO amount: "${myso}"`);
	}
	const [wholeRaw = '', fracRaw = ''] = trimmed.split('.');
	if (fracRaw.length > 9) {
		throw new MySoMessagingStackClientError(
			`MYSO amounts support at most 9 decimal places (1 MIST): "${myso}"`,
		);
	}
	const whole = BigInt(wholeRaw || '0');
	const frac = BigInt(fracRaw.padEnd(9, '0') || '0');
	return whole * MIST_PER_MYSO + frac;
}
