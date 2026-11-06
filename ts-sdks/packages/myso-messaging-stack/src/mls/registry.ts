// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * MLS device registry (E2EE M6: certificate renewal) — the TS side of
 * `messaging::mls_device_registry` (myso-core `crates/myso-framework/packages/messaging`).
 *
 * Each device has a long-lived ed25519 **authority key**, registered on-chain once by the account
 * (sponsored tx; for zkLogin the chain checks the proof when it runs). The authority key then signs
 * the device's v2 certificates, rotates itself and revokes devices, all without the account or a new
 * zkLogin proof. Anyone verifies a v2 certificate by its signature plus this registry.
 */

import { bcs } from '@socialproof/myso/bcs';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { Transaction } from '@socialproof/myso/transactions';
import { fromHex, toHex } from '@socialproof/myso/utils';

import type { MlsDeviceCertificate } from './types.js';

export { MLS_DEVICE_REGISTRY_DERIVATION_KEY } from '../constants.js';
/** Must match Move `ROTATION_GRACE_MS`. */
export const MLS_ROTATION_GRACE_MS = 604_800_000;

/** One registry record (Move `DeviceRecord`). Keys are lowercase hex. */
export interface MlsDeviceRecord {
	authorityKey: string;
	/** '' if never rotated. */
	previousKey: string;
	previousValidUntilMs: number;
	generation: number;
	registeredAtMs: number;
	/** 0 = active. */
	revokedAtMs: number;
}

/** Same rule as Move `is_valid_key`: current key, or the previous one inside its grace window. */
export function registryKeyIsValid(record: MlsDeviceRecord, keyHex: string, nowMs: number): boolean {
	if (record.revokedAtMs !== 0) return false;
	const key = keyHex.toLowerCase().replace(/^0x/, '');
	return key === record.authorityKey || (record.previousKey !== '' && key === record.previousKey && nowMs < record.previousValidUntilMs);
}

/** Reads registry records. `lookup` resolves `null` when not registered; throws on network errors. */
export interface MlsDeviceRegistryReader {
	lookup(owner: string, deviceId: string): Promise<MlsDeviceRecord | null>;
}

const DeviceKeyBcs = bcs.struct('DeviceKey', { owner: bcs.Address, device_id: bcs.string() });
const DeviceRecordBcs = bcs.struct('DeviceRecord', {
	authority_key: bcs.vector(bcs.u8()),
	previous_key: bcs.vector(bcs.u8()),
	previous_valid_until_ms: bcs.u64(),
	generation: bcs.u64(),
	registered_at_ms: bcs.u64(),
	revoked_at_ms: bcs.u64(),
});

function isNotFound(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return code === 'notExists' || code === 'dynamicFieldNotFound' || code === 'deleted';
}

export interface ChainMlsDeviceRegistryOptions {
	client: ClientWithCoreApi;
	/** Original messaging package id (type names). */
	originalPackageId: string;
	/** Latest messaging package id (moveCall targets). */
	latestPackageId: string;
	/** The derived `MlsDeviceRegistry` object id (`derive.mlsDeviceRegistryId()`). */
	registryId: string;
	/** Messaging `Version` shared object id. */
	versionId: string;
}

/** Fullnode-backed registry: dynamic-field reads plus transaction builders. */
export class ChainMlsDeviceRegistry implements MlsDeviceRegistryReader {
	readonly #o: ChainMlsDeviceRegistryOptions;
	#devicesTable: Promise<string> | null = null;

	constructor(options: ChainMlsDeviceRegistryOptions) {
		this.#o = options;
	}

