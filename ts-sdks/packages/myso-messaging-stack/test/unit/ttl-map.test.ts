// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TtlMap } from '../../src/encryption/ttl-map.js';

describe('TtlMap', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns a stored value before TTL expires', () => {
		const map = new TtlMap(1000);
		map.set('key', 'value');

		expect(map.get('key')).toBe('value');
		expect(map.has('key')).toBe(true);
	});

	it('returns undefined after TTL expires', () => {
		const map = new TtlMap(1000);
		map.set('key', 'value');

		vi.advanceTimersByTime(1000);

		expect(map.get('key')).toBeUndefined();
		expect(map.has('key')).toBe(false);
	});

	it('evicts only expired entries', () => {
		const map = new TtlMap(1000);
		map.set('early', 'a');

		vi.advanceTimersByTime(500);
		map.set('late', 'b');

		vi.advanceTimersByTime(500);

		// 'early' was set 1000ms ago — expired
		expect(map.has('early')).toBe(false);
		// 'late' was set 500ms ago — still alive
		expect(map.get('late')).toBe('b');
	});

	it('deletes expired entries lazily on get()', () => {
		const map = new TtlMap(1000);
		map.set('key', 'value');

		vi.advanceTimersByTime(1000);
		map.get('key');

		// Entry should be deleted from the underlying Map
		expect(map.size).toBe(0);
	});

	it('refreshes TTL when re-setting the same key', () => {
		const map = new TtlMap(1000);
		map.set('key', 'v1');

		vi.advanceTimersByTime(800);
		map.set('key', 'v2');

		vi.advanceTimersByTime(800);

		// 800ms since last set — still alive
		expect(map.get('key')).toBe('v2');

		vi.advanceTimersByTime(200);

		// 1000ms since last set — expired
		expect(map.has('key')).toBe(false);
	});
});
