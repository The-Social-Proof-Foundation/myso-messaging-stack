// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// Hosted MLS devices (agents via MCP): leased, sealed, write-through state on the real WASM.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import {
	deriveHostedSealKey,
	HostedMlsLeaseLostError,
	withHostedMlsStore,
	type HostedMlsLeaseBackend,
} from '../../src/mls/hosted-store.js';
import { createCertificateVerifier, MlsSession } from '../../src/mls/session.js';
import type { MlsWasmModule } from '../../src/mls/types.js';
import { FakeRelayer } from './support/fake-mls-relayer.js';

const pkg = new URL('../../../../../mls/pkg-node/myso_mls.js', import.meta.url).pathname;
const wasm = existsSync(pkg) ? (createRequire(import.meta.url)(pkg) as MlsWasmModule) : null;
const GROUP = '0x' + 'a9'.repeat(32);

/** Same rules as the memory server's lease table. */
class FakeLeaseServer implements HostedMlsLeaseBackend {
	token: string | null = null;
	version = 0;
	blob: Uint8Array | null = null;
	writes = 0;
	async acquire() {
		if (this.token) return null;
		this.token = crypto.randomUUID();
		return { token: this.token, version: this.version, blob: this.blob };
	}
	async write(token: string, expected: number, blob: Uint8Array) {
		if (token !== this.token || expected !== this.version) return null;
		this.blob = blob;
		this.writes++;
		return ++this.version;
	}
	async renew(token: string) {
		return token === this.token;
	}
	async release(token: string) {
		if (token === this.token) this.token = null;
	}
	takeOver() {
		this.token = 'someone-else';
	}
}

describe('hosted MLS store', () => {
	const kp = Ed25519Keypair.generate();
	const sign = (m: Uint8Array) => kp.sign(m);
	const owner = kp.toMySoAddress();

	it('derives a stable seal key and refuses a non-deterministic signer', async () => {
		await deriveHostedSealKey(sign, owner, 'mcp-x');
		let n = 0;
		const flaky = async (m: Uint8Array) => new Uint8Array([...(await kp.sign(m)).slice(0, 63), n++]);
		await expect(deriveHostedSealKey(flaky, owner, 'mcp-x')).rejects.toThrow(/not deterministic/);
	});

	it('seals state (the server only sees ciphertext), one holder at a time, and stops when the lease is lost', async () => {
		const server = new FakeLeaseServer();
		const sealKey = await deriveHostedSealKey(sign, owner, 'mcp-x');
		await withHostedMlsStore({ backend: server, sealKey, owner, deviceId: 'mcp-x' }, async (store) => {
			await store.setMeta('marker', 'secret-value');
			// A second instance can't get in meanwhile.
			await expect(
				withHostedMlsStore({ backend: server, sealKey, owner, deviceId: 'mcp-x', waitMs: 50 }, async () => 1),
			).rejects.toThrow(/busy/);
		});
		expect(server.token).toBeNull(); // released
		expect(new TextDecoder().decode(server.blob!)).not.toContain('secret-value');
		await withHostedMlsStore({ backend: server, sealKey, owner, deviceId: 'mcp-x' }, async (store) => {
			expect(await store.getMeta('marker')).toBe('secret-value');
			server.takeOver();
			await expect(store.saveDevice({ snapshot: new Uint8Array([1]), deviceId: 'mcp-x' })).rejects.toBeInstanceOf(HostedMlsLeaseLostError);
		}).catch((e) => expect(e).toBeInstanceOf(HostedMlsLeaseLostError));
	});
});

describe.skipIf(!wasm)('hosted MLS device with a real session', () => {
	const mls = wasm!;
	const verifyCertificate = createCertificateVerifier((c) => mls.mlsCertificateCanonical(c.wallet, c.device_id, c.mls_key, c.issued_at_ms));
	const inner = (t: string) => ({ nonce: new Uint8Array(12).fill(4), keyVersion: 1n, ciphertext: new TextEncoder().encode(t.padEnd(32, '.')) });

	it('two instances take turns on one agent device: state carries over, nothing forks', async () => {
		const relayer = new FakeRelayer(mls);
		const human = await MlsSession.open({ wasm: mls, store: new (await import('../../src/mls/types.js')).MemoryMlsStateStore(), relayer, signer: Ed25519Keypair.generate(), deviceId: 'human', verifyCertificate, verifyRow: async () => true });
		const agentKp = Ed25519Keypair.generate();
		const agent = agentKp.toMySoAddress().toLowerCase();
		const server = new FakeLeaseServer();
		const sealKey = await deriveHostedSealKey((m) => agentKp.sign(m), agent, 'mcp-agent');
		const run = <T>(fn: (s: MlsSession) => Promise<T>) =>
			withHostedMlsStore({ backend: server, sealKey, owner: agent, deviceId: 'mcp-agent' }, async (store) =>
				fn(await MlsSession.open({ wasm: mls, store, relayer, signer: agentKp, deviceId: 'mcp-agent', verifyCertificate, verifyRow: async () => true })),
			);
		// Instance 1 creates the agent device (publishes KeyPackages) and returns.
		const cert1 = await run(async (s) => s.certificate);
		await human.createGroup(GROUP, [agent]);
		// Instance 2 (fresh process) restores the same device, joins and sends.
		const cert2 = await run(async (s) => {
			expect(await s.ensureGroup(GROUP)).toBe(true);
			relayer.append(GROUP, agent, 'message', await s.seal(GROUP, new Set([human.wallet, agent]), inner('from mcp')));
			return s.certificate;
		});
		expect(cert2.mls_key).toBe(cert1.mls_key); // same device, not a new one
		expect((await human.sync(GROUP)).length).toBe(1);
		// Instance 3 sends again from the persisted ratchet state; the human reads both in order.
		await run(async (s) => {
			relayer.append(GROUP, agent, 'message', await s.seal(GROUP, new Set([human.wallet, agent]), inner('again')));
		});
		expect((await human.sync(GROUP)).length).toBe(1);
		expect(human.members(GROUP)).toHaveLength(2); // one agent leaf, never duplicated
		expect(server.writes).toBeGreaterThan(2);
	});
});
