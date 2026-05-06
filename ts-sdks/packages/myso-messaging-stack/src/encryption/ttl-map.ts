// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

interface TtlEntry {
	value: unknown;
	expiresAt: number;
}

/**
 * A `Map<string, unknown>`-compatible class that expires entries after a TTL.
 *
 * Designed to be injected into `ClientCache` via its `cache` constructor option,
 * making the cache TTL-aware without modifying `ClientCache` itself.
 *
 * Entries are lazily evicted: stale entries are removed on `get()` / `has()`.
 */
export class TtlMap extends Map<string, unknown> {
	readonly #ttlMs: number;

	constructor(ttlMs: number) {
		super();
		this.#ttlMs = ttlMs;
	}

	override set(key: string, value: unknown): this {
		super.set(key, { value, expiresAt: Date.now() + this.#ttlMs } satisfies TtlEntry);
		return this;
	}

	override get(key: string): unknown {
		const entry = super.get(key) as TtlEntry | undefined;
		if (!entry) return undefined;
		if (Date.now() >= entry.expiresAt) {
			this.delete(key);
			return undefined;
		}
		return entry.value;
	}

	override has(key: string): boolean {
		return this.get(key) !== undefined;
	}
}
