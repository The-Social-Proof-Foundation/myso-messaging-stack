// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';

import type { RelayerTransport } from '../relayer/transport.js';
import { ReadStateConflictError, RelayerTransportError } from '../relayer/types.js';
import { decryptReadState, encryptReadState } from './read-state-crypto.js';
import { createEmptyReadState, mergeReadState, type UserReadState } from './types.js';

/** Cached read state read-path freshness window. */
const CACHE_TTL_MS = 30_000;
/** Total write attempts per `updateReadState` call (initial + CAS retries). */
const MAX_PUT_ATTEMPTS = 3;

interface CachedReadState {
	state: UserReadState;
	/** Server-assigned blob version; undefined when no remote blob exists yet. */
	blobVersion: number | undefined;
	fetchedAt: number;
}

/**
 * Client synchronization layer for wallet-scoped messaging state.
 *
 * Owns the encrypted read-state blob (cache + optimistic-concurrency writes)
 * and exact unread counts (one batch call). Cross-device consistency comes
 * from the `read_state.updated` user-feed event — call
 * {@link MessagingSyncManager.invalidateReadState} when one arrives so the
 * next read refetches (the client wires this automatically in
 * `subscribeUserEvents`).
 *
 * Write safety: `updateReadState` uses compare-and-set against the server
 * version and merges + retries on conflict. It never blind-writes over state
 * it has not seen, and it skips the write entirely when the merge is a no-op.
 */
export class MessagingSyncManager {
	readonly #transport: RelayerTransport;
	/** Last-known read state per wallet address. */
	readonly #cache = new Map<string, CachedReadState>();

	constructor(transport: RelayerTransport) {
		this.#transport = transport;
	}

