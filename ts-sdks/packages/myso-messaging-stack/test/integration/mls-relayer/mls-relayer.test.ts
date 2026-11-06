// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live multi-device MLS run (E2EE M6): real `myso-mls` WASM devices talking through the real
 * relayer (production router, auth, signature checks, one-commit-per-epoch) over HTTP. Only the
 * chain is replaced: group membership is seeded into the test server and changed through its
 * `/__test/members` hook, standing in for on-chain MemberAdded / MemberRemoved.
 *
 * Prereqs: `cargo build --example mls_e2e_server` (relayer/) and `wasm-pack build mls --target
 * nodejs --out-dir pkg-node`. Run: `pnpm test:mls-relayer`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { Signer } from '@socialproof/myso/cryptography';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HTTPRelayerTransport } from '../../../src/relayer/http-transport.js';
import { HttpMlsRelayer } from '../../../src/mls/relayer.js';
import { createCertificateVerifier, MlsSession } from '../../../src/mls/session.js';
import { MemoryMlsStateStore, type MlsWasmModule } from '../../../src/mls/types.js';
import { signMessageContent } from '../../../src/verification.js';

const root = new URL('../../../../../../', import.meta.url).pathname;
const serverBin = `${root}relayer/target/debug/examples/mls_e2e_server`;
const wasmPath = `${root}mls/pkg-node/myso_mls.js`;
const ready = existsSync(serverBin) && existsSync(wasmPath);
const GROUP = '0x' + 'e2'.repeat(32);

