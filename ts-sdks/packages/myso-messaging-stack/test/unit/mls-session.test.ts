// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// Runs the real `myso-mls` WASM (mls/pkg-node, built by `wasm-pack build --target nodejs`).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import { createCertificateVerifier, MlsSession } from '../../src/mls/session.js';
import { MlsMembersUnverifiedError } from '../../src/mls/errors.js';
import { MemoryMlsStateStore, type MlsCertificateStatus, type MlsDeviceCertificate, type MlsWasmModule } from '../../src/mls/types.js';
import { FakeRelayer } from './support/fake-mls-relayer.js';

const pkg = new URL('../../../../../mls/pkg-node/myso_mls.js', import.meta.url).pathname;
const wasm = existsSync(pkg) ? (createRequire(import.meta.url)(pkg) as MlsWasmModule) : null;
const GROUP = '0x' + 'c1'.repeat(32);

describe.skipIf(!wasm)('MlsSession (real WASM)', () => {
	const mls = wasm!;
	const verifyCertificate = createCertificateVerifier((c) =>
		mls.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms),
	);

	async function open(
		relayer: FakeRelayer,
		signer: Ed25519Keypair,
		deviceId: string,
		store = new MemoryMlsStateStore(),
		historyShareDays?: (groupId: string) => Promise<number>,
		extra: Partial<Parameters<typeof MlsSession.open>[0]> = {},
	) {
		const session = await MlsSession.open({
			wasm: mls, store, relayer, signer, deviceId, verifyCertificate, verifyRow: async () => true, keyPackageTarget: 3,
			historyShareDays, ...extra,
		});
		return { session, store, signer, wallet: session.wallet };
	}

	const inner = (text: string) => ({
		nonce: new Uint8Array(12).fill(1),
		keyVersion: 2n,
		ciphertext: new TextEncoder().encode(text.padEnd(32, '.')),
	});

	it('runs the full device lifecycle against an epoch-ordered relayer', async () => {
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone');
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone');
		const carol = await open(relayer, Ed25519Keypair.generate(), 'carol-phone');
		const eve = await open(relayer, Ed25519Keypair.generate(), 'eve-phone');

		// Certificates are wallet-signed and verify.
		expect(await verifyCertificate(alice.session.certificate)).toBe('valid');
		expect(await verifyCertificate({ ...alice.session.certificate, wallet: bob.wallet })).toBe('invalid');

		await alice.session.createGroup(GROUP, [bob.wallet]);
		expect(await bob.session.acceptWelcomes()).toEqual([GROUP]);
		const readers = new Set([alice.wallet, bob.wallet]);
		await alice.session.reconcile(GROUP, readers);

		// MLS-wrapped row unwraps to the inner DEK row on Bob's device.
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.wrap(GROUP, inner('hello bob')));
		const got = await bob.session.sync(GROUP);
		expect(got).toHaveLength(1);
		expect(new TextDecoder().decode(got[0]!.encryptedText)).toMatch(/^hello bob/);
		expect(got[0]!.keyVersion).toBe(2n);
		expect(got[0]!.senderVerified).toBe(true);

		// Alice adds Eve (not an on-chain reader); her reconcile removes Eve before sending.
		await alice.session.addWallets(GROUP, [eve.wallet]);
		expect(alice.session.members(GROUP)).toHaveLength(3);
		await alice.session.reconcile(GROUP, readers);
		expect(alice.session.members(GROUP)).toHaveLength(2);

		// Bob is stale (two epochs behind): his add loses the race, rolls back, catches up, retries.
		const epochBefore = relayer.epochs.get(GROUP)!;
		expect(await bob.session.addWallets(GROUP, [carol.wallet])).toBe(1);
		expect(relayer.epochs.get(GROUP)).toBe(epochBefore + 1);
		expect(await carol.session.acceptWelcomes()).toEqual([GROUP]);
		await alice.session.sync(GROUP);
		expect(alice.session.members(GROUP)).toHaveLength(3);

		// Bob restarts: restored from his store, he keeps reading and sending.
		const bob2 = await open(relayer, bob.signer, 'bob-phone', bob.store);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.wrap(GROUP, inner('after restart')));
		const afterRestart = await bob2.session.sync(GROUP);
		expect(afterRestart.map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''))).toContain('after restart');
		relayer.append(GROUP, bob.wallet, 'message', await bob2.session.wrap(GROUP, inner('bob replies')));
		await carol.session.sync(GROUP);
		const carolRows = await carol.session.sync(GROUP);
		const allCarol = [...carolRows, ...(await carol.store.listRows(GROUP, { limit: 50 }))];
		expect(allCarol.some((r) => new TextDecoder().decode(r.encryptedText).startsWith('bob replies'))).toBe(true);
		// Carol joined later: she never sees 'hello bob' (forward secrecy for new members).
		expect(allCarol.some((r) => new TextDecoder().decode(r.encryptedText).startsWith('hello bob'))).toBe(false);

		// Carol logs out: self-removal proposal, committed by Alice's next reconcile.
		await carol.session.logout([GROUP]);
		await alice.session.sync(GROUP);
		await alice.session.reconcile(GROUP, new Set([...readers, carol.wallet]));
		expect(alice.session.members(GROUP)).toHaveLength(2);
	});

	it('syncs history to a new own device and shares recent history with newcomers', async () => {
		const relayer = new FakeRelayer(mls);
		const shareWeek = async () => 7;
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone', undefined, shareWeek);
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone', undefined, shareWeek);
		await alice.session.createGroup(GROUP, [bob.wallet]);
		await bob.session.acceptWelcomes();
		const now = Math.floor(Date.now() / 1000);
		const send = async (text: string) => {
			const sealed = inner(text);
			relayer.append(GROUP, alice.wallet, 'message', await alice.session.wrap(GROUP, sealed));
			const rows = relayer.rows.get(GROUP)!;
			const row = rows[rows.length - 1]!;
			row.createdAt = now;
			// The client keeps its own readable copy after sending (MLS never returns it).
			await alice.session.storeOwn(GROUP, {
				...row, encryptedText: sealed.ciphertext, nonce: sealed.nonce, keyVersion: sealed.keyVersion, senderVerified: true,
			});
		};
		await send('old one');
		await send('old two');
		await bob.session.sync(GROUP);
		const texts = (rows: { encryptedText: Uint8Array }[]) =>
			rows.map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''));

		// Own-device history: Bob's phone creates his self-group; his new laptop joins it.
		await bob.session.ensureSelfGroup();
		const laptop = await open(relayer, bob.signer, 'bob-laptop');
		await laptop.session.ensureSelfGroup();
		await bob.session.syncSelf(); // phone sees the join, sends its history
		await laptop.session.syncSelf(); // laptop rebuilds it
		const laptopRows = await laptop.store.listRows(GROUP, { limit: 50 });
		expect(texts(laptopRows)).toEqual(['old one', 'old two']);
		expect(laptopRows.every((r) => r.senderVerified)).toBe(true); // own devices keep verification
		// Only one copy, even though Bob has two devices now (single responder).
		await laptop.session.syncSelf();
		expect(await laptop.store.listRows(GROUP, { limit: 50 })).toHaveLength(2);

		// Share recent history: Dave (a new member's new device) joins on his own via GroupInfo.
		const dave = await open(relayer, Ed25519Keypair.generate(), 'dave-phone', undefined, shareWeek);
		expect(await dave.session.joinExternal(GROUP)).toBe(true);
		await alice.session.sync(GROUP); // lowest leaf (Alice) answers with the last 7 days
		await bob.session.sync(GROUP); // Bob isn't the responder: no duplicate
		await dave.session.sync(GROUP);
		const daveRows = await dave.store.listRows(GROUP, { limit: 50 });
		expect(texts(daveRows)).toEqual(['old one', 'old two']);
		expect(daveRows.every((r) => r.senderVerified === false)).toBe(true); // shared = unverified
		const shares = (relayer.rows.get(GROUP) ?? []).filter((r) => r.kind === 'event');
		expect(new Set(shares.map((r) => r.senderAddress))).toEqual(new Set([alice.wallet]));
	});

	const textOf = (rows: { encryptedText: Uint8Array }[]) =>
		rows.map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''));

	async function pair(extra: Partial<Parameters<typeof MlsSession.open>[0]> = {}) {
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone', undefined, undefined, extra);
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone', undefined, undefined, extra);
		await alice.session.createGroup(GROUP, [bob.wallet]);
		expect(await bob.session.acceptWelcomes()).toEqual([GROUP]);
		return { relayer, alice, bob, readers: new Set([alice.wallet, bob.wallet]) };
	}

	it('certifies the account identity, not the messaging key (zkLogin mapping)', async () => {
		const relayer = new FakeRelayer(mls);
		const ephemeral = Ed25519Keypair.generate();
		const account = Ed25519Keypair.generate(); // stands in for the zkLogin account signer
		const dev = await open(relayer, ephemeral, 'web-1', undefined, undefined, { identity: account });
		expect(dev.session.wallet).toBe(account.toMySoAddress().toLowerCase());
		expect(dev.session.certificate.wallet).toBe(dev.session.wallet);
		expect(await verifyCertificate(dev.session.certificate)).toBe('valid');
		expect(relayer.kps.every((k) => k.wallet === dev.session.wallet)).toBe(true);

		// State certified for another account (pre-fix) is discarded: a fresh device is made.
		const store = new MemoryMlsStateStore();
		const old = await open(relayer, ephemeral, 'web-2', store);
		expect(old.session.wallet).toBe(ephemeral.toMySoAddress().toLowerCase());
		const fixed = await open(relayer, ephemeral, 'web-2', store, undefined, { identity: account });
		expect(fixed.session.certificate.wallet).toBe(account.toMySoAddress().toLowerCase());
		expect(fixed.session.certificate.mls_key).not.toBe(old.session.certificate.mls_key);
	});

	it('pauses (never removes) when a certificate is unknown, and caches valid results permanently', async () => {
		let mode: 'real' | 'unknown' | 'invalid' = 'real';
		const calls: string[] = [];
		const switchable = async (c: MlsDeviceCertificate): Promise<MlsCertificateStatus> => {
			calls.push(c.device_id);
			return mode === 'real' ? verifyCertificate(c) : mode;
		};
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone', undefined, undefined, { verifyCertificate: switchable });
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone');
		const carol = await open(relayer, Ed25519Keypair.generate(), 'carol-phone');
		await alice.session.createGroup(GROUP, [bob.wallet]);
		await bob.session.acceptWelcomes();
		const readers = new Set([alice.wallet, bob.wallet, carol.wallet]);

		// Bob verified once while checkable: cached for good, so an outage later doesn't matter.
		await alice.session.seal(GROUP, readers, inner('one'));
		mode = 'unknown';
		const before = calls.length;
		await alice.session.seal(GROUP, readers, inner('two'));
		expect(calls.length).toBe(before); // served from the persistent cache

		// Carol's device joins on its own; Alice can't verify it right now: pause, keep Carol.
		expect(await carol.session.joinExternal(GROUP)).toBe(true);
		await expect(alice.session.seal(GROUP, readers, inner('three'))).rejects.toBeInstanceOf(MlsMembersUnverifiedError);
		expect(alice.session.members(GROUP)).toHaveLength(3);
		await expect(alice.session.seal(GROUP, readers, inner('three'))).rejects.toMatchObject({ wallets: [carol.wallet] });

		// Verifiable again: the send goes through and Carol can read it.
		mode = 'real';
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, readers, inner('three')));
		expect(textOf(await carol.session.sync(GROUP))).toContain('three');

		// A provably bad certificate is removed.
		mode = 'invalid';
		const dave = await open(relayer, Ed25519Keypair.generate(), 'dave-phone');
		await dave.session.joinExternal(GROUP);
		await alice.session.seal(GROUP, new Set([...readers, dave.wallet]), inner('four'));
		expect(alice.session.members(GROUP).map((m) => m.certificate?.wallet)).not.toContain(dave.wallet);
	});

	it('skips claimed KeyPackages it cannot verify (the relayer is not trusted)', async () => {
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone');
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone');
		const mallory = await open(relayer, Ed25519Keypair.generate(), 'mallory-phone');
		// The relayer relabels Mallory's KeyPackages as Bob's.
		for (const k of relayer.kps) if (k.wallet === mallory.wallet) k.wallet = bob.wallet;
		await alice.session.createGroup(GROUP, [bob.wallet]);
		const wallets = alice.session.members(GROUP).map((m) => m.certificate?.wallet);
		expect(wallets).toContain(bob.wallet);
		expect(wallets).not.toContain(mallory.wallet);
	});

	it('resyncs a device that fell behind the log and keeps reading', async () => {
		const { relayer, alice, bob, readers } = await pair();
		const carol = await open(relayer, Ed25519Keypair.generate(), 'carol-phone');
		// Bob's state is set back one epoch (e.g. restored from a stale backup).
		const stale = bob.store;
		const snapshot = (await stale.loadDevice())!;
		await alice.session.addWallets(GROUP, [carol.wallet]);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, new Set([...readers, carol.wallet]), inner('a')));
		await bob.session.sync(GROUP);
		await stale.saveDevice(snapshot); // roll the MLS state back...
		const bob2 = await open(relayer, bob.signer, 'bob-phone', stale);
		await alice.session.addWallets(GROUP, []); // no-op
		await alice.session.reconcile(GROUP, new Set([...readers, carol.wallet]));
		// ...and an epoch passes that bob2 (now behind) can't follow.
		await carol.session.acceptWelcomes();
		const dave = await open(relayer, Ed25519Keypair.generate(), 'dave-phone');
		await alice.session.addWallets(GROUP, [dave.wallet]);
		const all = new Set([...readers, carol.wallet, dave.wallet]);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, all, inner('after gap')));
		await bob2.session.sync(GROUP); // detects the gap, rejoins by external commit
		expect(bob2.session.groupState(GROUP)).toBe('member');
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, all, inner('back')));
		expect(textOf(await bob2.session.sync(GROUP))).toContain('back');
		// Exactly one leaf for Bob's device: the rejoin replaced the old one.
		const bobKey = bob2.session.certificate.mls_key;
		expect(alice.session.members(GROUP).filter((m) => m.certificate?.mls_key === bobKey)).toHaveLength(1);
	});

	it('resolves a commit whose response was lost by checking the log', async () => {
		const { relayer, alice, bob, readers } = await pair();
		const carol = await open(relayer, Ed25519Keypair.generate(), 'carol-phone');
		relayer.failAfterAccept = true;
		// Accepted, response lost: the session finds its commit in the log and carries on.
		expect(await alice.session.addWallets(GROUP, [carol.wallet])).toBe(1);
		expect(await carol.session.acceptWelcomes()).toEqual([GROUP]); // Welcome still sent
		const all = new Set([...readers, carol.wallet]);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, all, inner('still here')));
		expect(textOf(await bob.session.sync(GROUP))).toContain('still here');
		expect(textOf(await carol.session.sync(GROUP))).toContain('still here');
	});

	it('recovers when the commit landed but neither the response nor the log was reachable', async () => {
		const { relayer, alice, bob, readers } = await pair();
		const carol = await open(relayer, Ed25519Keypair.generate(), 'carol-phone');
		relayer.failAfterAccept = true;
		relayer.fetchFailures = 1; // the log check fails too
		await expect(alice.session.addWallets(GROUP, [carol.wallet])).rejects.toThrow('network timeout');
		// Alice rolled back, the relayer kept her commit. Bob (second-lowest leaf) applies it and
		// republishes GroupInfo; Alice's next send detects her own unapplied commit and resyncs.
		await bob.session.sync(GROUP);
		const all = new Set([...readers, carol.wallet]);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, all, inner('still here')));
		expect(textOf(await bob.session.sync(GROUP))).toContain('still here');
		// Carol's Welcome was never posted; she gets in on her own (her old leaf is replaced).
		expect(await carol.session.ensureGroup(GROUP)).toBe(true);
		await alice.session.sync(GROUP);
		expect(alice.session.members(GROUP).filter((m) => m.certificate?.wallet === carol.wallet)).toHaveLength(1);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, all, inner('hi carol')));
		expect(textOf(await carol.session.sync(GROUP))).toContain('hi carol');
		expect(alice.session.members(GROUP).filter((m) => m.certificate?.mls_key === alice.session.certificate.mls_key)).toHaveLength(1);
	});

	it('rejoins after being removed while still an on-chain reader; stays out once removed on-chain', async () => {
		let bobIsReader = true;
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone');
		const bobKp = Ed25519Keypair.generate();
		const bobWallet = bobKp.toMySoAddress().toLowerCase();
		const onChainReaders = async () => new Set([alice.wallet, ...(bobIsReader ? [bobWallet] : [])]);
		const bob = await open(relayer, bobKp, 'bob-phone', undefined, undefined, { onChainReaders });
		await alice.session.createGroup(GROUP, [bob.wallet]);
		await bob.session.acceptWelcomes();
		// Alice wrongly drops Bob (e.g. a buggy client); Bob is still a reader on-chain.
		await alice.session.reconcile(GROUP, new Set([alice.wallet]));
		await bob.session.sync(GROUP);
		expect(bob.session.hasGroup(GROUP)).toBe(true); // rejoined
		await alice.session.sync(GROUP);
		relayer.append(GROUP, alice.wallet, 'message', await alice.session.seal(GROUP, new Set([alice.wallet, bob.wallet]), inner('hi again')));
		expect(textOf(await bob.session.sync(GROUP))).toContain('hi again');
		// Removed on-chain: removal sticks and Bob forgets the group.
		bobIsReader = false;
		await alice.session.reconcile(GROUP, new Set([alice.wallet]));
		await bob.session.sync(GROUP);
		expect(bob.session.hasGroup(GROUP)).toBe(false);
	});

	it('picks up a Welcome on demand while running', async () => {
		const relayer = new FakeRelayer(mls);
		let clock = 1_000_000;
		const now = () => clock;
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice-phone');
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob-phone', undefined, undefined, { now });
		expect(await bob.session.ensureGroup(GROUP)).toBe(false); // no group yet (no GroupInfo)
		await alice.session.createGroup(GROUP, [bob.wallet]);
		clock += 10_000;
		expect(await bob.session.ensureGroup(GROUP)).toBe(true); // Welcome taken, not an external join
		// Alice's claim + add; Bob joined from the Welcome (no external commit of his).
		const commits = (relayer.rows.get(GROUP) ?? []).filter((r) => r.kind === 'commit');
		expect(commits.map((r) => r.senderAddress)).toEqual([alice.wallet, alice.wallet]);
	});

	it('logging out removes the device from its own self-group', async () => {
		const relayer = new FakeRelayer(mls);
		const kp = Ed25519Keypair.generate();
		const phone = await open(relayer, kp, 'phone');
		const laptop = await open(relayer, kp, 'laptop');
		await phone.session.ensureSelfGroup();
		await laptop.session.ensureSelfGroup();
		await phone.session.syncSelf();
		expect(phone.session.members(`self:${phone.wallet}`)).toHaveLength(2);
		await laptop.session.logout([]);
		await phone.session.syncSelf(); // commits the laptop's self-remove
		expect(phone.session.members(`self:${phone.wallet}`)).toHaveLength(1);
	});

	it('two first devices racing to create the self-group end up in one group', async () => {
		const relayer = new FakeRelayer(mls);
		const kp = Ed25519Keypair.generate();
		const a = await open(relayer, kp, 'a');
		const b = await open(relayer, kp, 'b');
		await Promise.all([a.session.ensureSelfGroup(), b.session.ensureSelfGroup()]);
		await a.session.syncSelf();
		await b.session.syncSelf();
		expect(a.session.members(`self:${a.wallet}`)).toHaveLength(2);
		expect(b.session.members(`self:${a.wallet}`)).toHaveLength(2);
	});

	it('MLS group setup is race-safe: one creator wins, everyone ends up in one group', async () => {
		const relayer = new FakeRelayer(mls);
		const kps = [Ed25519Keypair.generate(), Ed25519Keypair.generate(), Ed25519Keypair.generate()];
		const wallets = kps.map((k) => k.toMySoAddress().toLowerCase());
		const onChainReaders = async () => new Set(wallets);
		const devices = await Promise.all(
			kps.map((k, i) => open(relayer, k, `d${i}`, undefined, undefined, { onChainReaders })),
		);
		// All three try to set the group up at once (e.g. the creator's setup never finished and
		// two members opened the chat).
		const results = await Promise.all(devices.map((d) => d.session.createGroup(GROUP, wallets)));
		expect(results.every(Boolean)).toBe(true);
		for (const d of devices) {
			await d.session.acceptWelcomes();
			await d.session.sync(GROUP);
		}
		const readers = new Set(wallets);
		relayer.append(GROUP, devices[0]!.wallet, 'message', await devices[0]!.session.seal(GROUP, readers, inner('one group')));
		for (const d of devices.slice(1)) {
			expect((await d.session.sync(GROUP)).map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''))).toContain('one group');
		}
		const keys = devices[0]!.session.members(GROUP).map((m) => m.certificate?.mls_key);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(3);
	});

	it('a member sets the group up on demand when the creator never did', async () => {
		const relayer = new FakeRelayer(mls);
		const a = Ed25519Keypair.generate();
		const b = Ed25519Keypair.generate();
		const wallets = [a, b].map((k) => k.toMySoAddress().toLowerCase());
		const onChainReaders = async () => new Set(wallets);
		const bob = await open(relayer, b, 'bob', undefined, undefined, { onChainReaders });
		const alice = await open(relayer, a, 'alice', undefined, undefined, { onChainReaders });
		// The on-chain group is `mls1`, but its creator's MLS setup never ran. Bob opens it.
		expect(await bob.session.ensureGroup(GROUP)).toBe(true);
		expect(await alice.session.ensureGroup(GROUP)).toBe(true); // takes Bob's Welcome
		relayer.append(GROUP, bob.wallet, 'message', await bob.session.seal(GROUP, new Set(wallets), inner('hi')));
		expect((await alice.session.sync(GROUP)).length).toBe(1);
	});

	it('a late setup attempt never forks a group that already has commits', async () => {
		const relayer = new FakeRelayer(mls);
		const alice = await open(relayer, Ed25519Keypair.generate(), 'alice');
		const bob = await open(relayer, Ed25519Keypair.generate(), 'bob');
		await alice.session.createGroup(GROUP, [bob.wallet]);
		relayer.infos.delete(GROUP); // GroupInfo lost: bob can't see it's set up
		const epoch = relayer.epochs.get(GROUP);
		expect(await bob.session.createGroup(GROUP, [alice.wallet])).toBe(true); // took his Welcome
		expect(relayer.epochs.get(GROUP)).toBe(epoch); // no second epoch-0 claim got in
	});
});
