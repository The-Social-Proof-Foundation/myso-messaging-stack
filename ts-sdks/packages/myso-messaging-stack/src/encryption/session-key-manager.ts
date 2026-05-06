// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { SessionKey } from '@socialproof/mydata';
import { SessionKey as SessionKeyClass } from '@socialproof/mydata';
import type { ClientWithCoreApi } from '@socialproof/myso/client';

import type { SessionKeyConfig } from '../types.js';

/** Default session key TTL in minutes. */
export const DEFAULT_SESSION_KEY_TTL_MIN = 10;

export interface SessionKeyManagerConfig {
	/** Configuration for how session keys are obtained (tier 1/2/3). */
	sessionKeyConfig: SessionKeyConfig;
	/** Move package ID — needed for Tier 1/2 to call SessionKey.create(). */
	packageId: string;
	/** MySo client — needed for Tier 1/2 to call SessionKey.create(). */
	mysoClient: ClientWithCoreApi;
}

/**
 * Owns the complete session key lifecycle: creation, signing ceremony,
 * caching, expiry checks, and concurrent-call coalescing.
 *
 * Accepts a {@link SessionKeyConfig} and handles all three tiers internally.
 * Consumers call {@link getSessionKey} and never think about tiers.
 */
export class SessionKeyManager {
	readonly #config: SessionKeyManagerConfig;
	readonly #refreshBufferMs: number;

	#sessionKey: SessionKey | null = null;
	#refreshPromise: Promise<SessionKey> | null = null;

	constructor(config: SessionKeyManagerConfig) {
		this.#config = config;
		this.#refreshBufferMs = this.#resolveRefreshBuffer();
	}

	/** The configured session key TTL in milliseconds. */
	get ttlMs(): number {
		const skConfig = this.#config.sessionKeyConfig;
		const ttlMin =
			'ttlMin' in skConfig
				? (skConfig.ttlMin ?? DEFAULT_SESSION_KEY_TTL_MIN)
				: DEFAULT_SESSION_KEY_TTL_MIN;
		return ttlMin * 60_000;
	}

	/** Returns a valid, non-expired session key — creating or refreshing as needed. */
	async getSessionKey(): Promise<SessionKey> {
		if (this.#sessionKey && !this.#needsRefresh()) {
			return this.#sessionKey;
		}

		// Coalesce concurrent callers into a single creation
		if (this.#refreshPromise) return this.#refreshPromise;

		this.#refreshPromise = this.#create();
		try {
			this.#sessionKey = await this.#refreshPromise;
			return this.#sessionKey;
		} finally {
			this.#refreshPromise = null;
		}
	}

	// ── Private ─────────────────────────────────────────────────────────

	#resolveRefreshBuffer(): number {
		const skConfig = this.#config.sessionKeyConfig;
		if ('refreshBufferMs' in skConfig && skConfig.refreshBufferMs !== undefined) {
			return skConfig.refreshBufferMs;
		}
		return 60_000;
	}

	#needsRefresh(): boolean {
		if (!this.#sessionKey) return true;
		if (this.#sessionKey.isExpired()) return true;

		const exported = this.#sessionKey.export();
		const expiresAt = exported.creationTimeMs + exported.ttlMin * 60_000;
		return Date.now() + this.#refreshBufferMs >= expiresAt;
	}

	async #create(): Promise<SessionKey> {
		const skConfig = this.#config.sessionKeyConfig;

		// Tier 3: consumer manages everything
		if ('getSessionKey' in skConfig) {
			const result = skConfig.getSessionKey();
			return result instanceof Promise ? await result : result;
		}

		// Tier 1: Signer-based — fully automatic
		if ('signer' in skConfig) {
			const sessionKey = await SessionKeyClass.create({
				address: skConfig.signer.toMySoAddress(),
				packageId: this.#config.packageId,
				mvrName: skConfig.mvrName,
				ttlMin: skConfig.ttlMin ?? DEFAULT_SESSION_KEY_TTL_MIN,
				signer: skConfig.signer,
				mysoClient: this.#config.mysoClient,
			});
			await sessionKey.getCertificate();
			return sessionKey;
		}

		// Tier 2: Callback-based — SDK creates, consumer signs
		const sessionKey = await SessionKeyClass.create({
			address: skConfig.address,
			packageId: this.#config.packageId,
			mvrName: skConfig.mvrName,
			ttlMin: skConfig.ttlMin ?? DEFAULT_SESSION_KEY_TTL_MIN,
			mysoClient: this.#config.mysoClient,
		});
		const message = sessionKey.getPersonalMessage();
		const signature = await skConfig.onSign(message);
		await sessionKey.setPersonalMessageSignature(signature);
		return sessionKey;
	}
}
