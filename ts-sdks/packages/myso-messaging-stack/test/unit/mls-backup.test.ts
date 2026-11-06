// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// Passkey message backup (E2EE M8) on the real `myso-mls` WASM.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { toHex } from '@socialproof/myso/utils';
import { describe, expect, it } from 'vitest';

import {
	backupPrfSalt,
	BACKUP_PRF_LABEL,
	deriveBackupKey,
	openBackupSegment,
	sealBackupSegment,
} from '../../src/mls/backup.js';
import { createCertificateVerifier, MlsSession } from '../../src/mls/session.js';
import { MemoryMlsStateStore, type MlsWasmModule, type UnwrappedRow } from '../../src/mls/types.js';
import { FakeRelayer } from './support/fake-mls-relayer.js';

const pkg = new URL('../../../../../mls/pkg-node/myso_mls.js', import.meta.url).pathname;
const wasm = existsSync(pkg) ? (createRequire(import.meta.url)(pkg) as MlsWasmModule) : null;
const GROUP = '0x' + 'b8'.repeat(32);

const prfA = new Uint8Array(32).fill(0xa1);
const prfB = new Uint8Array(32).fill(0xb2);

describe('backup key + segments', () => {
	it('uses the documented PRF salt and binds keys to the wallet', async () => {
		const salt = await backupPrfSalt();
		const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BACKUP_PRF_LABEL)));
		expect(toHex(salt)).toBe(toHex(expected));
		const a1 = await deriveBackupKey(prfA, '0xAAA');
		expect(a1).toEqual(await deriveBackupKey(prfA, '0xaaa')); // deterministic, case-insensitive
		expect(a1.keyId).toHaveLength(32);
		expect((await deriveBackupKey(prfA, '0xbbb')).keyHex).not.toBe(a1.keyHex); // per wallet
		expect((await deriveBackupKey(prfB, '0xaaa')).keyId).not.toBe(a1.keyId); // per passkey
		await expect(deriveBackupKey(new Uint8Array(16), '0xaaa')).rejects.toThrow();
	});

	it('round-trips, and rejects the wrong key, wallet, or tampering', async () => {
		const key = await deriveBackupKey(prfA, '0xaaa');
		const payload = new TextEncoder().encode('{"v":1,"groups":{}}');
		const seg = await sealBackupSegment(key, '0xaaa', payload);
		expect(new TextDecoder().decode(seg.slice(0, 4))).toBe('MBK1');
		expect(await openBackupSegment(key, '0xaaa', seg)).toEqual(payload);
		expect(await openBackupSegment(await deriveBackupKey(prfB, '0xaaa'), '0xaaa', seg)).toBeNull();
		expect(await openBackupSegment(key, '0xbbb', seg)).toBeNull(); // AAD binds the wallet
		const bad = seg.slice();
		bad[bad.length - 1]! ^= 1;
		expect(await openBackupSegment(key, '0xaaa', bad)).toBeNull();
	});
});

describe.skipIf(!wasm)('MLS message backup (real WASM)', () => {
	const mls = wasm!;
	const verifyCertificate = createCertificateVerifier((c) => mls.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms));

	async function device(relayer: FakeRelayer, kp: Ed25519Keypair, id: string) {
		const store = new MemoryMlsStateStore();
		const session = await MlsSession.open({ wasm: mls, store, relayer, signer: kp, deviceId: id, verifyCertificate, verifyRow: async () => true, keyPackageTarget: 2 });
		return { session, store };
	}

	const row = (order: number, text: string): UnwrappedRow => ({
		messageId: `m${order}`, groupId: GROUP, order, encryptedText: new TextEncoder().encode(text), nonce: new Uint8Array(12),
		keyVersion: 1n, senderAddress: '0xabc', createdAt: order, updatedAt: order, attachments: [], isEdited: false,
		isDeleted: false, signature: '', publicKey: '', isAgentMessage: false, kind: 'message', senderVerified: true,
	});

	it('backs up incrementally and restores on a brand-new device with the same passkey', async () => {
		const relayer = new FakeRelayer(mls);
		const kp = Ed25519Keypair.generate();
		const phone = await device(relayer, kp, 'phone');
		await phone.session.storeOwn(GROUP, row(1, 'one'));
		await phone.session.storeOwn(GROUP, row(2, 'two'));

		const first = await phone.session.enableBackup(prfA);
		expect(first).toMatchObject({ restored: 0, backedUp: 2 });
		expect(await phone.session.backupNow()).toBe(0); // nothing new
		await phone.session.storeOwn(GROUP, row(3, 'three'));
		expect(await phone.session.backupNow()).toBe(1); // only the new row
		expect(relayer.backup).toHaveLength(2);
		// The relayer holds ciphertext only.
		expect(relayer.backup.every((b) => !new TextDecoder().decode(b.body).includes('three'))).toBe(true);

		// Phone lost. A new device with the same passkey gets everything back.
		const tablet = await device(relayer, kp, 'tablet');
		const restored = await tablet.session.enableBackup(prfA);
		expect(restored.restored).toBe(3);
		expect(restored.backedUp).toBe(0); // doesn't re-upload what the backup already holds
		const texts = (await tablet.store.listRows(GROUP, { limit: 50 })).map((r) => new TextDecoder().decode(r.encryptedText));
		expect(texts).toEqual(['one', 'two', 'three']);
		// Restoring again doesn't duplicate.
		expect(await tablet.session.restoreBackup()).toBe(0);
	});

	it('another passkey or another wallet sees nothing; turning it off can delete the backup', async () => {
		const relayer = new FakeRelayer(mls);
		const kp = Ed25519Keypair.generate();
		const a = await device(relayer, kp, 'a');
		await a.session.storeOwn(GROUP, row(1, 'secret'));
		await a.session.enableBackup(prfA);

		const otherPasskey = await device(relayer, kp, 'b');
		expect((await otherPasskey.session.enableBackup(prfB)).restored).toBe(0);
		const otherWallet = await device(relayer, Ed25519Keypair.generate(), 'c');
		expect((await otherWallet.session.enableBackup(prfA)).restored).toBe(0);

		await a.session.disableBackup({ deleteRemote: true });
		expect(await a.session.backupKey()).toBeNull();
		expect(await a.session.backupNow()).toBe(0);
		const fresh = await device(relayer, kp, 'd');
		expect((await fresh.session.enableBackup(prfA)).restored).toBe(0);
	});
});