	/** Fetch and decrypt the read-state blob, refreshing the cache. */
	async getReadState(signer: Signer): Promise<UserReadState> {
		const address = signer.toMySoAddress();
		try {
			const wire = await this.#transport.getUserReadState({ signer });
			const state = await decryptReadState(signer, wire.encryptedBlob);
			this.#cache.set(address, {
				state,
				blobVersion: wire.blobVersion,
				fetchedAt: Date.now(),
			});
			return state;
		} catch (error) {
			if (error instanceof RelayerTransportError && error.status === 404) {
				const state = createEmptyReadState();
				this.#cache.set(address, { state, blobVersion: undefined, fetchedAt: Date.now() });
				return state;
			}
			throw error;
		}
	}

	/**
	 * Drops the cached read state for a wallet so the next read refetches.
	 * Call when a `read_state.updated` user-feed event arrives with a version
	 * newer than the cache (another device/tab advanced the state).
	 */
	invalidateReadState(address: string, blobVersion?: number): void {
		if (blobVersion !== undefined) {
			const cached = this.#cache.get(address);
			if (cached?.blobVersion !== undefined && cached.blobVersion >= blobVersion) {
				return; // Our own write (or newer) — nothing to invalidate.
			}
		}
		this.#cache.delete(address);
	}

	/**
	 * Advance a group's read watermark with compare-and-set semantics.
	 *
	 * Uses the cached state + version as the CAS base (no extra GET on the hot
	 * path); on `409 READ_STATE_CONFLICT` merges the server's current blob and
	 * retries (bounded). Skips the network write when the watermark would not
	 * advance. Failures to read remote state abort the update — this method
	 * never overwrites state it has not seen.
	 */
	async updateReadState(options: {
		signer: Signer;
		groupId: string;
		readUpto: number;
		/** Extra local watermarks to fold into the write (merged max-wins). */
		localState?: UserReadState;
	}): Promise<UserReadState> {
		const address = options.signer.toMySoAddress();

		let cached = this.#cache.get(address);
		if (!cached) {
			await this.getReadState(options.signer);
			cached = this.#cache.get(address)!;
		}

		// The state we believe the server holds (cache is only ever populated
		// from server reads and accepted writes). CAS keeps stale beliefs safe.
		let serverState = cached.state;
		let expectedVersion = cached.blobVersion;

		for (let attempt = 0; attempt < MAX_PUT_ATTEMPTS; attempt++) {
			const serverUpto = serverState.groups[options.groupId]?.readUpto ?? -1;

			// No-op skip: the server already has the watermark at/past the
			// target, a remote blob exists, and there is nothing extra to fold in.
			if (serverUpto >= options.readUpto && expectedVersion !== undefined && !options.localState) {
				return serverState;
			}

			const base = options.localState
				? mergeReadState(options.localState, serverState)
				: serverState;
			const merged: UserReadState = {
				version: 1,
				updatedAt: Date.now(),
				groups: {
					...base.groups,
					[options.groupId]: {
						readUpto: Math.max(base.groups[options.groupId]?.readUpto ?? 0, options.readUpto),
						muted: base.groups[options.groupId]?.muted,
					},
				},
			};

			const encryptedBlob = await encryptReadState(options.signer, merged);
			try {
				const result = await this.#transport.putUserReadState({
					signer: options.signer,
					encryptedBlob,
					blobVersion: merged.updatedAt,
					expectedVersion,
				});
				this.#cache.set(address, {
					state: merged,
					blobVersion: result.blobVersion,
					fetchedAt: Date.now(),
				});
				return merged;
			} catch (error) {
				if (error instanceof ReadStateConflictError && attempt < MAX_PUT_ATTEMPTS - 1) {
					// Adopt the server's current state and retry against its version.
					serverState = await decryptReadState(options.signer, error.current.encryptedBlob);
					expectedVersion = error.current.blobVersion;
					this.#cache.set(address, {
						state: serverState,
						blobVersion: expectedVersion,
						fetchedAt: Date.now(),
					});
					continue;
				}
				throw error;
			}
		}

		// Unreachable: the loop either returns or throws on the last attempt.
		throw new Error('updateReadState retries exhausted');
	}

	/**
	 * Exact unread counts for the given groups — one batch request.
	 *
	 * Uses the cached read state when fresh (see the `read_state.updated`
	 * invalidation path); groups the relayer omits (not a member yet) come
	 * back as 0.
	 */
	async getUnreadCounts(options: {
		signer: Signer;
		groupIds: string[];
		readState?: UserReadState;
	}): Promise<Record<string, number>> {
		if (options.groupIds.length === 0) {
			return {};
		}

		const readState = options.readState ?? (await this.#getReadStateCached(options.signer));

		const rows = await this.#transport.fetchUnreadCounts({
			signer: options.signer,
			items: options.groupIds.map((groupId) => ({
				groupId,
				afterOrder: readState.groups[groupId]?.readUpto ?? 0,
			})),
		});

		const counts: Record<string, number> = {};
		for (const groupId of options.groupIds) {
			counts[groupId] = 0;
		}
		for (const row of rows) {
			counts[row.groupId] = row.unreadCount;
		}
		return counts;
	}

	/**
	 * Unread counts and latest message order per group — one batch relayer request.
	 */
	async getGroupActivitySummary(options: {
		signer: Signer;
		groupIds: string[];
		readState?: UserReadState;
	}): Promise<{
		counts: Record<string, number>;
		latestOrders: Record<string, number>;
	}> {
		if (options.groupIds.length === 0) {
			return { counts: {}, latestOrders: {} };
		}

		const readState = options.readState ?? (await this.#getReadStateCached(options.signer));

		const rows = await this.#transport.fetchUnreadCounts({
			signer: options.signer,
			items: options.groupIds.map((groupId) => ({
				groupId,
				afterOrder: readState.groups[groupId]?.readUpto ?? 0,
			})),
		});

		const counts: Record<string, number> = {};
		const latestOrders: Record<string, number> = {};
		for (const groupId of options.groupIds) {
			counts[groupId] = 0;
			latestOrders[groupId] = 0;
		}
		for (const row of rows) {
			counts[row.groupId] = row.unreadCount;
			latestOrders[row.groupId] = row.latestOrder;
		}
		return { counts, latestOrders };
	}

	async #getReadStateCached(signer: Signer): Promise<UserReadState> {
		const cached = this.#cache.get(signer.toMySoAddress());
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
			return cached.state;
		}
		return this.getReadState(signer);
	}
}
