// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * MLS device certificate verification (E2EE M6 hardening).
 *
 * Verification is tri-state ({@link MlsCertificateStatus}). The membership rule removes only
 * `invalid` leaves; `unknown` (fullnode unreachable, or a zkLogin proof past `max_epoch` that this
 * device never verified) pauses sends instead, so a legitimate member is never removed because of
 * an outage or proof expiry.
 */

import { Ed25519PublicKey } from '@socialproof/myso/keypairs/ed25519';
import { fromHex, toHex } from '@socialproof/myso/utils';
import { computeZkLoginAddressFromSeed, parseZkLoginSignature } from '@socialproof/myso/zklogin';

import { registryKeyIsValid, type MlsDeviceRecord, type MlsDeviceRegistryReader } from './registry.js';
import type { MlsCertificateStatus, MlsDeviceCertificate, MlsStateStore } from './types.js';

const utf8 = new TextEncoder();
const ZKLOGIN_FLAG = 0x05;

/** Verifies a certificate's wallet signature. */
export type CertificateVerifier = (cert: MlsDeviceCertificate) => Promise<MlsCertificateStatus>;

/**
 * zkLogin check through a fullnode (never the relayer). Resolve `{ success }` from
 * `verifyZkLoginSignature`; throw when the fullnode can't be reached (→ `unknown`).
 */
export type ZkLoginVerifyHook = (message: Uint8Array, signatureHex: string, wallet: string) => Promise<boolean>;

export interface CertificateVerifierOptions {
	verifyZkLogin?: ZkLoginVerifyHook;
	/** Current chain epoch; tells an expired zkLogin proof (`unknown`) from a bad one (`invalid`). */
	currentEpoch?: () => Promise<bigint>;
}

/** zkLogin: the proof's (iss, addressSeed) must hash to the certified wallet. Local, no network. */
function zkLoginAddressMatches(inputs: ReturnType<typeof parseZkLoginSignature>['inputs'], wallet: string): boolean {
	let iss: string;
	try {
		iss = decodeIssClaim(inputs.issBase64Details.value, inputs.issBase64Details.indexMod4);
	} catch {
		return false;
	}
	const seed = BigInt(inputs.addressSeed);
	const target = wallet.toLowerCase();
	return [false, true].some((legacy) => {
		try {
			return computeZkLoginAddressFromSeed(seed, iss, legacy).toLowerCase() === target;
		} catch {
			return false;
		}
	});
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The `iss` value from a zkLogin proof's base64url claim slice (same rules as the MySo SDK). */
function decodeIssClaim(value: string, indexMod4: number): string {
	if (value.length < 2) throw new Error('claim too short');
	let bits: number[] = [];
	for (const ch of value) {
		const idx = B64URL.indexOf(ch);
		if (idx < 0) throw new Error('bad base64url');
		for (let b = 5; b >= 0; b--) bits.push((idx >> b) & 1);
	}
	const first = indexMod4 % 4;
	if (first === 1) bits = bits.slice(2);
	else if (first === 2) bits = bits.slice(4);
	else if (first === 3) throw new Error('not tightly packed');
	const last = (indexMod4 + value.length - 1) % 4;
	if (last === 2) bits = bits.slice(0, -2);
	else if (last === 1) bits = bits.slice(0, -4);
	else if (last === 0) throw new Error('not tightly packed');
	if (bits.length % 8 !== 0) throw new Error('bad claim length');
	const bytes = new Uint8Array(bits.length / 8);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = bits.slice(i * 8, i * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0);
	}
	const claim = new TextDecoder().decode(bytes);
	if (!claim.endsWith(',') && !claim.endsWith('}')) throw new Error('bad claim');
	const json = JSON.parse(`{${claim.slice(0, -1)}}`) as Record<string, unknown>;
	const iss = json.iss;
	if (typeof iss !== 'string' || Object.keys(json).length !== 1) throw new Error('not an iss claim');
	return iss;
}

