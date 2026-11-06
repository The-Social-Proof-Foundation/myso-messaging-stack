// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * MLS state for hosted devices (agents acting through the MCP / automation bridge).
 *
 * A hosted device has no local disk it can rely on and may run on any of several instances. Its
 * whole MLS state (keys, group states, readable rows, cursors, meta) lives in one blob on a server
 * behind a **lease**:
 * - exactly one holder at a time; every write needs the live lease and the version it read;
 * - the blob is sealed (AES-256-GCM) with a key derived from the device owner's **own signature**
 *   (`HKDF(sign("myso-mls-state-seal-v1:<owner>:<device>"))`), so the server can't read it. That
 *   needs a deterministic signer (ed25519); it is checked, never assumed;
 * - device-state changes are written through before the session continues. The session persists
 *   after each encryption, before posting, so a crashed holder can never leave a posted message whose
 *   ratchet advance was lost. A takeover from an older state would otherwise reuse AES-GCM nonces.
 *
 * {@link withHostedMlsStore} runs one operation under the lease and releases it.
 */

import { decodeRowsJson, encodeRowsJson, type MlsStateStore, type UnwrappedRow } from './types.js';

const utf8 = new TextEncoder();
const MAGIC = utf8.encode('MHS1');

/** Lease backend (e.g. the memory server's `/api/messaging/mls/*`). */
export interface HostedMlsLeaseBackend {
	/** Take the lease; `null` while another holder has it. */
	acquire(): Promise<{ token: string; version: number; blob: Uint8Array | null } | null>;
	/** Write under the lease at `expectedVersion`; the new version, or `null` if lease/version moved. */
	write(token: string, expectedVersion: number, blob: Uint8Array): Promise<number | null>;
	/** Extend the lease; `false` if it was lost. */
	renew(token: string): Promise<boolean>;
	release(token: string): Promise<void>;
}

export class HostedMlsLeaseLostError extends Error {
	constructor() {
		super('The MLS device lease was lost; another instance took over. Nothing more was done.');
		this.name = 'HostedMlsLeaseLostError';
	}
}

export class HostedMlsBusyError extends Error {
	constructor() {
		super('This MLS device is busy in another request. Retry shortly.');
		this.name = 'HostedMlsBusyError';
	}
}

/** Derive the sealing key from the owner's signature; refuses a non-deterministic signer. */
export async function deriveHostedSealKey(
	sign: (message: Uint8Array) => Promise<Uint8Array>,
	owner: string,
	deviceId: string,
): Promise<CryptoKey> {
	const message = utf8.encode(`myso-mls-state-seal-v1:${owner.toLowerCase()}:${deviceId}`);
	const [a, b] = [await sign(message), await sign(message)];
	if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
		throw new Error('This signer is not deterministic, so it cannot seal hosted MLS state (use an ed25519 key).');
	}
	const ikm = await crypto.subtle.importKey('raw', a as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('myso-mls-hosted-state'), info: message },
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

interface Snapshot {
	v: 1;
	device: { snapshot: Uint8Array; deviceId: string } | null;
	cursors: Record<string, number>;
	rows: Record<string, UnwrappedRow[]>;
	meta: Record<string, string>;
}

/** In-memory {@link MlsStateStore} that serializes to one snapshot and reports writes. */
export class SnapshotMlsStateStore implements MlsStateStore {
	#s: Snapshot = { v: 1, device: null, cursors: {}, rows: {}, meta: {} };
	readonly #maxRowsPerGroup: number;
	/** Called after every write; `critical` for device state (must reach storage before continuing). */
	onWrite: (critical: boolean) => Promise<void> = async () => {};

	constructor(options: { maxRowsPerGroup?: number } = {}) {
		this.#maxRowsPerGroup = options.maxRowsPerGroup ?? 500;
	}

