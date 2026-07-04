// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import type { RelayerTransport } from '../../src/relayer/transport.js';
import type {
	FetchUnreadCountsParams,
	GroupUnreadCount,
	PutUserReadStateParams,
	PutUserReadStateResult,
	UserReadStateWire,
} from '../../src/relayer/types.js';
import { ReadStateConflictError, RelayerTransportError } from '../../src/relayer/types.js';
import { MessagingSyncManager } from '../../src/sync/messaging-sync-manager.js';
import { decryptReadState, encryptReadState } from '../../src/sync/read-state-crypto.js';
import { createEmptyReadState, mergeReadState, type UserReadState } from '../../src/sync/types.js';

const keypair = Ed25519Keypair.generate();

/**
 * In-memory fake of the relayer's read-state + unread-count endpoints with
 * server-assigned versions and CAS semantics — mirrors the Rust behavior.
 */
class FakeReadStateBackend {
	blob: Uint8Array | undefined;
	version = 0;
	putCalls = 0;
	unreadCalls: FetchUnreadCountsParams[] = [];
	unreadResult: GroupUnreadCount[] = [];

	transport(): RelayerTransport {
		const self = this;
		return {
			async getUserReadState(): Promise<UserReadStateWire> {
				if (!self.blob) {
					throw new RelayerTransportError('Read state not found', 404);
				}
				return { encryptedBlob: self.blob, blobVersion: self.version };
			},
			async putUserReadState(params: PutUserReadStateParams): Promise<PutUserReadStateResult> {
				self.putCalls += 1;
				if (
					params.expectedVersion !== undefined &&
					self.version > 0 &&
					params.expectedVersion !== self.version
				) {
					throw new ReadStateConflictError('Read state was modified by another client', {
						encryptedBlob: self.blob!,
						blobVersion: self.version,
					});
				}
				self.blob = params.encryptedBlob;
				self.version += 1;
				return { blobVersion: self.version };
			},
			async fetchUnreadCounts(params: FetchUnreadCountsParams): Promise<GroupUnreadCount[]> {
				self.unreadCalls.push(params);
				return self.unreadResult;
			},
		} as unknown as RelayerTransport;
	}

	/** Simulates another device writing the given state directly. */
	async writeRemote(state: UserReadState): Promise<void> {
		this.blob = await encryptReadState(keypair, state);
		this.version += 1;
	}

	async readRemote(): Promise<UserReadState> {
		return decryptReadState(keypair, this.blob!);
	}
}

describe('read-state crypto', () => {
	it('round-trips a state blob with a wallet-derived key', async () => {
		const state: UserReadState = {
			version: 1,
			updatedAt: 123,
			groups: { '0xg': { readUpto: 7, muted: true } },
		};
		const blob = await encryptReadState(keypair, state);
		expect(await decryptReadState(keypair, blob)).toEqual(state);

		// A different wallet cannot decrypt the blob.
		await expect(decryptReadState(Ed25519Keypair.generate(), blob)).rejects.toThrow();
	});
});

describe('mergeReadState', () => {
	it('takes the max watermark per group and unions groups', () => {
		const local: UserReadState = {
			version: 1,
			updatedAt: 10,
			groups: { a: { readUpto: 5 }, b: { readUpto: 2 } },
		};
		const remote: UserReadState = {
			version: 1,
			updatedAt: 20,
			groups: { a: { readUpto: 3 }, c: { readUpto: 9 } },
		};

		const merged = mergeReadState(local, remote);
		expect(merged.groups).toEqual({
			a: { readUpto: 5, muted: undefined },
			b: { readUpto: 2, muted: undefined },
			c: { readUpto: 9 },
		});
		expect(merged.updatedAt).toBe(20);
	});
});

