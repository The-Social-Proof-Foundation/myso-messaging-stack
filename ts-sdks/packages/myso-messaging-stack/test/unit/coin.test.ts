// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { MIST_PER_MYSO, mistToMyso, mysoToMist } from '../../src/coin.js';

describe('MYSO/MIST conversion', () => {
	it('formats whole MYSO amounts without a fraction', () => {
		expect(mistToMyso(0n)).toBe('0');
		expect(mistToMyso(MIST_PER_MYSO)).toBe('1');
		expect(mistToMyso(10n * MIST_PER_MYSO)).toBe('10');
	});

	it('formats fractional amounts and trims trailing zeros', () => {
		expect(mistToMyso(10_500_000_000n)).toBe('10.5');
		expect(mistToMyso(500_000_000n)).toBe('0.5');
		expect(mistToMyso(1n)).toBe('0.000000001');
		expect(mistToMyso(1_000n)).toBe('0.000001');
	});

	it('parses whole and decimal MYSO input into MIST', () => {
		expect(mysoToMist('10')).toBe(10_000_000_000n);
		expect(mysoToMist('0.5')).toBe(500_000_000n);
		expect(mysoToMist('.5')).toBe(500_000_000n);
		expect(mysoToMist('10.')).toBe(10_000_000_000n);
		expect(mysoToMist('0.000000001')).toBe(1n);
		expect(mysoToMist(' 2 ')).toBe(2_000_000_000n);
	});

	it('round-trips through both helpers', () => {
		for (const mist of [0n, 1n, 999_999_999n, MIST_PER_MYSO, 10_500_000_000n]) {
			expect(mysoToMist(mistToMyso(mist))).toBe(mist);
		}
	});

	it('rejects invalid input', () => {
		expect(() => mysoToMist('')).toThrow();
		expect(() => mysoToMist('abc')).toThrow();
		expect(() => mysoToMist('-1')).toThrow();
		expect(() => mysoToMist('1.0000000001')).toThrow();
		expect(() => mistToMyso(-1n)).toThrow();
	});
});