	/** `MlsDeviceRegistry { id, devices: Table { id, size }, by_authority }`: the table's id. */
	#tableId(): Promise<string> {
		this.#devicesTable ??= (async () => {
			const { object } = await this.#o.client.core.getObject({ objectId: this.#o.registryId, include: { content: true } });
			const content = await object.content;
			if (!content || content.length < 64) throw new Error('unexpected MlsDeviceRegistry layout');
			return `0x${toHex(content.slice(32, 64))}`;
		})().catch((error) => {
			this.#devicesTable = null;
			throw error;
		});
		return this.#devicesTable;
	}

	async lookup(owner: string, deviceId: string): Promise<MlsDeviceRecord | null> {
		const parentId = await this.#tableId();
		let field;
		try {
			field = await this.#o.client.core.getDynamicField({
				parentId,
				name: {
					type: `${this.#o.originalPackageId}::mls_device_registry::DeviceKey`,
					bcs: DeviceKeyBcs.serialize({ owner, device_id: deviceId }).toBytes(),
				},
			});
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
		const r = DeviceRecordBcs.parse(field.dynamicField.value.bcs);
		return {
			authorityKey: toHex(Uint8Array.from(r.authority_key)),
			previousKey: toHex(Uint8Array.from(r.previous_key)),
			previousValidUntilMs: Number(r.previous_valid_until_ms),
			generation: Number(r.generation),
			registeredAtMs: Number(r.registered_at_ms),
			revokedAtMs: Number(r.revoked_at_ms),
		};
	}

	#call(fn: string, args: (tx: Transaction) => Parameters<Transaction['moveCall']>[0]['arguments']) {
		const tx = new Transaction();
		tx.moveCall({ target: `${this.#o.latestPackageId}::mls_device_registry::${fn}`, arguments: args(tx) });
		return tx;
	}

	/** Account-signed (sender = the account): register `deviceId` with `authorityKeyHex`. */
	registerTx(deviceId: string, authorityKeyHex: string): Transaction {
		return this.#call('register', (tx) => [
			tx.object(this.#o.registryId),
			tx.object(this.#o.versionId),
			tx.pure.string(deviceId),
			tx.pure.vector('u8', fromHex(authorityKeyHex)),
			tx.object.clock(),
		]);
	}

	/** Authority-signed (sender = the current authority key's address): rotate to `newKeyHex`. */
	rotateTx(newKeyHex: string): Transaction {
		return this.#call('rotate', (tx) => [
			tx.object(this.#o.registryId),
			tx.object(this.#o.versionId),
			tx.pure.vector('u8', fromHex(newKeyHex)),
			tx.object.clock(),
		]);
	}

	/** Authority-signed: revoke one of the account's devices (another one, or itself). */
	revokeByDeviceTx(deviceId: string): Transaction {
		return this.#call('revoke_by_device', (tx) => [
			tx.object(this.#o.registryId),
			tx.object(this.#o.versionId),
			tx.pure.string(deviceId),
			tx.object.clock(),
		]);
	}

	/** Account-signed: revoke one of the account's devices. */
	revokeTx(deviceId: string): Transaction {
		return this.#call('revoke', (tx) => [
			tx.object(this.#o.registryId),
			tx.object(this.#o.versionId),
			tx.pure.string(deviceId),
			tx.object.clock(),
		]);
	}
}

/**
 * Executes registry transactions for a session (apps wire these to their gas sponsor).
 * - `asAccount`: sender = the account (zkLogin: needs a currently valid proof). Used once per
 *   device, to register. Rejects if the account can't sign right now (e.g. proof expired).
 * - `asAuthority`: sender = `authority`'s address, signed by it; gas sponsored (it holds none).
 * Both resolve once the transaction is final.
 */
export interface MlsRegistrySubmitter {
	asAccount(tx: Transaction): Promise<void>;
	asAuthority(tx: Transaction, authority: Ed25519Keypair): Promise<void>;
}

/** The bytes a v2 certificate's authority key signs. Must match `myso-mls` `canonical_v2`. */
export function certificateCanonicalV2(c: {
	wallet: string;
	device_id: string;
	mls_key: string;
	issued_at_ms: number;
	authority_key: string;
}): string {
	const hex = (h: string) => h.trim().replace(/^0x/, '').toLowerCase();
	return `myso-mls-device-v2:${c.wallet.trim().toLowerCase()}:${c.device_id.trim()}:${hex(c.mls_key)}:${c.issued_at_ms}:${hex(c.authority_key)}`;
}

/** Issue a v2 certificate for this device's MLS key, signed by its authority key. */
export async function issueCertificateV2(
	authority: Ed25519Keypair,
	fields: { wallet: string; device_id: string; mls_key: string; issued_at_ms: number },
): Promise<MlsDeviceCertificate> {
	const authority_key = toHex(authority.getPublicKey().toRawBytes());
	const base = {
		wallet: fields.wallet.trim().toLowerCase(),
		device_id: fields.device_id.trim(),
		mls_key: fields.mls_key.trim().replace(/^0x/, '').toLowerCase(),
		issued_at_ms: fields.issued_at_ms,
		authority_key,
	};
	const sig = await authority.sign(new TextEncoder().encode(certificateCanonicalV2(base)));
	return { v: 2, ...base, sig: toHex(sig), signer_key: 'authority' };
}
