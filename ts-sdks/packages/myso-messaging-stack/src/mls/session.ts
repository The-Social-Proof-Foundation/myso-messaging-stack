// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { toHex } from '@socialproof/myso/utils';

import { signAndCreateAuthHeaders } from '../relayer/auth-headers.js';
import type { RelayerMessage } from '../relayer/types.js';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

import {
	BACKUP_SEGMENT_PLAINTEXT_BYTES,
	deriveBackupKey,
	openBackupSegment,
	sealBackupSegment,
	type MessageBackupKey,
} from './backup.js';
import { CertificateCache, type CertificateVerifier } from './certificates.js';
import {
	issueCertificateV2,
	type ChainMlsDeviceRegistry,
	type MlsDeviceRecord,
	type MlsRegistrySubmitter,
} from './registry.js';
import { MlsGroupUnavailableError, MlsMembersUnverifiedError } from './errors.js';
import type { MlsRelayer } from './relayer.js';
import {
	decodeInner,
	decodeRowsJson,
	encodeInner,
	encodeRowsJson,
	type MlsDeviceCertificate,
	type MlsMember,
	type MlsStateStore,
	type MlsWasmDevice,
	type MlsWasmGroup,
	type MlsWasmModule,
	type UnwrappedRow,
} from './types.js';

export { createCertificateVerifier } from './certificates.js';
export type { CertificateVerifier } from './certificates.js';

const utf8 = new TextEncoder();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

const MAX_COMMIT_ATTEMPTS = 4;
const SYNC_PAGE = 100;
/** Welcomes are polled at most this often per session (on demand, not on a timer). */
const WELCOME_POLL_MS = 5_000;
/** After a failed external join / resync, wait this long before trying that group again. */
const JOIN_BACKOFF_MS = 30_000;
/** Resyncs per group per hour, so a peer that keeps removing us can't put us in a loop. */
const MAX_RESYNCS_PER_HOUR = 3;

export interface MlsSessionOptions {
	wasm: MlsWasmModule;
	store: MlsStateStore;
	relayer: MlsRelayer;
	/** The messaging key: signs relayer rows (commits, history events). */
	signer: Signer;
	/**
	 * Who this device belongs to: the account the groups list as a member, signing the device
	 * certificate and wallet-auth routes. For zkLogin this is the zkLogin account (its signatures
	 * wrap the ephemeral key's in the proof), not the ephemeral key. Defaults to `signer`.
	 */
	identity?: Signer;
	/** Stable per-install id (new installs get a new MLS device). */
	deviceId: string;
	verifyCertificate: CertificateVerifier;
	/** Verifies a row's wallet signature (the client's sender verification). */
	verifyRow: (row: RelayerMessage) => Promise<boolean>;
	/**
	 * Lowercase wallets holding MessagingReader on-chain. Lets the session tell "removed because
	 * we left the group on-chain" from "removed / fell out of sync while still a member" (resync).
	 */
	onChainReaders?: (groupId: string) => Promise<Set<string>>;
	/** KeyPackages to keep published. */
	keyPackageTarget?: number;
	/**
	 * Days of recent history to share with members who join `groupId` (on-chain
	 * `data["e2ee_history_days"]`); 0 / undefined = off.
	 */
	historyShareDays?: (groupId: string) => Promise<number>;
	/** Rows per group sent to a new own device (self-group history sync). */
	historyRowsPerGroup?: number;
	/** Clock (tests). */
	now?: () => number;
	/**
	 * On-chain device registry (certificate renewal). Without it the device keeps its v1
	 * certificate. `submitter` executes registry transactions (sponsored); without one the device
	 * still verifies others' v2 certificates but can't register / renew itself.
	 */
	registry?: {
		chain: Pick<ChainMlsDeviceRegistry, 'lookup' | 'registerTx' | 'rotateTx' | 'revokeByDeviceTx'>;
		submitter?: MlsRegistrySubmitter;
		/** Rotate the authority key after this long (default 90 days). */
		rotateAfterMs?: number;
	};
}

/**
 * Where this device's certificate stands (from {@link MlsSession.maintain}):
 * - `off`: no registry configured (v1 certificate).
 * - `unregistered`: not registered yet (e.g. the account couldn't sign now); retried later.
 * - `current`: registered, v2 certificate issued and pushed to every group.
 * - `revoked`: revoked on-chain. The app must log this device out of MLS; its id can't come back.
 * - `conflict`: the registry holds another key for this device id (state lost / another install).
 *   Treat like `revoked`: log out and start a new device.
 */
export type MlsRenewalState = 'off' | 'unregistered' | 'current' | 'revoked' | 'conflict';

const ROTATE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** A history bundle: unwrapped rows per group. */
interface HistoryBundle {
	v: 1;
	groups: Record<string, UnwrappedRow[]>;
}

interface Inspected {
	kind: string;
	groupId?: string;
	epoch?: number;
}

/** Where a group stands on this device (UI + diagnostics). */
export type MlsGroupState = 'member' | 'not-member' | 'resyncing' | 'desynced';

/**
 * One device's MLS state across all its groups (E2EE M4–M6). Single writer: callers must not run
 * two sessions for the same device concurrently (web: Web Locks; iOS: app only, never the NSE).
 */
export class MlsSession {
	readonly #o: MlsSessionOptions;
	readonly #id: Signer;
	readonly #certs: CertificateCache;
	#device: MlsWasmDevice;
	#groups = new Map<string, MlsWasmGroup>();
	#reassemblers = new Map<string, { push(p: Uint8Array): { bundleId: string; payload: Uint8Array } | undefined }>();
	#lastWelcomePoll = 0;
	#joinBackoff = new Map<string, number>();
	#resyncs = new Map<string, number[]>();
	#desynced = new Set<string>();
	/** Serializes every state-mutating operation (one writer even within a tab). */
	#queue: Promise<unknown> = Promise.resolve();
	readonly wallet: string;

