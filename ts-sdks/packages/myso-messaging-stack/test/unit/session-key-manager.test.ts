// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { SessionKey } from '@socialproof/mydata';
import type { MyDataCompatibleClient } from '@socialproof/mydata';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionKeyManager } from '../../src/encryption/session-key-manager.js';

/** Minimal mock client for SessionKey.import() — no network calls needed. */
const mockMyDataClient = {} as MyDataCompatibleClient;

const MOCK_PACKAGE_ID = '0x' + '00'.repeat(32);
const mockMySoClient = {} as ClientWithCoreApi;

/** Create a real SessionKey via import() with the given TTL. */
function createSessionKey(opts: { ttlMin?: number } = {}): SessionKey {
	const keypair = Ed25519Keypair.generate();
	return SessionKey.import(
		{
			address: keypair.getPublicKey().toMySoAddress(),
			packageId: MOCK_PACKAGE_ID,
			creationTimeMs: Date.now(),
			ttlMin: opts.ttlMin ?? 30,
			sessionKey: keypair.getSecretKey(),
		},
		mockMyDataClient,
	);
}

/**
 * Build a SessionKeyManager using Tier 3 (getSessionKey callback).
 * This lets us control exactly which key is returned without mocking SessionKey.create().
 */
function createManager(getSessionKey: () => Promise<SessionKey> | SessionKey) {
	return new SessionKeyManager({
		sessionKeyConfig: { getSessionKey },
		packageId: MOCK_PACKAGE_ID,
		mysoClient: mockMySoClient,
	});
}

describe('SessionKeyManager', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should lazily create a key on first getSessionKey call', async () => {
		const key = createSessionKey({ ttlMin: 30 });
		let callCount = 0;

		const mgr = createManager(async () => {
			callCount++;
			return key;
		});

		const result = await mgr.getSessionKey();
		expect(result).toBe(key);
		expect(callCount).toBe(1);
	});

	it('should return cached key when not expired', async () => {
		const key = createSessionKey({ ttlMin: 30 });
		let callCount = 0;

		const mgr = createManager(async () => {
			callCount++;
			return key;
		});

		await mgr.getSessionKey();
		const result = await mgr.getSessionKey();

		expect(result).toBe(key);
		expect(callCount).toBe(1); // Only created once
	});

	it('should refresh when key expires', async () => {
		const oldKey = createSessionKey({ ttlMin: 1 });
		const newKey = createSessionKey({ ttlMin: 30 });

		let callCount = 0;
		const mgr = createManager(async () => {
			callCount++;
			return callCount === 1 ? oldKey : newKey;
		});

		// First call creates oldKey
		const first = await mgr.getSessionKey();
		expect(first).toBe(oldKey);

		// Advance past TTL
		vi.advanceTimersByTime(2 * 60_000);

		// Second call refreshes to newKey
		const second = await mgr.getSessionKey();
		expect(second).toBe(newKey);
		expect(callCount).toBe(2);
	});

	it('should refresh when within buffer window', async () => {
		// 1-minute TTL with default 60s buffer → stale immediately after first use
		const key1 = createSessionKey({ ttlMin: 1 });
		const key2 = createSessionKey({ ttlMin: 30 });

		let callCount = 0;
		const mgr = createManager(async () => {
			callCount++;
			return callCount === 1 ? key1 : key2;
		});

		// First call: creates key1 (lazy, no cached key yet)
		await mgr.getSessionKey();

		// Second call: key1 is within buffer → refreshes
		const result = await mgr.getSessionKey();
		expect(result).toBe(key2);
		expect(callCount).toBe(2);
	});

	it('should coalesce concurrent refresh calls', async () => {
		const key = createSessionKey({ ttlMin: 30 });
		let callCount = 0;

		const mgr = createManager(async () => {
			callCount++;
			return key;
		});

		// All three call simultaneously — only one getSessionKey invocation
		const [r1, r2, r3] = await Promise.all([
			mgr.getSessionKey(),
			mgr.getSessionKey(),
			mgr.getSessionKey(),
		]);

		expect(callCount).toBe(1);
		expect(r1).toBe(key);
		expect(r2).toBe(key);
		expect(r3).toBe(key);
	});

	it('should propagate errors from getSessionKey callback', async () => {
		const mgr = createManager(async () => {
			throw new Error('wallet disconnected');
		});

		await expect(mgr.getSessionKey()).rejects.toThrow('wallet disconnected');
	});

	it('should recover after a failed refresh attempt', async () => {
		const key = createSessionKey({ ttlMin: 30 });
		let callCount = 0;

		const mgr = createManager(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error('temporary failure');
			}
			return key;
		});

		// First call fails
		await expect(mgr.getSessionKey()).rejects.toThrow('temporary failure');

		// Second call should succeed (no stale cached promise)
		const result = await mgr.getSessionKey();
		expect(result).toBe(key);
		expect(callCount).toBe(2);
	});

	it('should use default refreshBufferMs of 60_000', async () => {
		// Key with 2 minute TTL, default buffer is 1 minute
		const key1 = createSessionKey({ ttlMin: 2 });
		const key2 = createSessionKey({ ttlMin: 30 });

		let callCount = 0;
		const mgr = createManager(async () => {
			callCount++;
			return callCount === 1 ? key1 : key2;
		});

		// First call creates key1
		await mgr.getSessionKey();

		// Advance 50 seconds — outside the 1-minute buffer for a 2-minute key (still has 70s left)
		vi.advanceTimersByTime(50_000);
		const stillFresh = await mgr.getSessionKey();
		expect(stillFresh).toBe(key1);
		expect(callCount).toBe(1);

		// Advance another 20 seconds (total 70s) — now within 1-minute buffer (50s remaining)
		vi.advanceTimersByTime(20_000);
		const refreshed = await mgr.getSessionKey();
		expect(refreshed).toBe(key2);
		expect(callCount).toBe(2);
	});
});
