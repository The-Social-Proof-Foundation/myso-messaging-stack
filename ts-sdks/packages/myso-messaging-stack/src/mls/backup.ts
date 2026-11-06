// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey message backup (E2EE M8).
 *
 * MLS keys are single use, so a device's readable history lives only on that device (plus copies
 * synced to its other devices). This optional backup keeps it recoverable on a brand-new device:
 *
 * - **Key.** The existing `mysocial.network` passkey, evaluated with the WebAuthn PRF extension and
 *   salt `SHA-256("mysocial/messaging-backup-prf/v1")`, yields 32 secret bytes (independent of the
 *   wallet-vault PRF). HKDF-SHA256 (salt `mysocial/messaging-backup/v1`) derives the AES-256-GCM
 *   backup key (`info = "key:" + wallet`) and a public key id (`info = "id:" + wallet`, 16 bytes).
 * - **Segments.** Append-only ciphertexts on the relayer:
 *   `"MBK1" || nonce(12) || AES-256-GCM(key, flags(1) || history bundle, aad)`,
 *   `aad = "myso-backup-v1:" + wallet + ":" + keyId`. The bundle is the same row format as history
 *   sync, and every row is still DEK-sealed, so reading a backup needs the passkey **and** on-chain
 *   reader access (the MyData gate). The relayer learns only sizes, timing and the key id.
 * - **Incremental.** Each device uploads the rows it holds past a per-group cursor. Restore imports
 *   every segment and de-duplicates by (order, message id).
 *
 * This trades forward secrecy for recoverability (whoever holds the passkey can read back past
 * messages they could read before), which is why it is opt-in.
 */

import { fromHex, toHex } from '@socialproof/myso/utils';

export const BACKUP_PRF_LABEL = 'mysocial/messaging-backup-prf/v1';
const HKDF_SALT = 'mysocial/messaging-backup/v1';
const MAGIC = new TextEncoder().encode('MBK1');
/** Plaintext bytes per segment (bundles are cut below the relayer's segment limit). */
export const BACKUP_SEGMENT_PLAINTEXT_BYTES = 512 * 1024;

const utf8 = new TextEncoder();

/** The PRF salt (`SHA-256(BACKUP_PRF_LABEL)`) to pass as `prf.eval.first`. */
export async function backupPrfSalt(): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(BACKUP_PRF_LABEL)));
}

/** A derived backup key. `keyHex` is secret (seal it at rest); `keyId` is not. */
export interface MessageBackupKey {
	keyId: string;
	keyHex: string;
}

/** Derive the backup key and its id from the passkey PRF output, bound to `wallet`. */
export async function deriveBackupKey(prf: Uint8Array, wallet: string): Promise<MessageBackupKey> {
	if (prf.length !== 32) throw new Error('passkey PRF output must be 32 bytes');
	const w = wallet.trim().toLowerCase();
	const ikm = await crypto.subtle.importKey('raw', prf as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
	const derive = async (info: string, bytes: number) =>
		new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(HKDF_SALT), info: utf8.encode(info) },
				ikm,
				bytes * 8,
			),
		);
	return { keyHex: toHex(await derive(`key:${w}`, 32)), keyId: toHex(await derive(`id:${w}`, 16)) };
}

async function aesKey(key: MessageBackupKey, usage: KeyUsage) {
	return crypto.subtle.importKey('raw', fromHex(key.keyHex) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [usage]);
}

function aad(wallet: string, keyId: string) {
	return utf8.encode(`myso-backup-v1:${wallet.trim().toLowerCase()}:${keyId}`);
}

/** Encrypt one segment (`payload` = an encoded history bundle). */
export async function sealBackupSegment(key: MessageBackupKey, wallet: string, payload: Uint8Array): Promise<Uint8Array> {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plain = new Uint8Array(1 + payload.length);
	plain[0] = 0; // flags: no compression (reserved)
	plain.set(payload, 1);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce, additionalData: aad(wallet, key.keyId) },
			await aesKey(key, 'encrypt'),
			plain,
		),
	);
	const out = new Uint8Array(MAGIC.length + 12 + ct.length);
	out.set(MAGIC, 0);
	out.set(nonce, MAGIC.length);
	out.set(ct, MAGIC.length + 12);
	return out;
}

/** Decrypt one segment; `null` if it isn't ours (wrong key / tampered / unknown format). */
export async function openBackupSegment(key: MessageBackupKey, wallet: string, segment: Uint8Array): Promise<Uint8Array | null> {
	if (segment.length < MAGIC.length + 12 + 17 || MAGIC.some((b, i) => segment[i] !== b)) return null;
	try {
		const plain = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: segment.slice(MAGIC.length, MAGIC.length + 12), additionalData: aad(wallet, key.keyId) },
				await aesKey(key, 'decrypt'),
				segment.slice(MAGIC.length + 12),
			),
		);
		if (plain[0] !== 0) return null; // unknown flags
		return plain.slice(1);
	} catch {
		return null;
	}
}
