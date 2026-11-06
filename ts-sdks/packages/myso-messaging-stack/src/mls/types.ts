// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { RelayerMessage } from '../relayer/types.js';

/**
 * Structural type of the `myso-mls` WASM bindings (`mls/src/wasm.rs`). The SDK never bundles the
 * WASM itself: apps load it (`wasm-pack` output) and pass the module in, so web and Node share one
 * code path and the bundle stays opt-in.
 */
export interface MlsWasmModule {
	MlsDeviceKeys: {
		generate(): MlsWasmDeviceKeys;
		fromSecretBytes(bytes: Uint8Array): MlsWasmDeviceKeys;
	};
	MlsDevice: {
		fromKeys(keys: MlsWasmDeviceKeys, identity: Uint8Array): MlsWasmDevice;
		restore(snapshot: Uint8Array): MlsWasmDevice;
	};
	MlsHistoryReassembler: new () => {
		push(plaintext: Uint8Array): { bundleId: string; payload: Uint8Array } | undefined;
	};
	mlsInspect(bytes: Uint8Array): string;
	/** v2 certificate JSON: whether the authority signature verifies (registry check is separate). */
	mlsVerifyCertificateV2(json: string): boolean;
	/** The certificate JSON a KeyPackage carries, when it names the KeyPackage's leaf key. */
	mlsKeyPackageCertificate(keyPackage: Uint8Array): string | undefined;
	mlsCertificateCanonical(wallet: string, deviceId: string, mlsKeyHex: string, issuedAtMs: number): string;
	mlsHistorySplit(bundleId: string, payload: Uint8Array): Uint8Array[];
}

/** JSON codec that survives Uint8Array and bigint (history bundles, sealed stores). */
export function encodeRowsJson(value: unknown): Uint8Array {
	const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return new TextEncoder().encode(
		JSON.stringify(value, (_k, v) =>
			v instanceof Uint8Array ? { $b: hex(v) } : typeof v === 'bigint' ? { $n: v.toString() } : v,
		),
	);
}

export function decodeRowsJson<T>(bytes: Uint8Array): T {
	const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
	return JSON.parse(new TextDecoder().decode(bytes), (_k, v) =>
		v && typeof v === 'object' && '$b' in v
			? unhex(v.$b)
			: v && typeof v === 'object' && '$n' in v
				? BigInt(v.$n)
				: v,
	) as T;
}

export interface MlsWasmDeviceKeys {
	publicKey(): Uint8Array;
	secretBytes(): Uint8Array;
}

export interface MlsWasmDevice {
	snapshot(): Uint8Array;
	identity(): Uint8Array;
	keyPackage(): Uint8Array;
	createGroup(groupId: Uint8Array): MlsWasmGroup;
	join(welcome: Uint8Array): MlsWasmGroup;
	joinExternal(groupInfo: Uint8Array): { commit: Uint8Array; takeGroup(): MlsWasmGroup };
	/** Drop local state for the group and rejoin by external commit (replaces our old leaf). */
	rejoinExternal(groupInfo: Uint8Array): { commit: Uint8Array; takeGroup(): MlsWasmGroup };
	deleteGroup(groupId: Uint8Array): void;
	/** A copy of this device carrying a renewed certificate (swap to it, reload groups). */
	withIdentity(identity: Uint8Array): MlsWasmDevice;
	loadGroup(groupId: Uint8Array): MlsWasmGroup | undefined;
	free?(): void;
}

export interface MlsWasmGroup {
	epoch(): bigint;
	isActive(): boolean;
	membersJson(): string;
	addMembers(device: MlsWasmDevice, keyPackages: Uint8Array[]): { commit: Uint8Array; welcome: Uint8Array };
	removeLeaves(device: MlsWasmDevice, leaves: Uint32Array): Uint8Array;
	selfUpdate(device: MlsWasmDevice): Uint8Array;
	/** Commit the device's current (renewed) credential into the group. */
	updateCredential(device: MlsWasmDevice): Uint8Array;
	groupInfo(device: MlsWasmDevice): Uint8Array;
	leave(device: MlsWasmDevice): Uint8Array;
	commitPending(device: MlsWasmDevice): Uint8Array | undefined;
	encrypt(device: MlsWasmDevice, plaintext: Uint8Array): Uint8Array;
	process(
		device: MlsWasmDevice,
		message: Uint8Array,
	): { kind: string; plaintext?: Uint8Array; senderIdentity?: Uint8Array; epoch?: bigint };
	free?(): void;
}

/**
 * Device certificate (MLS credential identity); see E2EE-Protocol-MLS.md.
 * v1: wallet-signed. v2: signed by the device's on-chain-registered authority key (`authority_key`,
 * `signer_key` = `"authority"`), renewable by the device alone.
 */
export interface MlsDeviceCertificate {
	v: 1 | 2;
	wallet: string;
	device_id: string;
	mls_key: string;
	issued_at_ms: number;
	sig: string;
	signer_key: string;
	/** v2: hex ed25519 authority public key. */
	authority_key?: string;
}

