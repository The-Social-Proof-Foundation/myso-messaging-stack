// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// Certificate renewal (E2EE M6) on the real `myso-mls` WASM: devices register an authority key in
// an in-memory registry that enforces the same rules as `messaging::mls_device_registry`, renew
// their certificates without the account, rotate, and get revoked.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import type { Transaction } from '@socialproof/myso/transactions';
import { toHex } from '@socialproof/myso/utils';
import { describe, expect, it } from 'vitest';

import { CertificateCache, REGISTRY_MAX_STALE_MS, REGISTRY_TTL_MS } from '../../src/mls/certificates.js';
import { MlsMembersUnverifiedError } from '../../src/mls/errors.js';
import {
	certificateCanonicalV2,
	issueCertificateV2,
	MLS_ROTATION_GRACE_MS,
	registryKeyIsValid,
	type MlsDeviceRecord,
	type MlsRegistrySubmitter,
} from '../../src/mls/registry.js';
import { createCertificateVerifier, MlsSession } from '../../src/mls/session.js';
import { MemoryMlsStateStore, type MlsDeviceCertificate, type MlsWasmModule } from '../../src/mls/types.js';
import { FakeRelayer } from './support/fake-mls-relayer.js';

const pkg = new URL('../../../../../mls/pkg-node/myso_mls.js', import.meta.url).pathname;
const wasm = existsSync(pkg) ? (createRequire(import.meta.url)(pkg) as MlsWasmModule) : null;
const GROUP = '0x' + 'd7'.repeat(32);
const DAY = 86_400_000;

type Call = { fn: 'register' | 'rotate' | 'revoke_by_device'; arg: string };

/** Same rules as the Move module; "transactions" are plain call records. */
class FakeRegistry {
	records = new Map<string, MlsDeviceRecord & { owner: string; deviceId: string }>();
	reachable = true;
	constructor(private readonly now: () => number) {}

	async lookup(owner: string, deviceId: string) {
		if (!this.reachable) throw new Error('fullnode unreachable');
		const r = this.records.get(`${owner.toLowerCase()}|${deviceId}`);
		return r ? { ...r } : null;
	}
	registerTx(deviceId: string, key: string) { return { fn: 'register', arg: `${deviceId}|${key}` } as unknown as Transaction; }
	rotateTx(key: string) { return { fn: 'rotate', arg: key } as unknown as Transaction; }
	revokeByDeviceTx(deviceId: string) { return { fn: 'revoke_by_device', arg: deviceId } as unknown as Transaction; }

	byAuthority(key: string) {
		return [...this.records.values()].find((r) => r.authorityKey === key && r.revokedAtMs === 0);
	}

	execute(tx: Transaction, sender: { account?: string; authority?: string }) {
		const call = tx as unknown as Call;
		if (call.fn === 'register') {
			const [deviceId, key] = call.arg.split('|') as [string, string];
			const id = `${sender.account}|${deviceId}`;
			if (!sender.account || this.records.has(id)) throw new Error('EAlreadyRegistered');
			if ([...this.records.values()].some((r) => r.authorityKey === key)) throw new Error('EKeyInUse');
			this.records.set(id, {
				owner: sender.account, deviceId, authorityKey: key, previousKey: '', previousValidUntilMs: 0,
				generation: 1, registeredAtMs: this.now(), revokedAtMs: 0,
			});
			return;
		}
		const me = sender.authority ? this.byAuthority(sender.authority) : undefined;
		if (!me) throw new Error('ENotAuthorized');
		if (call.fn === 'rotate') {
			Object.assign(me, {
				previousKey: me.authorityKey, previousValidUntilMs: this.now() + MLS_ROTATION_GRACE_MS,
				authorityKey: call.arg, generation: me.generation + 1,
			});
		} else {
			const target = this.records.get(`${me.owner}|${call.arg}`);
			if (!target) throw new Error('ENotFound');
			if (target.revokedAtMs) throw new Error('ERevoked');
			target.revokedAtMs = this.now();
		}
	}