describe('MessagingSyncManager', () => {
	it('returns empty state on 404 and caches it', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		const state = await manager.getReadState(keypair);
		expect(state.groups).toEqual({});
	});

	it('updateReadState creates, then skips no-op writes', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 5 });
		expect(backend.putCalls).toBe(1);
		expect((await backend.readRemote()).groups['0xg']?.readUpto).toBe(5);

		// Same watermark again: no network write.
		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 5 });
		expect(backend.putCalls).toBe(1);

		// Lower watermark: also a no-op.
		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 3 });
		expect(backend.putCalls).toBe(1);

		// Higher watermark advances.
		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 9 });
		expect(backend.putCalls).toBe(2);
		expect((await backend.readRemote()).groups['0xg']?.readUpto).toBe(9);
	});

	it('merges and retries on CAS conflict without losing either side', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		// Seed our cache at version 1.
		await manager.updateReadState({ signer: keypair, groupId: '0xa', readUpto: 1 });
		expect(backend.version).toBe(1);

		// Another device advances a different group -> version 2; our cache is stale.
		const other = createEmptyReadState();
		other.groups['0xb'] = { readUpto: 7 };
		await backend.writeRemote(mergeReadState(await backend.readRemote(), other));
		expect(backend.version).toBe(2);

		// Our next write conflicts once, merges the remote blob, and retries.
		await manager.updateReadState({ signer: keypair, groupId: '0xa', readUpto: 4 });

		const final = await backend.readRemote();
		expect(final.groups['0xa']?.readUpto).toBe(4);
		expect(final.groups['0xb']?.readUpto).toBe(7);
		expect(backend.version).toBe(3);
	});

	it('invalidateReadState drops the cache only for newer versions', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());
		const address = keypair.toMySoAddress();

		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 5 });
		// Cached at version 1 — an event for our own write must not invalidate.
		manager.invalidateReadState(address, 1);
		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 5 });
		expect(backend.putCalls).toBe(1); // still a no-op via cache

		// A newer remote version invalidates; next update refetches (GET -> 1 put).
		await backend.writeRemote(await backend.readRemote()); // bump to version 2
		manager.invalidateReadState(address, 2);
		await manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 6 });
		expect(backend.putCalls).toBe(2);
		expect(backend.version).toBe(3);
	});

	it('aborts (never blind-writes) when the initial read fails', async () => {
		const failing = {
			getUserReadState: vi
				.fn()
				.mockRejectedValue(new RelayerTransportError('Internal server error', 500)),
			putUserReadState: vi.fn(),
		} as unknown as RelayerTransport;
		const manager = new MessagingSyncManager(failing);

		await expect(
			manager.updateReadState({ signer: keypair, groupId: '0xg', readUpto: 5 }),
		).rejects.toThrow('Internal server error');
		expect(
			(failing as unknown as { putUserReadState: ReturnType<typeof vi.fn> }).putUserReadState,
		).not.toHaveBeenCalled();
	});

	it('getUnreadCounts sends one batch request with cached watermarks', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		await manager.updateReadState({ signer: keypair, groupId: '0xa', readUpto: 10 });
		backend.unreadResult = [
			{ groupId: '0xa', latestOrder: 14, unreadCount: 4 },
			{ groupId: '0xb', latestOrder: 3, unreadCount: 3 },
		];

		const counts = await manager.getUnreadCounts({
			signer: keypair,
			groupIds: ['0xa', '0xb', '0xc'],
		});

		// One batch call carrying per-group watermarks (0 for unknown groups).
		expect(backend.unreadCalls).toHaveLength(1);
		expect(backend.unreadCalls[0]!.items).toEqual([
			{ groupId: '0xa', afterOrder: 10 },
			{ groupId: '0xb', afterOrder: 0 },
			{ groupId: '0xc', afterOrder: 0 },
		]);

		// Groups omitted by the relayer (not a member) default to 0.
		expect(counts).toEqual({ '0xa': 4, '0xb': 3, '0xc': 0 });
	});

	it('getUnreadCounts returns empty for an empty group list without a request', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		expect(await manager.getUnreadCounts({ signer: keypair, groupIds: [] })).toEqual({});
		expect(backend.unreadCalls).toHaveLength(0);
	});

	it('getGroupActivitySummary preserves latestOrder from the batch response', async () => {
		const backend = new FakeReadStateBackend();
		const manager = new MessagingSyncManager(backend.transport());

		backend.unreadResult = [
			{ groupId: '0xa', latestOrder: 42, unreadCount: 2 },
			{ groupId: '0xb', latestOrder: 7, unreadCount: 1 },
		];

		const summary = await manager.getGroupActivitySummary({
			signer: keypair,
			groupIds: ['0xa', '0xb', '0xc'],
		});

		expect(summary.counts).toEqual({ '0xa': 2, '0xb': 1, '0xc': 0 });
		expect(summary.latestOrders).toEqual({ '0xa': 42, '0xb': 7, '0xc': 0 });
		expect(backend.unreadCalls).toHaveLength(1);
	});
});