/**
 * Result of checking a certificate's wallet signature.
 * - `valid`: verified (cached permanently for this exact certificate + proof).
 * - `invalid`: provably wrong (bad signature, wrong wallet, malformed). The leaf is removed.
 * - `unknown`: can't be decided now (fullnode unreachable, or a zkLogin proof past its
 *   `max_epoch` that this device never verified). Never removed; sends to the group pause.
 */
export type MlsCertificateStatus = 'valid' | 'invalid' | 'unknown';

export interface MlsMember {
	leafIndex: number;
	identityHex: string;
	signatureKeyHex: string;
	certificate: MlsDeviceCertificate | null;
}

/**
 * A relayer row after MLS unwrapping: `encryptedText` / `nonce` / `keyVersion` are the inner
 * DEK-sealed values, so the normal DEK decrypt path applies. MLS keys are single use, so these rows
 * are the only readable copy and must be persisted.
 */
export interface UnwrappedRow extends RelayerMessage {
	/** Outer row signature verified and the MLS sender's certificate wallet equals `senderAddress`. */
	senderVerified: boolean;
}

/**
 * Durable, device-local MLS state. Web: IndexedDB sealed with a non-extractable key; Node agents:
 * an encrypted file; tests: {@link MemoryMlsStateStore}. Exactly one writer per device.
 */
export interface MlsStateStore {
	loadDevice(): Promise<{ snapshot: Uint8Array; deviceId: string } | null>;
	saveDevice(state: { snapshot: Uint8Array; deviceId: string }): Promise<void>;
	getCursor(groupId: string): Promise<number>;
	setCursor(groupId: string, order: number): Promise<void>;
	putRows(groupId: string, rows: UnwrappedRow[]): Promise<void>;
	/** Rows ascending by order; `before` exclusive. */
	listRows(groupId: string, options: { before?: number; limit: number }): Promise<UnwrappedRow[]>;
	/** `${order}:${messageId}` of the given rows that are already stored. */
	hasRows(groupId: string, rows: { order: number; messageId: string }[]): Promise<Set<string>>;
	/** Groups with stored rows (history bundles). */
	groupIds(): Promise<string[]>;
	/** Small device-local values (e.g. verified certificate digests). `null` deletes. */
	getMeta(key: string): Promise<string | null>;
	setMeta(key: string, value: string | null): Promise<void>;
	clear(): Promise<void>;
}

export class MemoryMlsStateStore implements MlsStateStore {
	#device: { snapshot: Uint8Array; deviceId: string } | null = null;
	#cursors = new Map<string, number>();
	#rows = new Map<string, Map<string, UnwrappedRow>>();
	#meta = new Map<string, string>();

	async loadDevice() {
		return this.#device;
	}
	async saveDevice(state: { snapshot: Uint8Array; deviceId: string }) {
		this.#device = state;
	}
	async getCursor(groupId: string) {
		return this.#cursors.get(groupId) ?? 0;
	}
	async setCursor(groupId: string, order: number) {
		this.#cursors.set(groupId, order);
	}
	async putRows(groupId: string, rows: UnwrappedRow[]) {
		const map = this.#rows.get(groupId) ?? new Map();
		for (const row of rows) map.set(`${row.order}:${row.messageId}`, row);
		this.#rows.set(groupId, map);
	}
	async listRows(groupId: string, options: { before?: number; limit: number }) {
		const all = [...(this.#rows.get(groupId)?.values() ?? [])]
			.filter((r) => options.before === undefined || r.order < options.before)
			.sort((a, b) => a.order - b.order);
		return all.slice(Math.max(0, all.length - options.limit));
	}
	async hasRows(groupId: string, rows: { order: number; messageId: string }[]) {
		const map = this.#rows.get(groupId);
		return new Set(rows.map((r) => `${r.order}:${r.messageId}`).filter((k) => map?.has(k)));
	}
	async groupIds() {
		return [...this.#rows.keys()];
	}
	async getMeta(key: string) {
		return this.#meta.get(key) ?? null;
	}
	async setMeta(key: string, value: string | null) {
		if (value === null) this.#meta.delete(key);
		else this.#meta.set(key, value);
	}
	async clear() {
		this.#device = null;
		this.#meta.clear();
		this.#cursors.clear();
		this.#rows.clear();
	}
}

/** Inner MLS plaintext: `0x4d 0x01 || nonce(12) || keyVersion(u64 BE) || DEK ciphertext`. */
export function encodeInner(inner: { nonce: Uint8Array; keyVersion: bigint; ciphertext: Uint8Array }): Uint8Array {
	const out = new Uint8Array(2 + 12 + 8 + inner.ciphertext.length);
	out[0] = 0x4d;
	out[1] = 0x01;
	out.set(inner.nonce, 2);
	new DataView(out.buffer).setBigUint64(14, inner.keyVersion, false);
	out.set(inner.ciphertext, 22);
	return out;
}

export function decodeInner(
	bytes: Uint8Array,
): { nonce: Uint8Array; keyVersion: bigint; ciphertext: Uint8Array } | null {
	if (bytes.length < 22 + 16 || bytes[0] !== 0x4d || bytes[1] !== 0x01) return null;
	return {
		nonce: bytes.slice(2, 14),
		keyVersion: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(14, false),
		ciphertext: bytes.slice(22),
	};
}