	submitter(account: string, opts: { accountCanSign?: () => boolean } = {}): MlsRegistrySubmitter {
		return {
			asAccount: async (tx) => {
				if (opts.accountCanSign && !opts.accountCanSign()) throw new Error('zkLogin proof expired');
				this.execute(tx, { account });
			},
			asAuthority: async (tx, kp) => this.execute(tx, { authority: toHex(kp.getPublicKey().toRawBytes()) }),
		};
	}
}

describe.skipIf(!wasm)('MLS certificate renewal (real WASM)', () => {
	const mls = wasm!;
	const ed25519 = createCertificateVerifier((c) => mls.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms));

	function world() {
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const relayer = new FakeRelayer(mls);
		const registry = new FakeRegistry(now);
		/** Wallets whose v1 certificates read as an expired zkLogin proof (`unknown`). */
		const expiredV1 = new Set<string>();
		const verifyCertificate = async (c: MlsDeviceCertificate) =>
			expiredV1.has(c.wallet.toLowerCase()) ? ('unknown' as const) : ed25519(c);
		async function device(
			kp: Ed25519Keypair,
			deviceId: string,
			opts: { store?: MemoryMlsStateStore; submit?: boolean; accountCanSign?: () => boolean } = {},
		) {
			const wallet = kp.toMySoAddress().toLowerCase();
			const store = opts.store ?? new MemoryMlsStateStore();
			const session = await MlsSession.open({
				wasm: mls, store, relayer, signer: kp, deviceId, verifyCertificate, verifyRow: async () => true,
				keyPackageTarget: 3, now,
				registry: {
					chain: registry,
					submitter: opts.submit === false ? undefined : registry.submitter(wallet, { accountCanSign: opts.accountCanSign }),
				},
			});
			return { session, store, kp, wallet };
		}
		return { relayer, registry, expiredV1, device, now, advance: (ms: number) => (clock += ms) };
	}

	const inner = (text: string) => ({ nonce: new Uint8Array(12).fill(3), keyVersion: 1n, ciphertext: new TextEncoder().encode(text.padEnd(32, '.')) });
	const text = (rows: { encryptedText: Uint8Array }[]) => rows.map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''));

	it('TS-issued v2 certificates verify in the Rust crate byte-for-byte', async () => {
		const authority = Ed25519Keypair.generate();
		const cert = await issueCertificateV2(authority, { wallet: '0xABC', device_id: 'web-1', mls_key: '0x' + 'aa'.repeat(32), issued_at_ms: 5 });
		expect(cert.wallet).toBe('0xabc');
		expect(mls.mlsVerifyCertificateV2(JSON.stringify(cert))).toBe(true);
		expect(mls.mlsVerifyCertificateV2(JSON.stringify({ ...cert, issued_at_ms: 6 }))).toBe(false);
		expect(certificateCanonicalV2({ ...cert, authority_key: cert.authority_key! })).toBe(`myso-mls-device-v2:0xabc:web-1:${'aa'.repeat(32)}:5:${cert.authority_key}`);
	});

	it('an expired-proof device renews on its own and unpauses the group', async () => {
		const w = world();
		const alice = await w.device(Ed25519Keypair.generate(), 'alice-phone');
		const bob = await w.device(Ed25519Keypair.generate(), 'bob-phone', { submit: false });
		await alice.session.createGroup(GROUP, [bob.wallet]);
		await bob.session.acceptWelcomes();

		// Bob's v1 (zkLogin) proof expires. Alice verified it while fresh (cached for good), but
		// Carol joins later and can't check it: her sends pause, and Bob is never removed.
		w.expiredV1.add(bob.wallet);
		const carol = await w.device(Ed25519Keypair.generate(), 'carol-phone');
		expect(await carol.session.joinExternal(GROUP)).toBe(true);
		const readers = new Set([alice.wallet, bob.wallet, carol.wallet]);
		await expect(carol.session.seal(GROUP, readers, inner('x'))).rejects.toBeInstanceOf(MlsMembersUnverifiedError);
		expect(carol.session.members(GROUP)).toHaveLength(3);

		// Bob's device (registered while his proof was fresh) renews: no account signature now.
		const bob2 = await w.device(bob.kp, 'bob-phone', { store: bob.store });
		expect(await bob2.session.maintain()).toBe('current');
		expect(bob2.session.certificate.v).toBe(2);
		// Second run is a no-op: nothing to renew, no new commits.
		const before = (w.relayer.rows.get(GROUP) ?? []).length;
		expect(await bob2.session.maintain()).toBe('current');
		expect((w.relayer.rows.get(GROUP) ?? []).length).toBe(before);

		// Carol applies Bob's credential-update commit, verifies v2 via the registry, and sends.
		w.relayer.append(GROUP, carol.wallet, 'message', await carol.session.seal(GROUP, readers, inner('renewed')));
		expect(carol.session.members(GROUP).find((m) => m.certificate?.wallet === bob.wallet)?.certificate?.v).toBe(2);
		expect(text(await bob2.session.sync(GROUP))).toContain('renewed');
		await alice.session.sync(GROUP);
		expect(alice.session.members(GROUP)).toHaveLength(3);
		// New KeyPackages carry the v2 certificate.
		const fresh = w.relayer.kps.filter((k) => k.deviceId === 'bob-phone' && !k.claimed);
		expect(fresh.length).toBeGreaterThan(0);
		expect(JSON.parse(mls.mlsKeyPackageCertificate(fresh[0]!.keyPackage)!).v).toBe(2);
	});

	it('registration waits until the account can sign, keeping v1 meanwhile', async () => {
		const w = world();
		let canSign = false;
		const kp = Ed25519Keypair.generate();
		const d = await w.device(kp, 'ios-1', { accountCanSign: () => canSign });
		expect(await d.session.maintain()).toBe('unregistered');
		expect(d.session.certificate.v).toBe(1);
		canSign = true;
		expect(await d.session.maintain()).toBe('current');
		expect(d.session.certificate.v).toBe(2);
	});

	it('rotates the authority key on schedule without the account; old certificates get a grace period', async () => {
		const w = world();
		const alice = await w.device(Ed25519Keypair.generate(), 'alice-phone');
		const bob = await w.device(Ed25519Keypair.generate(), 'bob-phone');
		await alice.session.createGroup(GROUP, [bob.wallet]);
		await bob.session.acceptWelcomes();
		await alice.session.maintain();
		await bob.session.maintain();
		const readers = new Set([alice.wallet, bob.wallet]);
		const oldKey = bob.session.certificate.authority_key!;

		w.advance(91 * DAY);
		let accountSigns = 0;
		const sub = w.registry.submitter(bob.wallet);
		const counting = { ...sub, asAccount: async (tx: Transaction) => { accountSigns++; return sub.asAccount(tx); } };
		const bob2 = await MlsSession.open({
			wasm: mls, store: bob.store, relayer: w.relayer, signer: bob.kp, deviceId: 'bob-phone',
			verifyCertificate: ed25519, verifyRow: async () => true, now: w.now, registry: { chain: w.registry, submitter: counting },
		});
		expect(await bob2.maintain()).toBe('current');
		expect(accountSigns).toBe(0); // rotation needs no account signature / zkLogin proof
		const newKey = bob2.certificate.authority_key!;
		expect(newKey).not.toBe(oldKey);
		const record = (await w.registry.lookup(bob.wallet, 'bob-phone'))!;
		expect(record.generation).toBe(2);
		expect(registryKeyIsValid(record, oldKey, w.now())).toBe(true); // in-flight certs keep working
		expect(registryKeyIsValid(record, oldKey, w.now() + MLS_ROTATION_GRACE_MS)).toBe(false);

		w.advance(REGISTRY_TTL_MS + 1); // Alice's cached registry answer expires
		w.relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, readers, inner('after rotation')));
		expect(alice.session.members(GROUP).find((m) => m.certificate?.wallet === bob.wallet)?.certificate?.authority_key).toBe(newKey);
		expect(text(await bob2.sync(GROUP))).toContain('after rotation');
	});

	it('resolves a rotation that landed on-chain but was never saved locally', async () => {
		const w = world();
		const d = await w.device(Ed25519Keypair.generate(), 'tab');
		await d.session.maintain();
		// Simulate a crash after the rotate tx: the pending key is on-chain, not promoted locally.
		const pending = Ed25519Keypair.generate();
		await d.store.setMeta('authority-pending', pending.getSecretKey());
		const current = Ed25519Keypair.fromSecretKey((await d.store.getMeta('authority'))!);
		w.registry.execute(w.registry.rotateTx(toHex(pending.getPublicKey().toRawBytes())), { authority: toHex(current.getPublicKey().toRawBytes()) });
		expect(await d.session.maintain()).toBe('current');
		expect(d.session.certificate.authority_key).toBe(toHex(pending.getPublicKey().toRawBytes()));
		expect(await d.store.getMeta('authority-pending')).toBeNull();
	});

	it('revocation takes effect after the cache TTL, and stale caches expire during outages', async () => {
		const w = world();
		const alice = await w.device(Ed25519Keypair.generate(), 'alice-phone');
		const bobKp = Ed25519Keypair.generate();
		const bobPhone = await w.device(bobKp, 'bob-phone');
		const bobLaptop = await w.device(bobKp, 'bob-laptop');
		for (const d of [alice, bobPhone, bobLaptop]) await d.session.maintain();
		await alice.session.createGroup(GROUP, [bobPhone.wallet]);
		await bobPhone.session.acceptWelcomes();
		await bobLaptop.session.acceptWelcomes();
		const readers = new Set([alice.wallet, bobPhone.wallet]);
		await alice.session.seal(GROUP, readers, inner('warm cache'));
		expect(alice.session.members(GROUP)).toHaveLength(3);

		// The laptop is lost: Bob's phone revokes it on-chain with its own key.
		await bobPhone.session.revokeDevice('bob-laptop');
		expect(await bobLaptop.session.maintain()).toBe('revoked');
		// Within the TTL Alice still trusts her cached answer; after it, the laptop is removed.
		await alice.session.seal(GROUP, readers, inner('within ttl'));
		expect(alice.session.members(GROUP)).toHaveLength(3);
		w.advance(REGISTRY_TTL_MS + 1);
		await alice.session.seal(GROUP, readers, inner('after ttl'));
		expect(alice.session.members(GROUP).map((m) => m.certificate?.device_id)).not.toContain('bob-laptop');

		// Chain unreachable: cached answers carry on for at most a day, then sends pause.
		w.registry.reachable = false;
		w.advance(REGISTRY_TTL_MS + 1);
		await alice.session.seal(GROUP, readers, inner('stale but in limit'));
		w.advance(REGISTRY_MAX_STALE_MS);
		await expect(alice.session.seal(GROUP, readers, inner('too stale'))).rejects.toBeInstanceOf(MlsMembersUnverifiedError);
		expect(alice.session.members(GROUP).map((m) => m.certificate?.device_id)).toContain('bob-phone'); // never removed
		w.registry.reachable = true;
		await alice.session.seal(GROUP, readers, inner('back online'));
	});

	it('classifies v2 certificates against the registry', async () => {
		const w = world();
		const store = new MemoryMlsStateStore();
		const cache = new CertificateCache(ed25519, store, {
			verifySignature: (json) => mls.mlsVerifyCertificateV2(json),
			registry: w.registry,
			now: w.now,
		});
		const owner = Ed25519Keypair.generate().toMySoAddress().toLowerCase();
		const key = Ed25519Keypair.generate();
		const cert = (k: Ed25519Keypair, deviceId: string, issued = w.now() - DAY) =>
			issueCertificateV2(k, { wallet: owner, device_id: deviceId, mls_key: 'bb'.repeat(32), issued_at_ms: issued });

		// Signed fine, but the device isn't registered: invalid (or unknown if just issued: lag).
		expect(await cache.status(await cert(key, 'd1'))).toBe('invalid');
		expect(await cache.status(await cert(key, 'd2', w.now()))).toBe('unknown');
		// Registered: valid. A different key for that device: invalid. Tampered: invalid.
		w.registry.execute(w.registry.registerTx('d3', toHex(key.getPublicKey().toRawBytes())), { account: owner });
		expect(await cache.status(await cert(key, 'd3'))).toBe('valid');
		expect(await cache.status(await cert(Ed25519Keypair.generate(), 'd3'))).toBe('invalid');
		expect(await cache.status({ ...(await cert(key, 'd3')), mls_key: 'cc'.repeat(32) })).toBe('invalid');
	});
});