	toBytes(): Uint8Array {
		return encodeRowsJson(this.#s);
	}

	static fromBytes(bytes: Uint8Array, options: { maxRowsPerGroup?: number } = {}): SnapshotMlsStateStore {
		const store = new SnapshotMlsStateStore(options);
		const s = decodeRowsJson<Snapshot>(bytes);
		if (s?.v !== 1) throw new Error('unknown hosted MLS state format');
		store.#s = { v: 1, device: s.device ?? null, cursors: s.cursors ?? {}, rows: s.rows ?? {}, meta: s.meta ?? {} };
		return store;
	}

	async loadDevice() {
		return this.#s.device;
	}
	async saveDevice(state: { snapshot: Uint8Array; deviceId: string }) {
		this.#s.device = state;
		await this.onWrite(true);
	}
	async getCursor(groupId: string) {
		return this.#s.cursors[groupId] ?? 0;
	}
	async setCursor(groupId: string, order: number) {
		this.#s.cursors[groupId] = order;
		await this.onWrite(false);
	}
	async putRows(groupId: string, rows: UnwrappedRow[]) {
		const byKey = new Map((this.#s.rows[groupId] ?? []).map((r) => [`${r.order}:${r.messageId}`, r]));
		for (const r of rows) byKey.set(`${r.order}:${r.messageId}`, r);
		// Bounded: a hosted device keeps the newest rows per group (older ones age out).
		this.#s.rows[groupId] = [...byKey.values()].sort((a, b) => a.order - b.order).slice(-this.#maxRowsPerGroup);
		await this.onWrite(false);
	}
	async listRows(groupId: string, options: { before?: number; limit: number }) {
		const all = (this.#s.rows[groupId] ?? []).filter((r) => options.before === undefined || r.order < options.before);
		return all.slice(Math.max(0, all.length - options.limit));
	}
	async hasRows(groupId: string, rows: { order: number; messageId: string }[]) {
		const have = new Set((this.#s.rows[groupId] ?? []).map((r) => `${r.order}:${r.messageId}`));
		return new Set(rows.map((r) => `${r.order}:${r.messageId}`).filter((k) => have.has(k)));
	}
	async groupIds() {
		return Object.keys(this.#s.rows);
	}
	async getMeta(key: string) {
		return this.#s.meta[key] ?? null;
	}
	async setMeta(key: string, value: string | null) {
		if (value === null) delete this.#s.meta[key];
		else this.#s.meta[key] = value;
		await this.onWrite(false);
	}
	async clear() {
		this.#s = { v: 1, device: null, cursors: {}, rows: {}, meta: {} };
		await this.onWrite(true);
	}
}

async function seal(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, plain: Uint8Array): Promise<Uint8Array> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plain as Uint8Array<ArrayBuffer>));
	const out = new Uint8Array(4 + 12 + ct.length);
	out.set(MAGIC, 0);
	out.set(nonce, 4);
	out.set(ct, 16);
	return out;
}

async function open(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, blob: Uint8Array): Promise<Uint8Array> {
	if (blob.length < 16 + 16 || MAGIC.some((b, i) => blob[i] !== b)) throw new Error('hosted MLS state: unknown format');
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(4, 16), additionalData: aad }, key, blob.slice(16)));
}

/**
 * Run `fn` with this hosted device's store, under the lease: acquire (retrying while busy), open
 * the sealed blob, write through as the session persists, flush at the end, release. If the lease
 * is lost mid-way, every further write throws {@link HostedMlsLeaseLostError}.
 */
export async function withHostedMlsStore<T>(
	options: {
		backend: HostedMlsLeaseBackend;
		sealKey: CryptoKey;
		owner: string;
		deviceId: string;
		maxRowsPerGroup?: number;
		/** How long to wait for a busy lease (default 15 s). */
		waitMs?: number;
		renewEveryMs?: number;
	},
	fn: (store: SnapshotMlsStateStore) => Promise<T>,
): Promise<T> {
	const aad = utf8.encode(`myso-mls-hosted-state-v1:${options.owner.toLowerCase()}:${options.deviceId}`);
	const deadline = Date.now() + (options.waitMs ?? 15_000);
	let lease = await options.backend.acquire();
	for (let attempt = 0; !lease; attempt++) {
		if (Date.now() >= deadline) throw new HostedMlsBusyError();
		await new Promise((r) => setTimeout(r, Math.min(2_000, 200 * 2 ** attempt)));
		lease = await options.backend.acquire();
	}
	const { token } = lease;
	let version = lease.version;
	let lost = false;
	const store = lease.blob
		? SnapshotMlsStateStore.fromBytes(await open(options.sealKey, aad, lease.blob), { maxRowsPerGroup: options.maxRowsPerGroup })
		: new SnapshotMlsStateStore({ maxRowsPerGroup: options.maxRowsPerGroup });
	let dirty = false;
	let flushing: Promise<void> = Promise.resolve();
	const flush = () => {
		flushing = flushing.then(async () => {
			if (lost) throw new HostedMlsLeaseLostError();
			if (!dirty) return;
			dirty = false;
			const next = await options.backend.write(token, version, await seal(options.sealKey, aad, store.toBytes()));
			if (next === null) {
				lost = true;
				throw new HostedMlsLeaseLostError();
			}
			version = next;
		});
		return flushing;
	};
	store.onWrite = async (critical) => {
		if (lost) throw new HostedMlsLeaseLostError();
		dirty = true;
		if (critical) await flush();
	};
	const renew = setInterval(() => {
		void options.backend.renew(token).then((ok) => {
			if (!ok) lost = true;
		}, () => {});
	}, options.renewEveryMs ?? 20_000);
	try {
		const result = await fn(store);
		await flush();
		return result;
	} finally {
		clearInterval(renew);
		await flushing.catch(() => {});
		if (!lost) await options.backend.release(token).catch(() => {});
	}
}

/** Stable hosted device id for an owner (one per agent per hosting service). */
export function hostedDeviceId(prefix: string, owner: string): string {
	return `${prefix}-${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}