describe.skipIf(!ready)('MLS through the real relayer', () => {
	const wasm = (ready ? createRequire(import.meta.url)(wasmPath) : null) as MlsWasmModule;
	let server: ChildProcess;
	let url = '';
	let transport: HTTPRelayerTransport;
	let relayer: HttpMlsRelayer;

	const alice = Ed25519Keypair.generate();
	const bob = Ed25519Keypair.generate();
	const carol = Ed25519Keypair.generate();
	const addr = (k: Signer) => k.toMySoAddress().toLowerCase();
	const members = new Set([addr(alice), addr(bob)]);

	const setMembers = async (change: { add?: string[]; remove?: string[] }) => {
		await fetch(`${url}/__test/members`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ group: GROUP, ...change }),
		});
		for (const a of change.add ?? []) members.add(a);
		for (const r of change.remove ?? []) members.delete(r);
	};

	beforeAll(async () => {
		server = spawn(serverBin, [], {
			env: { ...process.env, MLS_E2E_MEMBERS: `${GROUP}=${addr(alice)},${addr(bob)}`, RUST_LOG: 'warn' },
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		const port = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('relayer did not start')), 30_000);
			server.stdout!.on('data', (chunk: Buffer) => {
				const m = /MLS_E2E_READY (\d+)/.exec(chunk.toString());
				if (m) {
					clearTimeout(timer);
					resolve(m[1]!);
				}
			});
			server.on('exit', (code) => reject(new Error(`relayer exited ${code}`)));
		});
		url = `http://127.0.0.1:${port}`;
		transport = new HTTPRelayerTransport({ relayerUrl: url, apiPrefix: '/v1' });
		relayer = new HttpMlsRelayer({ relayerUrl: url, transport });
	});

	afterAll(() => {
		transport?.disconnect?.();
		server?.kill();
	});

	const verifyCertificate = () =>
		createCertificateVerifier((c) => wasm.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms));

	async function device(signer: Ed25519Keypair, deviceId: string, store = new MemoryMlsStateStore()) {
		const session = await MlsSession.open({
			wasm,
			store,
			relayer,
			signer,
			deviceId,
			verifyCertificate: verifyCertificate(),
			verifyRow: async () => true,
			onChainReaders: async () => new Set(members),
			keyPackageTarget: 3,
		});
		return { session, store, signer };
	}

	const inner = (text: string) => ({
		nonce: new Uint8Array(12).fill(7),
		keyVersion: 1n,
		ciphertext: new TextEncoder().encode(text.padEnd(40, '.')),
	});
	const texts = (rows: { encryptedText: Uint8Array }[]) =>
		rows.map((r) => new TextDecoder().decode(r.encryptedText).replace(/\.+$/, ''));

	/** Post an MLS application message as a signed `message` row (what the client's send does). */
	async function send(from: { session: MlsSession; signer: Signer }, text: string) {
		const mls = await from.session.seal(GROUP, new Set(members), inner(text));
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const messageSignature = await signMessageContent(from.signer, {
			groupId: GROUP,
			kind: 'message',
			encryptedText: mls,
			nonce,
			keyVersion: 1n,
		});
		await transport.sendMessage({
			signer: from.signer,
			groupId: GROUP,
			encryptedText: mls,
			nonce,
			keyVersion: 1n,
			kind: 'message',
			messageSignature,
		});
	}

	it('runs two members, a second device, history sync, a commit race, removal and logout', async () => {
		const alicePhone = await device(alice, 'alice-phone');
		const bobPhone = await device(bob, 'bob-phone');

		// Create + Welcome through the relayer.
		await alicePhone.session.createGroup(GROUP, [addr(bob)]);
		expect(await bobPhone.session.acceptWelcomes()).toEqual([GROUP]);
		await send(alicePhone, 'hello bob');
		expect(texts(await bobPhone.session.sync(GROUP))).toEqual(['hello bob']);
		await send(bobPhone, 'hi alice');
		expect(texts(await alicePhone.session.sync(GROUP))).toEqual(['hi alice']);

		// The relayer can't be talked into a second commit for the same epoch.
		const epochRows = async () =>
			(await transport.fetchMessages({ signer: alice, groupId: GROUP, limit: 200 })).messages.filter(
				(r) => r.kind === 'commit',
			).length;
		const commitsBefore = await epochRows();

		// Bob's new laptop: own-device history over the self-group, then joins the chat on its own.
		await bobPhone.session.storeOwn(GROUP, {
			...(await transport.fetchMessages({ signer: bob, groupId: GROUP, limit: 200 })).messages.at(-1)!,
			encryptedText: inner('hi alice').ciphertext,
			senderVerified: true,
		});
		await bobPhone.session.ensureSelfGroup();
		const bobLaptop = await device(bob, 'bob-laptop');
		await bobLaptop.session.ensureSelfGroup();
		await bobPhone.session.syncSelf(); // sees the join, sends history
		await bobLaptop.session.syncSelf();
		const synced = await bobLaptop.store.listRows(GROUP, { limit: 50 });
		expect(texts(synced)).toEqual(['hello bob', 'hi alice']);
		expect(await bobLaptop.session.ensureGroup(GROUP)).toBe(true); // external commit
		await send(alicePhone, 'hello laptop');
		expect(texts(await bobLaptop.session.sync(GROUP))).toContain('hello laptop');
		expect(texts(await bobPhone.session.sync(GROUP))).toContain('hello laptop');

		// Carol becomes a member "on-chain"; Alice and Bob race to add her. One commit wins the
		// epoch (the other gets 409, catches up, and finds nothing left to add).
		await setMembers({ add: [addr(carol)] });
		const carolPhone = await device(carol, 'carol-phone');
		const [a, b] = await Promise.all([
			alicePhone.session.addWallets(GROUP, [addr(carol)]),
			bobPhone.session.addWallets(GROUP, [addr(carol)]),
		]);
		expect(a + b).toBeGreaterThanOrEqual(1);
		await carolPhone.session.ensureGroup(GROUP);
		await send(alicePhone, 'welcome carol');
		expect(texts(await carolPhone.session.sync(GROUP))).toContain('welcome carol');
		expect(await epochRows()).toBeGreaterThan(commitsBefore);
		// Everyone agrees on the member list: exactly one leaf per device.
		await bobPhone.session.sync(GROUP);
		await alicePhone.session.sync(GROUP);
		const keys = alicePhone.session.members(GROUP).map((m) => m.certificate?.mls_key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toHaveLength(4);

		// Bob leaves on-chain: Alice's next send removes both his devices first.
		await setMembers({ remove: [addr(bob)] });
		await send(alicePhone, 'bob is gone');
		expect(alicePhone.session.members(GROUP).map((m) => m.certificate?.wallet)).not.toContain(addr(bob));
		expect(texts(await carolPhone.session.sync(GROUP))).toContain('bob is gone');
		// Off-chain now: the relayer won't even serve him the log.
		await expect(bobPhone.session.sync(GROUP)).rejects.toThrow(/not a member/);
		// Bob's devices can't read it.
		expect(texts(await bobLaptop.store.listRows(GROUP, { limit: 50 }))).not.toContain('bob is gone');

		// Carol logs out: her self-remove proposal is committed by Alice's next send.
		await carolPhone.session.logout([GROUP]);
		await send(alicePhone, 'just me');
		expect(alicePhone.session.members(GROUP)).toHaveLength(1);
	});

	it('a device restored from stale state resyncs through the relayer', async () => {
		const g = GROUP; // same group: Alice is alone in it after the first test; Carol comes back
		await setMembers({ add: [addr(carol)] });
		const alicePhone2 = await device(alice, 'alice-tablet');
		expect(await alicePhone2.session.ensureGroup(g)).toBe(true);
		const carolTab = await device(carol, 'carol-tab');
		expect(await carolTab.session.ensureGroup(g)).toBe(true);
		const stale = (await carolTab.store.loadDevice())!;
		await send(alicePhone2, 'one');
		await carolTab.session.sync(g);
		// An epoch passes: Carol's second device is added.
		const carolOther = await device(carol, 'carol-other');
		await alicePhone2.session.addWallets(g, [addr(carol)]);
		await carolOther.session.ensureGroup(g);
		await carolTab.session.sync(g); // the tab applies that commit; its cursor moves past it
		// The tab restarts with MLS state from before the commit but the newer cursor: it can
		// never apply that commit again (a real gap, e.g. a crash between two writes).
		await carolTab.store.saveDevice(stale);
		const restarted = await device(carol, 'carol-tab', carolTab.store);
		await send(alicePhone2, 'after the gap');
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
		try {
			await restarted.session.sync(g); // gap detected: external rejoin via the relayer's GroupInfo
		} finally {
			console.warn = warn;
		}
		expect(warnings.some((w) => w.includes('resyncing'))).toBe(true);
		await send(alicePhone2, 'back again');
		expect(texts(await restarted.session.sync(g))).toContain('back again');
		await alicePhone2.session.sync(g);
		const keys = alicePhone2.session.members(g).map((m) => m.certificate?.mls_key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('three members setting up a new mls1 group at once end up in one MLS group', async () => {
		const g2 = '0x' + 'e3'.repeat(32);
		const people = [Ed25519Keypair.generate(), Ed25519Keypair.generate(), Ed25519Keypair.generate()];
		const wallets = people.map(addr);
		await fetch(`${url}/__test/members`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ group: g2, add: wallets }),
		});
		const devs = await Promise.all(people.map((p, i) => device(p, `g2-${i}`)));
		const ok = await Promise.all(devs.map((d) => d.session.createGroup(g2, wallets)));
		expect(ok.every(Boolean)).toBe(true);
		for (const d of devs) await d.session.sync(g2);
		const mls = await devs[1]!.session.seal(g2, new Set(wallets), inner('race won once'));
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const messageSignature = await signMessageContent(devs[1]!.signer, { groupId: g2, kind: 'message', encryptedText: mls, nonce, keyVersion: 1n });
		await transport.sendMessage({ signer: devs[1]!.signer, groupId: g2, encryptedText: mls, nonce, keyVersion: 1n, kind: 'message', messageSignature });
		for (const d of [devs[0]!, devs[2]!]) expect(texts(await d.session.sync(g2))).toContain('race won once');
		const keys = devs[0]!.session.members(g2).map((m) => m.certificate?.mls_key);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(3);
	});

	it('passkey backup round-trips through the real relayer and can be deleted', async () => {
		const kp = Ed25519Keypair.generate();
		const prf = new Uint8Array(32).fill(0x5c);
		const a = await device(kp, 'backup-a');
		const g = '0x' + 'e4'.repeat(32);
		await a.session.storeOwn(g, {
			messageId: 'b1', groupId: g, order: 1, encryptedText: inner('kept').ciphertext, nonce: new Uint8Array(12),
			keyVersion: 1n, senderAddress: addr(kp), createdAt: 1, updatedAt: 1, attachments: [], isEdited: false,
			isDeleted: false, signature: '', publicKey: '', isAgentMessage: false, kind: 'message', senderVerified: true,
		});
		expect((await a.session.enableBackup(prf)).backedUp).toBe(1);
		const b = await device(kp, 'backup-b');
		expect((await b.session.enableBackup(prf)).restored).toBe(1);
		expect(texts(await b.store.listRows(g, { limit: 10 }))).toEqual(['kept']);
		await b.session.disableBackup({ deleteRemote: true });
		const c = await device(kp, 'backup-c');
		expect((await c.session.enableBackup(prf)).restored).toBe(0);
	});
});