	private constructor(options: MlsSessionOptions, device: MlsWasmDevice) {
		this.#o = options;
		this.#id = options.identity ?? options.signer;
		this.#certs = new CertificateCache(
			options.verifyCertificate,
			options.store,
			options.registry
				? {
						verifySignature: (json) => options.wasm.mlsVerifyCertificateV2(json),
						registry: options.registry.chain,
						now: options.now,
					}
				: undefined,
		);
		this.#device = device;
		this.wallet = this.#id.toMySoAddress().toLowerCase();
	}

	#now() {
		return this.#o.now?.() ?? Date.now();
	}

	/** Run `fn` after every earlier mutation finished (re-entrant calls must use the `#…` forms). */
	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Restore this device, or create it: fresh MLS key, wallet-signed certificate, KeyPackages. */
	static async open(options: MlsSessionOptions): Promise<MlsSession> {
		const identity = options.identity ?? options.signer;
		const wallet = identity.toMySoAddress().toLowerCase();
		const saved = await options.store.loadDevice();
		if (saved && saved.deviceId === options.deviceId) {
			const device = options.wasm.MlsDevice.restore(saved.snapshot);
			const session = new MlsSession(options, device);
			// A device certified for another account (e.g. state from before the zkLogin identity
			// fix) can never be authorized: start over as a new device.
			if (session.certificate.wallet.toLowerCase() === wallet) return session;
			device.free?.();
			await options.store.clear();
		}
		const keys = options.wasm.MlsDeviceKeys.generate();
		const cert = await MlsSession.#certify(identity, options, toHex(keys.publicKey()));
		const device = options.wasm.MlsDevice.fromKeys(keys, utf8.encode(JSON.stringify(cert)));
		const session = new MlsSession(options, device);
		await session.#certs.trust(cert);
		await session.#persist();
		await session.publishKeyPackages();
		return session;
	}

	static async #certify(identity: Signer, options: MlsSessionOptions, mlsKeyHex: string): Promise<MlsDeviceCertificate> {
		const wallet = identity.toMySoAddress().toLowerCase();
		const issued = Date.now();
		const canonical = options.wasm.mlsCertificateCanonical(wallet, options.deviceId, mlsKeyHex, issued);
		const auth = await signAndCreateAuthHeaders(identity, utf8.encode(canonical));
		return {
			v: 1,
			wallet,
			device_id: options.deviceId,
			mls_key: mlsKeyHex,
			issued_at_ms: issued,
			sig: auth['x-signature']!,
			signer_key: auth['x-public-key']!,
		};
	}

	get certificate(): MlsDeviceCertificate {
		return JSON.parse(new TextDecoder().decode(this.#device.identity())) as MlsDeviceCertificate;
	}

	get deviceId(): string {
		return this.#o.deviceId;
	}

	async #persist() {
		await this.#o.store.saveDevice({ snapshot: this.#device.snapshot(), deviceId: this.#o.deviceId });
	}

	/** Back to `snapshot` (a rejected or failed commit). Frees the abandoned in-memory state. */
	#rollback(snapshot: Uint8Array) {
		for (const g of this.#groups.values()) g.free?.();
		this.#groups.clear();
		this.#device.free?.();
		this.#device = this.#o.wasm.MlsDevice.restore(snapshot);
	}

	#group(groupId: string): MlsWasmGroup | null {
		const key = groupId.toLowerCase();
		const cached = this.#groups.get(key);
		if (cached) return cached;
		const loaded = this.#device.loadGroup(utf8.encode(key));
		if (loaded) {
			this.#groups.set(key, loaded);
			void this.#rememberGroup(key);
		}
		return loaded ?? null;
	}

	#setGroup(groupId: string, group: MlsWasmGroup) {
		const key = groupId.toLowerCase();
		const old = this.#groups.get(key);
		if (old && old !== group) old.free?.();
		this.#groups.set(key, group);
		void this.#rememberGroup(key);
	}

	/** Ids of MLS groups this device has joined (renewal pushes credentials to each). */
	async #knownGroups(): Promise<string[]> {
		await this.#remembering;
		return this.#readKnownGroups();
	}

	async #readKnownGroups(): Promise<string[]> {
		try {
			return JSON.parse((await this.#o.store.getMeta('groups')) ?? '[]') as string[];
		} catch {
			return [];
		}
	}

	#remembering: Promise<void> = Promise.resolve();

	/** Serialized read-modify-write so concurrent calls never drop an id. */
	#rememberGroup(key: string): Promise<void> {
		this.#remembering = this.#remembering.then(async () => {
			const known = await this.#readKnownGroups();
			if (!known.includes(key)) await this.#o.store.setMeta('groups', JSON.stringify([...known, key]));
		}).catch(() => {});
		return this.#remembering;
	}

	#inspect(bytes: Uint8Array): Inspected | null {
		try {
			const info = JSON.parse(this.#o.wasm.mlsInspect(bytes)) as { kind: string; group_id?: string; groupId?: string; epoch?: number };
			return { kind: info.kind, groupId: info.group_id ?? info.groupId, epoch: info.epoch === undefined ? undefined : Number(info.epoch) };
		} catch {
			return null;
		}
	}

	/** In the group with an active leaf. */
	hasGroup(groupId: string): boolean {
		const group = this.#group(groupId);
		return group !== null && group.isActive();
	}

	groupState(groupId: string): MlsGroupState {
		const key = groupId.toLowerCase();
		if (this.#desynced.has(key)) return 'desynced';
		return this.hasGroup(key) ? 'member' : 'not-member';
	}

	members(groupId: string): MlsMember[] {
		const group = this.#group(groupId);
		return group ? (JSON.parse(group.membersJson()) as MlsMember[]) : [];
	}

	/** My leaf index in `group` (by my certificate's MLS key). */
	#myLeaf(group: MlsWasmGroup): number | undefined {
		const key = this.certificate.mls_key;
		return (JSON.parse(group.membersJson()) as MlsMember[]).find((m) => m.certificate?.mls_key === key)?.leafIndex;
	}

	/**
	 * One responder per change: the lowest-index member among those that were already in the group.
	 * Keeps a join from triggering one history copy per existing device.
	 */
	#isResponder(before: MlsMember[], group: MlsWasmGroup): boolean {
		const mine = this.#myLeaf(group);
		if (mine === undefined || before.length === 0) return false;
		return mine === Math.min(...before.map((m) => m.leafIndex));
	}

	#reassembler(key: string) {
		let r = this.#reassemblers.get(key);
		if (!r) {
			r = new this.#o.wasm.MlsHistoryReassembler();
			this.#reassemblers.set(key, r);
		}
		return r;
	}

	async publishKeyPackages(count = this.#o.keyPackageTarget ?? 10) {
		const kps = Array.from({ length: count }, () => this.#device.keyPackage());
		await this.#persist();
		await this.#o.relayer.putKeyPackages(this.#id, this.#o.deviceId, this.certificate, kps);
	}

	// === Commits ===

	/**
	 * Post a control row; resolve an ambiguous failure (timeout, dropped response) by looking for
	 * our exact bytes in the log. `true` accepted, `false` lost the epoch (409 or someone else's
	 * commit is there). Throws only when even the log can't be read; the caller then rolls back
	 * and the next sync resyncs if the commit did land.
	 */
	async #postCommit(groupId: string, commit: Uint8Array): Promise<boolean> {
		try {
			return await this.#o.relayer.postControlRow(this.#o.signer, groupId, commit);
		} catch (error) {
			const found = await this.#findInLog(groupId, commit).catch(() => undefined);
			if (found === undefined) throw error;
			return found;
		}
	}

	/** Whether `bytes` were accepted into the group log after our cursor. */
	async #findInLog(groupId: string, bytes: Uint8Array): Promise<boolean> {
		let cursor = await this.#o.store.getCursor(groupId);
		for (;;) {
			const page = await this.#o.relayer.fetchRows(this.#o.signer, groupId, cursor, SYNC_PAGE);
			for (const row of page.messages) {
				cursor = Math.max(cursor, row.order);
				if (row.kind === 'commit' && sameBytes(row.encryptedText, bytes)) return true;
			}
			if (!page.hasNext || page.messages.length === 0) return false;
		}
	}

	/**
	 * Post a commit built by `build`. On 409 (another commit won the epoch) roll back, catch up and
	 * rebuild. An ambiguous failure is resolved against the log; if even that fails, roll back and
	 * rethrow (a commit that did land is then detected by the next sync, which resyncs).
	 * `afterAccept` runs once the relayer accepted it.
	 */
	async #commit(
		groupId: string,
		build: (group: MlsWasmGroup) => { commit: Uint8Array; afterAccept?: () => Promise<void> } | null,
	): Promise<boolean> {
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			const before = this.#device.snapshot();
			const group = this.#group(groupId);
			if (!group?.isActive()) throw new Error(`not an MLS member of ${groupId}`);
			const built = build(group);
			if (!built) return false;
			let accepted: boolean;
			try {
				accepted = await this.#postCommit(groupId, built.commit);
			} catch (error) {
				this.#rollback(before);
				throw error;
			}
			if (accepted) {
				this.#desynced.delete(groupId.toLowerCase());
				await this.#persist();
				await built.afterAccept?.();
				await this.#publishGroupInfo(groupId);
				return true;
			}
			this.#rollback(before);
			await this.#sync(groupId);
		}
		throw new Error(`MLS commit for ${groupId} kept losing the epoch race`);
	}

	async #publishGroupInfo(groupId: string) {
		const group = this.#group(groupId);
		if (!group) return;
		await this.#o.relayer.postGroupInfo(this.#id, groupId, group.groupInfo(this.#device)).catch(() => {});
	}

	// === Group lifecycle ===

	/**
	 * Set up the MLS group for an on-chain `mls1` group and add every device of `memberWallets`.
	 * Race-safe: the first device to claim epoch 0 (a commit) creates it; anyone who loses joins
	 * the winner's group by external commit. Returns whether this device is a member afterwards.
	 */
	createGroup(groupId: string, memberWallets: string[]): Promise<boolean> {
		return this.#exclusive(() => this.#bootstrap(groupId.toLowerCase(), memberWallets));
	}

	async #bootstrap(key: string, memberWallets: string[]): Promise<boolean> {
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			if (this.hasGroup(key) && !this.#desynced.has(key)) {
				await this.#addWallets(key, memberWallets).catch(() => 0);
				return true;
			}
			// Already added (pending Welcome)? Then it's set up and we're in.
			await this.#acceptWelcomes().catch(() => []);
			if (this.hasGroup(key) && !this.#desynced.has(key)) continue;
			if (await this.#o.relayer.getGroupInfo(this.#id, key)) {
				return this.#joinExternal(key); // already set up: join it
			}
			// Nobody has set it up (no GroupInfo). Claim epoch 0 before publishing anything: the
			// relayer accepts exactly one commit for it, and refuses ours if the group already has
			// commits (so this can never fork an existing group).
			const before = this.#device.snapshot();
			this.#device.deleteGroup(utf8.encode(key));
			this.#groups.delete(key);
			const group = this.#device.createGroup(utf8.encode(key));
			const claim = group.selfUpdate(this.#device);
			let accepted: boolean;
			try {
				accepted = await this.#postCommit(key, claim);
			} catch (error) {
				group.free?.();
				this.#rollback(before);
				throw error;
			}
			if (accepted) {
				this.#setGroup(key, group);
				this.#desynced.delete(key);
				await this.#persist();
				await this.#publishGroupInfo(key);
				await this.#addWallets(key, memberWallets);
				return true;
			}
			group.free?.();
			this.#rollback(before);
			// Someone else claimed it; their GroupInfo follows right after their claim.
			await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
		}
		return false;
	}

	/** Add every published device of `wallets` (claims one KeyPackage per device). */
	addWallets(groupId: string, wallets: string[]): Promise<number> {
		return this.#exclusive(() => this.#addWallets(groupId.toLowerCase(), wallets));
	}

	async #addWallets(groupId: string, wallets: string[]): Promise<number> {
		const wanted = new Set(wallets.map((w) => w.toLowerCase()));
		const claimed = await this.#o.relayer.claimKeyPackages(this.#id, [...wanted]);
		const present = new Set(this.members(groupId).map((m) => m.certificate?.mls_key));
		// Verify every claimed KeyPackage ourselves: the relayer is not trusted to vouch for them.
		const usable: ((typeof claimed)[number] & { mlsKey: string })[] = [];
		for (const c of claimed) {
			if (c.wallet === this.wallet && c.deviceId === this.#o.deviceId) continue;
			const raw = this.#o.wasm.mlsKeyPackageCertificate(c.keyPackage);
			if (!raw) continue;
			let cert: MlsDeviceCertificate;
			try {
				cert = JSON.parse(raw) as MlsDeviceCertificate;
			} catch {
				continue;
			}
			if (cert.wallet.toLowerCase() !== c.wallet.toLowerCase() || cert.device_id !== c.deviceId) continue;
			if (!wanted.has(cert.wallet.toLowerCase()) || present.has(cert.mls_key)) continue;
			// `unknown` devices aren't added now; they join by external commit once verifiable.
			if ((await this.#certs.status(cert)) !== 'valid') continue;
			usable.push({ ...c, mlsKey: cert.mls_key });
		}
		if (usable.length === 0) return 0;
		let added = 0;
		await this.#commit(groupId, (group) => {
			// Re-check on every attempt: after a lost race (409 → catch up) another member may
			// already have added some of these devices; re-adding would duplicate their key.
			const inGroup = new Set((JSON.parse(group.membersJson()) as MlsMember[]).map((m) => m.certificate?.mls_key));
			const todo = usable.filter((c) => !inGroup.has(c.mlsKey));
			added = todo.length;
			if (todo.length === 0) return null;
			const out = group.addMembers(this.#device, todo.map((c) => c.keyPackage));
			return {
				commit: out.commit,
				afterAccept: () =>
					this.#o.relayer.postWelcome(
						this.#id,
						groupId,
						todo.map((c) => ({ wallet: c.wallet, deviceId: c.deviceId })),
						out.welcome,
					),
			};
		});
		return added;
	}

	/** Join groups this device was added to. Returns the group ids. */
	acceptWelcomes(): Promise<string[]> {
		return this.#exclusive(() => this.#acceptWelcomes());
	}

	async #acceptWelcomes(): Promise<string[]> {
		this.#lastWelcomePoll = this.#now();
		const welcomes = await this.#o.relayer.takeWelcomes(this.#id, this.#o.deviceId);
		const joined: string[] = [];
		for (const w of welcomes) {
			const key = w.groupId.toLowerCase();
			if (this.hasGroup(key)) continue; // already in (e.g. joined externally meanwhile)
			try {
				this.#device.deleteGroup(utf8.encode(key)); // stale inactive state, if any
				this.#groups.delete(key);
				this.#setGroup(key, this.#device.join(w.welcome));
				this.#desynced.delete(key);
				joined.push(key);
			} catch {
				// Stale / not for this device's KeyPackage: ignore.
			}
		}
		if (joined.length) {
			await this.#persist();
			await this.publishKeyPackages(joined.length);
		}
		return joined;
	}

	/** New device of an existing member: join on our own from the published GroupInfo (M5). */
	joinExternal(groupId: string): Promise<boolean> {
		return this.#exclusive(() => this.#joinExternal(groupId.toLowerCase()));
	}

	async #joinExternal(key: string): Promise<boolean> {
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			const info = await this.#o.relayer.getGroupInfo(this.#id, key);
			if (!info) return false;
			const before = this.#device.snapshot();
			// `rejoinExternal` also drops any stale local state and replaces our old leaf.
			const join = this.#device.rejoinExternal(info);
			const group = join.takeGroup();
			this.#groups.delete(key);
			let accepted: boolean;
			try {
				accepted = await this.#postCommit(key, join.commit);
			} catch (error) {
				group.free?.();
				this.#rollback(before);
				throw error;
			}
			if (accepted) {
				this.#setGroup(key, group);
				this.#desynced.delete(key);
				// Rows before our join are unreadable to us by design; start the cursor at the tail
				// so sync doesn't walk (and try to decrypt) the whole earlier log.
				await this.#persist();
				await this.#publishGroupInfo(key);
				return true;
			}
			group.free?.();
			this.#rollback(before); // GroupInfo was stale; fetch the newer one.
		}
		return false;
	}

	/**
	 * Make sure this device is in `groupId`'s MLS group: pick up a pending Welcome, else join by
	 * external commit (new device, cleared storage, or fell out of sync). Throttled; safe to call
	 * on every read. Returns whether the device is a member afterwards.
	 */
	ensureGroup(groupId: string): Promise<boolean> {
		return this.#exclusive(async () => {
			const key = groupId.toLowerCase();
			if (this.hasGroup(key) && !this.#desynced.has(key)) return true;
			if (this.#now() - this.#lastWelcomePoll >= WELCOME_POLL_MS) {
				await this.#acceptWelcomes().catch(() => []);
				if (this.hasGroup(key) && !this.#desynced.has(key)) return true;
			}
			if ((this.#joinBackoff.get(key) ?? 0) > this.#now()) return false;
			// Join it, or set it up if no one has yet (e.g. the creator's setup never finished).
			const readers = this.#o.onChainReaders ? await this.#o.onChainReaders(key).catch(() => null) : null;
			const ok = await (readers && readers.has(this.wallet)
				? this.#bootstrap(key, [...readers])
				: this.#joinExternal(key)
			).catch(() => false);
			if (!ok) this.#joinBackoff.set(key, this.#now() + JOIN_BACKOFF_MS);
			return ok;
		});
	}

	/** Resync budget: at most {@link MAX_RESYNCS_PER_HOUR} per group. */
	#mayResync(key: string): boolean {
		const hourAgo = this.#now() - 3_600_000;
		const recent = (this.#resyncs.get(key) ?? []).filter((t) => t > hourAgo);
		this.#resyncs.set(key, recent);
		if (recent.length >= MAX_RESYNCS_PER_HOUR) return false;
		if ((this.#joinBackoff.get(key) ?? 0) > this.#now()) return false;
		recent.push(this.#now());
		return true;
	}

	/**
	 * This device fell out of step with the group (missed or unappliable commit, or removed while
	 * still an on-chain reader): rejoin by external commit. Returns whether it worked.
	 */
	async #resync(key: string, why: string): Promise<boolean> {
		this.#desynced.add(key);
		if (!this.#mayResync(key)) return false;
		if (this.#o.onChainReaders) {
			const readers = await this.#o.onChainReaders(key).catch(() => null);
			if (readers && !readers.has(this.wallet)) {
				// Left on-chain: removal is correct. Forget the group locally.
				this.#device.deleteGroup(utf8.encode(key));
				this.#groups.delete(key);
				this.#desynced.delete(key);
				await this.#persist();
				return false;
			}
		}
		console.warn(`[mls] resyncing ${key.slice(0, 10)}…: ${why}`);
		const ok = await this.#joinExternal(key).catch(() => false);
		if (!ok) this.#joinBackoff.set(key, this.#now() + JOIN_BACKOFF_MS);
		return ok;
	}

	// === Membership rule ===

	/**
	 * Membership rule: every leaf must be a verified certificate of an on-chain reader.
	 * - No certificate, wallet not an on-chain reader, or `invalid`: removed before sending.
	 * - `unknown` (unverifiable right now): kept, but the send pauses with
	 *   {@link MlsMembersUnverifiedError} — never encrypt to a leaf we couldn't verify.
	 * Also commits pending proposals (e.g. logouts).
	 */
	reconcile(groupId: string, onChainReaders: Set<string>): Promise<void> {
		return this.#exclusive(() => this.#reconcile(groupId.toLowerCase(), onChainReaders));
	}

	async #reconcile(key: string, onChainReaders: Set<string>): Promise<void> {
		const readers = new Set([...onChainReaders].map((r) => r.toLowerCase()));
		const bad: number[] = [];
		const unknown = new Set<string>();
		const myKey = this.certificate.mls_key;
		const group = this.#group(key);
		const mine = group ? this.#myLeaf(group) : undefined;
		for (const m of this.members(key)) {
			if (m.leafIndex === mine) continue;
			const cert = m.certificate;
			if (!cert || !readers.has(cert.wallet.toLowerCase()) || cert.mls_key === myKey) {
				bad.push(m.leafIndex); // includes a stale duplicate of our own leaf
				continue;
			}
			const status = await this.#certs.status(cert);
			if (status === 'invalid') bad.push(m.leafIndex);
			else if (status === 'unknown') unknown.add(cert.wallet.toLowerCase());
		}
		if (bad.length > 0) {
			await this.#commit(key, (g) => ({ commit: g.removeLeaves(this.#device, Uint32Array.from(bad)) }));
		}
		await this.#commit(key, (g) => {
			const commit = g.commitPending(this.#device);
			return commit ? { commit } : null;
		});
		if (unknown.size > 0) throw new MlsMembersUnverifiedError(key, [...unknown]);
	}

	/**
	 * Membership rule, then encrypt, as one step: nothing (e.g. a commit adding a device) can land
	 * between the check and the encryption. Throws {@link MlsMembersUnverifiedError} when paused.
	 */
	seal(
		groupId: string,
		onChainReaders: Set<string>,
		inner: { nonce: Uint8Array; keyVersion: bigint; ciphertext: Uint8Array },
	): Promise<Uint8Array> {
		return this.#exclusive(async () => {
			const key = groupId.toLowerCase();
			await this.#sync(key); // apply pending commits first, so we check the real member list
			if (this.#desynced.has(key)) throw new MlsGroupUnavailableError(key, 'not-joined');
			await this.#reconcile(key, onChainReaders);
			const group = this.#group(key);
			if (!group?.isActive()) throw new Error(`not an MLS member of ${groupId}`);
			const out = group.encrypt(this.#device, encodeInner(inner));
			await this.#persist();
			return out;
		});
	}

	/** Seal a DEK-sealed inner row as an MLS application message. Prefer {@link seal}. */
	wrap(groupId: string, inner: { nonce: Uint8Array; keyVersion: bigint; ciphertext: Uint8Array }): Promise<Uint8Array> {
		return this.#exclusive(async () => {
			const group = this.#group(groupId);
			if (!group?.isActive()) throw new Error(`not an MLS member of ${groupId}`);
			if (this.#desynced.has(groupId.toLowerCase())) throw new MlsGroupUnavailableError(groupId, 'not-joined');
			const out = group.encrypt(this.#device, encodeInner(inner));
			await this.#persist();
			return out;
		});
	}

	/** Keep our own sent row (MLS never decrypts our own messages back to us). */
	async storeOwn(groupId: string, row: UnwrappedRow) {
		await this.#o.store.putRows(groupId.toLowerCase(), [row]);
	}

	// === Reading ===

	/**
	 * Process the group log forward from the saved cursor, strictly in order. Application messages
	 * are unwrapped to their inner DEK rows and stored; returns the newly stored rows. A commit we
	 * can't apply, or traffic from an epoch ahead of ours, means this device fell out of sync: it
	 * resyncs by external commit and carries on from there.
	 */
	sync(groupId: string): Promise<UnwrappedRow[]> {
		return this.#exclusive(() => this.#sync(groupId.toLowerCase()));
	}

	async #sync(key: string): Promise<UnwrappedRow[]> {
		const out: UnwrappedRow[] = [];
		let resynced = false;
		const startEpoch = this.#group(key)?.epoch();
		try {
			return await this.#syncLoop(key, out, () => resynced, () => (resynced = true));
		} finally {
			// The epoch moved: make sure the relayer's GroupInfo is current, or external joins
			// (new devices, resyncs) stall. Normally the committer does this; if its response was
			// lost it never did. One member (the lowest leaf) republishes; the relayer keeps only
			// the current epoch's copy, so this is idempotent.
			const group = this.#group(key);
			if (group?.isActive() && startEpoch !== undefined && group.epoch() !== startEpoch) {
				// The two lowest leaves: if the committer is the lowest and lost its response, the
				// second still covers it.
				const leaves = (JSON.parse(group.membersJson()) as MlsMember[]).map((m) => m.leafIndex).sort((a, b) => a - b);
				const mine = this.#myLeaf(group);
				if (mine !== undefined && leaves.slice(0, 2).includes(mine)) await this.#publishGroupInfo(key);
			}
		}
	}

	async #syncLoop(
		key: string,
		out: UnwrappedRow[],
		hasResynced: () => boolean,
		markResynced: () => void,
	): Promise<UnwrappedRow[]> {
		for (;;) {
			let group = this.#group(key);
			if (!group?.isActive()) return out;
			const cursor = await this.#o.store.getCursor(key);
			const page = await this.#o.relayer.fetchRows(this.#o.signer, key, cursor, SYNC_PAGE);
			const fresh: UnwrappedRow[] = [];
			let last = cursor;
			let shareDays = 0;
			let stop = false;
			for (const row of page.messages) {
				if (row.kind === 'system' || row.isDeleted) {
					last = Math.max(last, row.order);
					continue;
				}
				const info = this.#inspect(row.encryptedText);
				if (!info || (info.groupId !== undefined && info.groupId.toLowerCase() !== key)) {
					last = Math.max(last, row.order); // not an MLS message for this group
					continue;
				}
				const epoch = Number(group.epoch());
				const ahead = info.epoch !== undefined && info.epoch > epoch;
				const before = info.kind === 'commit' ? (JSON.parse(group.membersJson()) as MlsMember[]) : null;
				const result = ahead ? { ok: false as const } : await this.#processRow(group, row, key);
				const failedCommit = !result.ok && info.kind === 'commit' && info.epoch === epoch;
				const removed = result.ok && info.kind === 'commit' && !group.isActive();
				if (ahead || failedCommit || removed) {
					// Persist what we have so far, then resync and re-read from this row on.
					if (fresh.length) await this.#o.store.putRows(key, fresh);
					out.push(...fresh);
					fresh.length = 0;
					await this.#persist();
					await this.#o.store.setCursor(key, last);
					const why = ahead ? `row at epoch ${info.epoch}, we're at ${epoch}` : removed ? 'removed while a member' : `commit at epoch ${epoch} failed`;
					if (hasResynced() || !(await this.#resync(key, why))) return out;
					markResynced();
					group = this.#group(key)!;
					stop = true; // refetch from the cursor with the new group state
					break;
				}
				last = Math.max(last, row.order);
				if (result.ok && result.row) fresh.push(result.row);
				if (before && result.ok) {
					const had = new Set(before.map((m) => m.certificate?.wallet));
					const newcomer = (JSON.parse(group.membersJson()) as MlsMember[]).some(
						(m) => !had.has(m.certificate?.wallet),
					);
					if (newcomer && this.#isResponder(before, group)) {
						shareDays = (await this.#o.historyShareDays?.(key)) ?? 0;
					}
				}
			}
			if (stop) continue;
			if (fresh.length) await this.#o.store.putRows(key, fresh);
			await this.#persist();
			await this.#o.store.setCursor(key, last);
			out.push(...fresh);
			if (shareDays > 0) await this.#shareRecent(key, shareDays).catch(() => {});
			if (!page.hasNext || page.messages.length === 0) return out;
		}
	}

	/**
	 * `ok: false` = MLS refused the message. Expected for rows from before we joined and our own
	 * echoes; a desync only when it's a commit at our current epoch (decided by the caller).
	 */
	async #processRow(
		group: MlsWasmGroup,
		row: RelayerMessage,
		groupKey: string,
	): Promise<{ ok: true; row?: UnwrappedRow } | { ok: false }> {
		let processed;
		try {
			processed = group.process(this.#device, row.encryptedText);
		} catch {
			return { ok: false };
		}
		// Our own message fanned back. Harmless for application rows; for a commit the caller
		// checks the epoch (a commit of ours at our *current* epoch was never applied here).
		if (processed.kind === 'own') return row.kind === 'commit' ? { ok: false } : { ok: true };
		if (processed.kind !== 'application' || !processed.plaintext || !processed.senderIdentity) return { ok: true };
		const inner = decodeInner(processed.plaintext);
		if (!inner) {
			// Not a chat row: a "share recent history" chunk from another member.
			const bundle = this.#reassembler(groupKey).push(processed.plaintext);
			if (bundle) await this.#importBundle(bundle.payload, { trusted: false, onlyGroup: groupKey });
			return { ok: true };
		}
		let senderWallet = '';
		try {
			senderWallet = (JSON.parse(new TextDecoder().decode(processed.senderIdentity)) as MlsDeviceCertificate).wallet;
		} catch {
			// Non-certificate identity: never verified.
		}
		const senderVerified =
			senderWallet.toLowerCase() === row.senderAddress.toLowerCase() && (await this.#o.verifyRow(row));
		return {
			ok: true,
			row: { ...row, encryptedText: inner.ciphertext, nonce: inner.nonce, keyVersion: inner.keyVersion, senderVerified },
		};
	}

	/** Locally stored rows (newest `limit` before `before`), ready for DEK decryption. */
	async rows(groupId: string, options: { before?: number; limit: number }): Promise<UnwrappedRow[]> {
		return this.#o.store.listRows(groupId.toLowerCase(), options);
	}

	// === History ===

	/**
	 * Store rows from a history bundle. Own-device bundles keep their verification; bundles shared
	 * by another member are marked unverified (any member could forge DEK-sealed rows) and never
	 * overwrite a copy we already hold.
	 */
	async #importBundle(payload: Uint8Array, options: { trusted: boolean; onlyGroup?: string }): Promise<number> {
		let bundle: HistoryBundle;
		try {
			bundle = decodeRowsJson<HistoryBundle>(payload);
		} catch {
			return 0;
		}
		if (bundle?.v !== 1 || typeof bundle.groups !== 'object' || bundle.groups === null) return 0;
		let imported = 0;
		for (const [groupId, rows] of Object.entries(bundle.groups)) {
			const key = groupId.toLowerCase();
			if (key.startsWith('self:')) continue;
			if (options.onlyGroup && key !== options.onlyGroup) continue;
			if (!Array.isArray(rows)) continue;
			const candidates = rows.filter(
				(r) =>
					r &&
					typeof r.messageId === 'string' &&
					typeof r.order === 'number' &&
					typeof r.groupId === 'string' &&
					r.groupId.toLowerCase() === key &&
					r.encryptedText instanceof Uint8Array,
			);
			if (candidates.length === 0) continue;
			const have = await this.#o.store.hasRows(key, candidates);
			const fresh = candidates
				.filter((r) => !have.has(`${r.order}:${r.messageId}`))
				.map((r) => ({ ...r, senderVerified: options.trusted ? r.senderVerified === true : false }));
			if (fresh.length) await this.#o.store.putRows(key, fresh);
			imported += fresh.length;
		}
		return imported;
	}

	/** Share the last `days` of `groupId` with newly joined members (opt-in per group). */
	async #shareRecent(groupId: string, days: number) {
		const group = this.#group(groupId);
		if (!group?.isActive()) return;
		const since = this.#now() / 1000 - days * 86_400;
		const rows = (await this.#o.store.listRows(groupId, { limit: 2_000 })).filter((r) => r.createdAt >= since);
		if (rows.length === 0) return;
		const payload = encodeRowsJson({ v: 1, groups: { [groupId]: rows } } satisfies HistoryBundle);
		for (const chunk of this.#o.wasm.mlsHistorySplit(crypto.randomUUID(), payload)) {
			await this.#o.relayer.postAppRow(this.#o.signer, groupId, group.encrypt(this.#device, chunk));
			await this.#persist();
		}
	}

	// === Self-group: this wallet's own devices (history sync, M5/M6) ===

	get #selfId(): string {
		return `self:${this.wallet}`;
	}

	/** Join (or create) this wallet's self-group. A joining device triggers a history send. */
	ensureSelfGroup(): Promise<void> {
		return this.#exclusive(async () => {
			if (this.hasGroup(this.#selfId)) return;
			for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
				const info = await this.#o.relayer.getSelfGroupInfo(this.#id);
				const before = this.#device.snapshot();
				if (!info) {
					const group = this.#device.createGroup(utf8.encode(this.#selfId));
					// First device: claim epoch 0 in the log so two first devices can't both create it.
					const claim = group.selfUpdate(this.#device);
					if (!(await this.#o.relayer.postSelfMessage(this.#id, claim))) {
						group.free?.();
						this.#rollback(before);
						continue; // another device created it first: join that one
					}
					this.#setGroup(this.#selfId, group);
					await this.#persist();
					await this.#o.relayer.putSelfGroupInfo(this.#id, group.groupInfo(this.#device));
					return;
				}
				const join = this.#device.rejoinExternal(info);
				const group = join.takeGroup();
				this.#groups.delete(this.#selfId);
				if (await this.#o.relayer.postSelfMessage(this.#id, join.commit)) {
					this.#setGroup(this.#selfId, group);
					await this.#persist();
					await this.#o.relayer.putSelfGroupInfo(this.#id, group.groupInfo(this.#device)).catch(() => {});
					return;
				}
				group.free?.();
				this.#rollback(before);
			}
		});
	}

	async #selfCommit(build: (group: MlsWasmGroup) => Uint8Array | undefined | null): Promise<boolean> {
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			const before = this.#device.snapshot();
			const group = this.#group(this.#selfId);
			if (!group?.isActive()) return false;
			const commit = build(group);
			if (!commit) return false;
			let ok: boolean;
			try {
				ok = await this.#o.relayer.postSelfMessage(this.#id, commit);
			} catch (error) {
				this.#rollback(before);
				throw error;
			}
			if (ok) {
				await this.#persist();
				const g = this.#group(this.#selfId);
				if (g) await this.#o.relayer.putSelfGroupInfo(this.#id, g.groupInfo(this.#device)).catch(() => {});
				return true;
			}
			this.#rollback(before);
			await this.#syncSelfLog();
		}
		return false;
	}

	/** Process the self-group log: history chunks from my other devices, and joins that need history. */
	syncSelf(): Promise<void> {
		return this.#exclusive(async () => {
			const sendHistory = await this.#syncSelfLog();
			const group = this.#group(this.#selfId);
			if (!group?.isActive()) return;
			// Membership rule for own devices: only this wallet's verified devices; commit logouts.
			const bad: number[] = [];
			let unknown = false;
			const mine = this.#myLeaf(group);
			for (const m of this.members(this.#selfId)) {
				if (m.leafIndex === mine) continue;
				const cert = m.certificate;
				if (!cert || cert.wallet.toLowerCase() !== this.wallet || cert.mls_key === this.certificate.mls_key) {
					bad.push(m.leafIndex);
					continue;
				}
				const status = await this.#certs.status(cert);
				if (status === 'invalid') bad.push(m.leafIndex);
				else if (status === 'unknown') unknown = true;
			}
			if (bad.length) await this.#selfCommit((g) => g.removeLeaves(this.#device, Uint32Array.from(bad))).catch(() => false);
			await this.#selfCommit((g) => g.commitPending(this.#device)).catch(() => false);
			// History only goes to devices we could verify.
			if (sendHistory && !unknown) await this.#sendOwnHistory();
		});
	}

	/** Returns whether a device joined and this one should answer with history. */
	async #syncSelfLog(): Promise<boolean> {
		const group = this.#group(this.#selfId);
		if (!group?.isActive()) return false;
		let cursor = await this.#o.store.getCursor(this.#selfId);
		let sendHistory = false;
		for (;;) {
			const items = await this.#o.relayer.fetchSelf(this.#id, cursor, SYNC_PAGE);
			for (const item of items) {
				cursor = Math.max(cursor, item.seq);
				const before = JSON.parse(group.membersJson()) as MlsMember[];
				let processed;
				try {
					processed = group.process(this.#device, item.body);
				} catch {
					continue; // before this device joined, or our own echo
				}
				if (processed.kind === 'commit') {
					if (!group.isActive()) {
						// Removed from our own self-group (e.g. another device logged this one out).
						await this.#persist();
						await this.#o.store.setCursor(this.#selfId, cursor);
						return false;
					}
					const after = JSON.parse(group.membersJson()) as MlsMember[];
					const prevKeys = new Set(before.map((m) => m.certificate?.mls_key));
					const joinedNew = after.some((m) => !prevKeys.has(m.certificate?.mls_key));
					if (joinedNew && this.#isResponder(before, group)) sendHistory = true;
				} else if (processed.kind === 'application' && processed.plaintext) {
					const bundle = this.#reassembler(this.#selfId).push(processed.plaintext);
					if (bundle) await this.#importBundle(bundle.payload, { trusted: true });
				}
			}
			await this.#persist();
			await this.#o.store.setCursor(this.#selfId, cursor);
			if (items.length < SYNC_PAGE) break;
		}
		return sendHistory;
	}

	/** Send my stored history to my other devices over the self-group. */
	sendOwnHistory(): Promise<void> {
		return this.#exclusive(() => this.#sendOwnHistory());
	}

	async #sendOwnHistory(): Promise<void> {
		const group = this.#group(this.#selfId);
		if (!group?.isActive()) return;
		const perGroup = this.#o.historyRowsPerGroup ?? 500;
		const bundle: HistoryBundle = { v: 1, groups: {} };
		for (const id of await this.#o.store.groupIds()) {
			if (id.startsWith('self:')) continue;
			const rows = await this.#o.store.listRows(id, { limit: perGroup });
			if (rows.length) bundle.groups[id] = rows;
		}
		if (Object.keys(bundle.groups).length === 0) return;
		for (const chunk of this.#o.wasm.mlsHistorySplit(crypto.randomUUID(), encodeRowsJson(bundle))) {
			await this.#o.relayer.postSelfMessage(this.#id, group.encrypt(this.#device, chunk));
			await this.#persist();
		}
	}

	// === Passkey message backup (M8) ===

	/** The backup key this device holds (sealed in the store), or `null` if backup is off here. */
	async backupKey(): Promise<MessageBackupKey | null> {
		const raw = await this.#o.store.getMeta('backup-key');
		if (!raw) return null;
		try {
			const key = JSON.parse(raw) as MessageBackupKey;
			return key.keyId && key.keyHex ? key : null;
		} catch {
			return null;
		}
	}

	/**
	 * Turn backup on with the passkey's PRF output (salt {@link backupPrfSalt}): derive and keep
	 * the key on this device, restore anything already backed up under it, then back up what this
	 * device holds. Returns rows restored + backed up.
	 */
	enableBackup(prf: Uint8Array): Promise<{ restored: number; backedUp: number; keyId: string }> {
		return this.#exclusive(async () => {
			if (!this.#o.relayer.putBackupSegment) throw new Error('relayer has no backup support');
			const key = await deriveBackupKey(prf, this.wallet);
			await this.#o.store.setMeta('backup-key', JSON.stringify(key));
			const restored = await this.#restoreBackup(key);
			const backedUp = await this.#backupNow(key);
			return { restored, backedUp, keyId: key.keyId };
		});
	}

	/** Upload rows this device holds that aren't backed up yet (no-op when backup is off). */
	backupNow(): Promise<number> {
		return this.#exclusive(async () => {
			const key = await this.backupKey();
			return key ? this.#backupNow(key) : 0;
		});
	}

	/** Import every backed-up row (e.g. on a new device, after `enableBackup`). */
	restoreBackup(): Promise<number> {
		return this.#exclusive(async () => {
			const key = await this.backupKey();
			return key ? this.#restoreBackup(key) : 0;
		});
	}

	/** Turn backup off on this device; with `deleteRemote`, also delete the backup itself. */
	disableBackup(options: { deleteRemote?: boolean } = {}): Promise<void> {
		return this.#exclusive(async () => {
			const key = await this.backupKey();
			if (key && options.deleteRemote) await this.#o.relayer.deleteBackup?.(this.#id, key.keyId);
			if (key) await this.#o.store.setMeta(`backup-cursor:${key.keyId}`, null);
			await this.#o.store.setMeta('backup-key', null);
		});
	}

	async #backupNow(key: MessageBackupKey): Promise<number> {
		const put = this.#o.relayer.putBackupSegment?.bind(this.#o.relayer);
		if (!put) return 0;
		const cursorKey = `backup-cursor:${key.keyId}`;
		let cursor: Record<string, number> = {};
		try {
			cursor = JSON.parse((await this.#o.store.getMeta(cursorKey)) ?? '{}') as Record<string, number>;
		} catch {
			cursor = {};
		}
		let segment: Record<string, UnwrappedRow[]> = {};
		let size = 0;
		let total = 0;
		const flush = async () => {
			const groups = Object.keys(segment);
			if (groups.length === 0) return;
			const payload = encodeRowsJson({ v: 1, groups: segment });
			await put(this.#id, key.keyId, await sealBackupSegment(key, this.wallet, payload));
			// Advance only after the upload landed (a crash re-uploads; restore de-duplicates).
			for (const g of groups) cursor[g] = Math.max(cursor[g] ?? 0, ...segment[g]!.map((r) => r.order));
			await this.#o.store.setMeta(cursorKey, JSON.stringify(cursor));
			segment = {};
			size = 0;
		};
		for (const groupId of await this.#o.store.groupIds()) {
			if (groupId.startsWith('self:')) continue;
			const after = cursor[groupId] ?? 0;
			const rows = (await this.#o.store.listRows(groupId, { limit: 1_000_000 })).filter((r) => r.order > after);
			for (const row of rows) {
				const rowSize = encodeRowsJson(row).length;
				if (size + rowSize > BACKUP_SEGMENT_PLAINTEXT_BYTES && size > 0) await flush();
				(segment[groupId] ??= []).push(row);
				size += rowSize;
				total++;
			}
		}
		await flush();
		return total;
	}

	async #restoreBackup(key: MessageBackupKey): Promise<number> {
		const list = this.#o.relayer.listBackupSegments?.bind(this.#o.relayer);
		if (!list) return 0;
		let after = 0;
		let imported = 0;
		const backedUp: Record<string, number> = {};
		for (;;) {
			const page = await list(this.#id, key.keyId, after, 20);
			for (const item of page) {
				after = Math.max(after, item.seq);
				const payload = await openBackupSegment(key, this.wallet, item.body);
				if (!payload) continue; // not under this key, or tampered
				imported += await this.#importBundle(payload, { trusted: true });
				try {
					const bundle = decodeRowsJson<HistoryBundle>(payload);
					for (const [g, rows] of Object.entries(bundle.groups ?? {})) {
						for (const r of rows) backedUp[g.toLowerCase()] = Math.max(backedUp[g.toLowerCase()] ?? 0, r.order);
					}
				} catch {
					// already skipped by importBundle
				}
			}
			if (page.length < 20) break;
		}
		// Don't upload again what the backup already holds.
		const cursorKey = `backup-cursor:${key.keyId}`;
		let cursor: Record<string, number> = {};
		try {
			cursor = JSON.parse((await this.#o.store.getMeta(cursorKey)) ?? '{}') as Record<string, number>;
		} catch {
			cursor = {};
		}
		for (const [g, order] of Object.entries(backedUp)) cursor[g] = Math.max(cursor[g] ?? 0, order);
		await this.#o.store.setMeta(cursorKey, JSON.stringify(cursor));
		return imported;
	}

	// === Certificate renewal (on-chain device registry) ===

	async #loadAuthority(slot: 'authority' | 'authority-pending'): Promise<Ed25519Keypair | null> {
		const secret = await this.#o.store.getMeta(slot);
		return secret ? Ed25519Keypair.fromSecretKey(secret) : null;
	}

	async #saveAuthority(slot: 'authority' | 'authority-pending', key: Ed25519Keypair | null) {
		await this.#o.store.setMeta(slot, key ? key.getSecretKey() : null);
	}

	static #pub(key: Ed25519Keypair): string {
		return toHex(key.getPublicKey().toRawBytes());
	}

	async #lookupSelf(attempts = 1): Promise<MlsDeviceRecord | null> {
		for (let i = 0; ; i++) {
			const record = await this.#o.registry!.chain.lookup(this.wallet, this.#o.deviceId);
			if (record || i >= attempts - 1) return record;
			await new Promise((r) => setTimeout(r, 1_000 * (i + 1))); // fullnode catching up
		}
	}

	/**
	 * Keep this device's certificate current, with no account signature after the first time:
	 * 1. Register the device's authority key once (the account signs; gas sponsored).
	 * 2. Rotate the authority key every `rotateAfterMs` (the device signs; old key keeps verifying
	 *    for the on-chain grace period).
	 * 3. Issue a v2 certificate under the current authority key, republish KeyPackages, and commit
	 *    the renewed credential into every group whose leaf still has an older one.
	 * Idempotent and crash-safe (a pending rotation is resolved against the chain next time).
	 * Throws only when the chain can't be read (retry later).
	 */
	maintain(): Promise<MlsRenewalState> {
		return this.#exclusive(async () => {
			const reg = this.#o.registry;
			if (!reg) return 'off';
			let authority = await this.#loadAuthority('authority');
			if (!authority) {
				authority = Ed25519Keypair.generate();
				await this.#saveAuthority('authority', authority);
				await this.#o.store.setMeta('authority-since', String(this.#now()));
			}
			let record = await this.#lookupSelf();

			// A rotation that was in flight when we last stopped: did it land?
			const pending = await this.#loadAuthority('authority-pending');
			if (pending && record) {
				if (record.authorityKey === MlsSession.#pub(pending)) {
					authority = pending;
					await this.#saveAuthority('authority', pending);
					await this.#o.store.setMeta('authority-since', String(this.#now()));
				}
				await this.#saveAuthority('authority-pending', null);
			}

			if (!record) {
				if (!reg.submitter) return 'unregistered';
				try {
					await reg.submitter.asAccount(reg.chain.registerTx(this.#o.deviceId, MlsSession.#pub(authority)));
				} catch (error) {
					console.warn('[mls] device registration failed (retried later):', error);
					return 'unregistered';
				}
				record = await this.#lookupSelf(4);
				if (!record) return 'unregistered';
				await this.#o.store.setMeta('authority-since', String(this.#now()));
			}
			if (record.revokedAtMs !== 0) return 'revoked';
			if (record.authorityKey !== MlsSession.#pub(authority)) return 'conflict';

			// Scheduled rotation, signed by the current authority key.
			const since = Number((await this.#o.store.getMeta('authority-since')) ?? this.#now());
			if (reg.submitter && this.#now() - since >= (reg.rotateAfterMs ?? ROTATE_AFTER_MS)) {
				const next = Ed25519Keypair.generate();
				await this.#saveAuthority('authority-pending', next);
				try {
					await reg.submitter.asAuthority(reg.chain.rotateTx(MlsSession.#pub(next)), authority);
					authority = next;
					await this.#saveAuthority('authority', next);
					await this.#o.store.setMeta('authority-since', String(this.#now()));
					await this.#certs.forgetRegistry(this.wallet, this.#o.deviceId);
				} catch (error) {
					console.warn('[mls] authority rotation failed (retried later):', error);
				}
				await this.#saveAuthority('authority-pending', null);
			}

			await this.#renewCertificate(authority);
			return 'current';
		});
	}

	/** Issue a v2 certificate under `authority` if needed, then push it into every group. */
	async #renewCertificate(authority: Ed25519Keypair) {
		const current = this.certificate;
		const pub = MlsSession.#pub(authority);
		if (current.v !== 2 || current.authority_key !== pub) {
			const cert = await issueCertificateV2(authority, {
				wallet: this.wallet,
				device_id: this.#o.deviceId,
				mls_key: current.mls_key,
				issued_at_ms: this.#now(),
			});
			const renewed = this.#device.withIdentity(utf8.encode(JSON.stringify(cert)));
			for (const g of this.#groups.values()) g.free?.();
			this.#groups.clear();
			this.#device.free?.();
			this.#device = renewed;
			await this.#persist();
			// Old KeyPackages carry the old certificate: retire them, publish fresh ones.
			await this.#o.relayer.deleteDevice(this.#id, this.#o.deviceId).catch(() => {});
			await this.publishKeyPackages();
		}
		const identityHex = toHex(this.#device.identity());
		for (const id of new Set([...(await this.#knownGroups()), this.#selfId])) {
			const group = this.#group(id);
			if (!group?.isActive() || this.#desynced.has(id)) continue;
			const mine = this.#myLeaf(group);
			const leaf = (JSON.parse(group.membersJson()) as MlsMember[]).find((m) => m.leafIndex === mine);
			if (!leaf || leaf.identityHex.toLowerCase() === identityHex) continue;
			try {
				if (id === this.#selfId) await this.#selfCommit((g) => g.updateCredential(this.#device));
				else await this.#commit(id, (g) => ({ commit: g.updateCredential(this.#device) }));
			} catch (error) {
				console.warn(`[mls] credential update for ${id.slice(0, 10)}… failed (retried later):`, error);
			}
		}
	}

	/** Revoke another of this account's devices on-chain, signed by this device's authority key. */
	revokeDevice(deviceId: string): Promise<void> {
		return this.#exclusive(async () => {
			const reg = this.#o.registry;
			const authority = await this.#loadAuthority('authority');
			if (!reg?.submitter || !authority) throw new Error('this device is not registered');
			await reg.submitter.asAuthority(reg.chain.revokeByDeviceTx(deviceId), authority);
			await this.#certs.forgetRegistry(this.wallet, deviceId);
		});
	}

	// === Logout ===

	/** Logout: propose self-removal everywhere (incl. the self-group), retire KeyPackages, wipe state. */
	logout(groupIds: string[]): Promise<void> {
		return this.#exclusive(async () => {
			for (const id of groupIds) {
				const group = this.#group(id);
				if (!group?.isActive()) continue;
				try {
					await this.#o.relayer.postControlRow(this.#o.signer, id.toLowerCase(), group.leave(this.#device));
				} catch {
					// Best effort; the membership rule removes us anyway once off-chain.
				}
			}
			const self = this.#group(this.#selfId);
			if (self?.isActive()) {
				// My other devices commit this on their next syncSelf, so history stops reaching here.
				await this.#o.relayer.postSelfMessage(this.#id, self.leave(this.#device)).catch(() => false);
			}
			await this.#o.relayer.deleteDevice(this.#id, this.#o.deviceId).catch(() => {});
			// Registered device: revoke it on-chain with its own key (no account signature).
			const authority = await this.#loadAuthority('authority').catch(() => null);
			if (authority && this.#o.registry?.submitter) {
				await this.#o.registry.submitter
					.asAuthority(this.#o.registry.chain.revokeByDeviceTx(this.#o.deviceId), authority)
					.catch(() => {});
			}
			await this.#o.store.clear();
			for (const g of this.#groups.values()) g.free?.();
			this.#groups.clear();
		});
	}
}