async function verifyEd25519(cert: MlsDeviceCertificate, message: Uint8Array): Promise<MlsCertificateStatus> {
	try {
		const flagged = fromHex(cert.signer_key);
		if (flagged.length !== 33 || flagged[0] !== 0x00) return 'invalid';
		const key = new Ed25519PublicKey(flagged.slice(1));
		const sig = fromHex(cert.sig);
		const serialized = new Uint8Array([0x00, ...sig, ...flagged.slice(1)]);
		const ok = await key.verifyPersonalMessage(message, btoa(String.fromCharCode(...serialized)));
		return ok && key.toMySoAddress().toLowerCase() === cert.wallet.toLowerCase() ? 'valid' : 'invalid';
	} catch {
		return 'invalid';
	}
}

async function verifyZkLogin(
	cert: MlsDeviceCertificate,
	message: Uint8Array,
	options: CertificateVerifierOptions,
): Promise<MlsCertificateStatus> {
	let parsed: ReturnType<typeof parseZkLoginSignature>;
	try {
		const full = fromHex(cert.sig);
		if (full[0] !== ZKLOGIN_FLAG) return 'invalid';
		parsed = parseZkLoginSignature(full.slice(1));
	} catch {
		return 'invalid';
	}
	// Provably wrong regardless of the network: the proof is for another address.
	if (!zkLoginAddressMatches(parsed.inputs, cert.wallet)) return 'invalid';
	if (!options.verifyZkLogin) return 'unknown';
	let success: boolean;
	try {
		success = await options.verifyZkLogin(message, cert.sig, cert.wallet);
	} catch {
		return 'unknown'; // fullnode unreachable
	}
	if (success) return 'valid';
	// Rejected. Past `max_epoch` the fullnode rejects even an honest proof: that's `unknown`.
	if (!options.currentEpoch) return 'unknown';
	try {
		const epoch = await options.currentEpoch();
		return BigInt(parsed.maxEpoch) < epoch ? 'unknown' : 'invalid';
	} catch {
		return 'unknown';
	}
}

/**
 * Default verifier: ed25519 locally (signature + key derives the wallet); zkLogin (`signer_key`
 * `05`) checks the address binding locally and the proof through `verifyZkLogin` (a fullnode).
 */
export function createCertificateVerifier(
	canonical: (c: MlsDeviceCertificate) => string,
	options: CertificateVerifierOptions | ZkLoginVerifyHook = {},
): CertificateVerifier {
	const opts = typeof options === 'function' ? { verifyZkLogin: options } : options;
	return async (cert) => {
		if (cert.v !== 1 || typeof cert.sig !== 'string' || typeof cert.signer_key !== 'string') return 'invalid'; // v2: CertificateCache
		let message: Uint8Array;
		try {
			message = utf8.encode(canonical(cert));
		} catch {
			return 'invalid';
		}
		return cert.signer_key === '05' ? verifyZkLogin(cert, message, opts) : verifyEd25519(cert, message);
	};
}

/** Stable digest of the exact certificate (incl. signature / proof): the permanent cache key. */
export async function certificateDigest(cert: MlsDeviceCertificate): Promise<string> {
	const exact = JSON.stringify([
		cert.v, cert.wallet, cert.device_id, cert.mls_key, cert.issued_at_ms, cert.sig, cert.signer_key,
		...(cert.authority_key ? [cert.authority_key] : []),
	]);
	return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(exact))));
}

/** v2: how long a registry answer is trusted before re-reading the chain. */
export const REGISTRY_TTL_MS = 60 * 60 * 1000;
/** v2: if the chain can't be read, a cached answer is still used for at most this long. */
export const REGISTRY_MAX_STALE_MS = 24 * 60 * 60 * 1000;
/** v2: a certificate newer than this whose device isn't in the registry yet is `unknown` (lag). */
export const REGISTRY_PROPAGATION_MS = 10 * 60 * 1000;

export interface CertificateV2Options {
	/** Authority signature check (`wasm.mlsVerifyCertificateV2`). */
	verifySignature(json: string): boolean;
	registry: MlsDeviceRegistryReader;
	now?: () => number;
}

interface RegistryCacheEntry {
	record: MlsDeviceRecord | null;
	checkedAt: number;
}

/**
 * Certificate verification with caching that can't outlive a revocation:
 * - v1: `valid` cached permanently for the exact certificate + proof (v1 has no revocation).
 * - v2: the signature is checked once; the **registry answer** (current key, rotation grace,
 *   revoked) is cached for {@link REGISTRY_TTL_MS}, then re-read. If the chain can't be read, the
 *   last answer is used for at most {@link REGISTRY_MAX_STALE_MS}, after which the certificate is
 *   `unknown` (sends pause; nobody is removed). A revocation therefore takes effect within an hour
 *   when the chain is reachable, and never later than a day.
 * `invalid` is cached in memory only; `unknown` is never cached.
 */
export class CertificateCache {
	readonly #verify: CertificateVerifier;
	readonly #store: MlsStateStore;
	readonly #v2: CertificateV2Options | undefined;
	readonly #memory = new Map<string, MlsCertificateStatus>();
	readonly #registry = new Map<string, RegistryCacheEntry>();
	readonly #sigOk = new Map<string, boolean>();

	constructor(verify: CertificateVerifier, store: MlsStateStore, v2?: CertificateV2Options) {
		this.#verify = verify;
		this.#store = store;
		this.#v2 = v2;
	}

	#now() {
		return this.#v2?.now?.() ?? Date.now();
	}

	async status(cert: MlsDeviceCertificate): Promise<MlsCertificateStatus> {
		if (cert.v === 2) return this.#statusV2(cert);
		const digest = await certificateDigest(cert);
		const hit = this.#memory.get(digest);
		if (hit) return hit;
		if ((await this.#store.getMeta(`cert-ok:${digest}`)) === '1') {
			this.#memory.set(digest, 'valid');
			return 'valid';
		}
		const status = await this.#verify(cert);
		if (status === 'valid') await this.#store.setMeta(`cert-ok:${digest}`, '1');
		if (status !== 'unknown') this.#memory.set(digest, status);
		return status;
	}

	async #statusV2(cert: MlsDeviceCertificate): Promise<MlsCertificateStatus> {
		if (!this.#v2 || !cert.authority_key) return this.#v2 ? 'invalid' : 'unknown';
		const digest = await certificateDigest(cert);
		let sigOk = this.#sigOk.get(digest);
		if (sigOk === undefined) {
			sigOk = this.#v2.verifySignature(JSON.stringify(cert));
			this.#sigOk.set(digest, sigOk);
		}
		if (!sigOk) return 'invalid';
		const entry = await this.#registryEntry(cert.wallet.toLowerCase(), cert.device_id);
		if (!entry) return 'unknown'; // chain unreachable and nothing fresh enough cached
		const now = this.#now();
		if (!entry.record) {
			// Not registered (yet). Registration happens before a v2 certificate is published, so a
			// just-issued one may only be missing because our fullnode lags.
			return now - cert.issued_at_ms < REGISTRY_PROPAGATION_MS ? 'unknown' : 'invalid';
		}
		return registryKeyIsValid(entry.record, cert.authority_key, now) ? 'valid' : 'invalid';
	}

	/** Registry answer within the TTL, else re-read; stale answers only up to the hard limit. */
	async #registryEntry(owner: string, deviceId: string): Promise<RegistryCacheEntry | null> {
		const key = `reg:${owner}:${deviceId}`;
		const now = this.#now();
		let entry = this.#registry.get(key);
		if (!entry) {
			const saved = await this.#store.getMeta(key);
			if (saved) {
				try {
					entry = JSON.parse(saved) as RegistryCacheEntry;
				} catch {
					entry = undefined;
				}
			}
		}
		if (entry && now - entry.checkedAt < REGISTRY_TTL_MS) return entry;
		try {
			const record = await this.#v2!.registry.lookup(owner, deviceId);
			const fresh = { record, checkedAt: now };
			this.#registry.set(key, fresh);
			await this.#store.setMeta(key, JSON.stringify(fresh));
			return fresh;
		} catch {
			if (entry && now - entry.checkedAt < REGISTRY_MAX_STALE_MS) return entry;
			return null;
		}
	}

	/** Forget the registry answer for a device (e.g. right after rotating or revoking it). */
	async forgetRegistry(owner: string, deviceId: string) {
		const key = `reg:${owner.toLowerCase()}:${deviceId}`;
		this.#registry.delete(key);
		await this.#store.setMeta(key, null);
	}

	/** Seed the cache with a certificate this device just made itself (v1 only). */
	async trust(cert: MlsDeviceCertificate) {
		if (cert.v === 2) return;
		const digest = await certificateDigest(cert);
		this.#memory.set(digest, 'valid');
		await this.#store.setMeta(`cert-ok:${digest}`, '1');
	}
}
