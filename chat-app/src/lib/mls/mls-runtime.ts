/**
 * Web MLS runtime (E2EE M6): loads the `myso-mls` WASM, takes the per-wallet Web Lock (exactly one
 * tab owns this device's MLS state), and opens the session on the messaging client.
 *
 * Other tabs wait for the lock; until they get it, MLS groups read as "open in your other tab".
 */

import init, * as mls from '@socialproof/myso-mls';
import type { MlsSession, MlsWasmModule } from '@socialproof/myso-messaging-stack';
import type { Signer } from '@socialproof/myso/cryptography';

import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Transaction } from '@socialproof/myso/transactions';

import { relayerAuthSigner } from '../relayer-identity';
import { signAndExecuteTransactionAndWait } from '../sign-and-wait';
import { zkLoginChainAddress, zkLoginChainSignature } from '../zklogin-signin';
import { IndexedDbMlsStore } from './mls-store';

type MessagingClientLike = {
  messaging: {
    openMlsSession(options: {
      wasm: MlsWasmModule;
      store: IndexedDbMlsStore;
      signer: Signer;
      deviceId: string;
      primary?: boolean;
      registry?: {
        submitter?: {
          asAccount(tx: Transaction): Promise<void>;
          asAuthority(tx: Transaction, authority: Signer): Promise<void>;
        };
      };
    }): Promise<MlsSession>;
    mlsSession?: MlsSession;
  };
};

let wasmReady: Promise<MlsWasmModule> | null = null;
/** Open sessions by wallet: the signed-in human (primary) plus any agents sending as themselves. */
const sessions = new Map<string, { session: MlsSession; store: IndexedDbMlsStore; release: () => void }>();
let primaryWallet: string | null = null;

/**
 * This tab's MLS state for the signed-in user, for UI copy:
 * `off` (build has MLS disabled), `waiting` (another tab owns this device), `starting`,
 * `ready`, or `failed` (the session couldn't open; MLS groups can't be read here).
 */
export type MlsTabState = 'off' | 'waiting' | 'starting' | 'ready' | 'failed';
let tabState: MlsTabState = 'off';
const tabListeners = new Set<(s: MlsTabState) => void>();
function setTabState(next: MlsTabState) {
  tabState = next;
  for (const l of tabListeners) l(next);
}
export function mlsTabState(): MlsTabState {
  return isMlsEnabled() ? tabState : 'off';
}
export function onMlsTabState(listener: (s: MlsTabState) => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

function loadWasm(): Promise<MlsWasmModule> {
  wasmReady ??= init().then(() => mls as unknown as MlsWasmModule);
  return wasmReady;
}

/** A revoked / conflicting device id can never come back: the next start gets a fresh one. */
function retireDeviceId(wallet: string) {
  try {
    localStorage.removeItem(`myso-mls-device:${wallet.toLowerCase()}`);
  } catch {
    // ignore
  }
}

/** Certificate renewal through the on-chain device registry (`VITE_MLS_DEVICE_REGISTRY=true`). */
export function isMlsRegistryEnabled(): boolean {
  return isMlsEnabled() && import.meta.env.VITE_MLS_DEVICE_REGISTRY === 'true';
}

/**
 * Registry transactions with smart / sponsored gas. Registration is signed by the account (for
 * zkLogin, its proof: the one time it's needed); rotation and revocation by the device's own
 * authority key, so they work long after the proof has expired.
 */
function registrySubmitter(core: ClientWithCoreApi, signer: Signer) {
  return {
    asAccount: async (tx: Transaction) => {
      const zkAddress = zkLoginChainAddress();
      await signAndExecuteTransactionAndWait(core, signer, tx, {
        logPrefix: 'MLS registry',
        ...(zkAddress
          ? {
              senderAddress: zkAddress,
              signTransactionBytes: async (bytes: Uint8Array) => {
                const sig = await zkLoginChainSignature(bytes);
                if (!sig) throw new Error('zkLogin session expired: registration retried after sign-in');
                return sig;
              },
            }
          : {}),
      });
    },
    asAuthority: async (tx: Transaction, authority: Signer) => {
      await signAndExecuteTransactionAndWait(core, authority, tx, { logPrefix: 'MLS registry' });
    },
  };
}

const MAINTAIN_EVERY_MS = 6 * 60 * 60 * 1000;
/** Passkey message backup (M8): upload new rows this often while it's on. */
const BACKUP_EVERY_MS = 15 * 60 * 1000;

/** Stable per-install device id for this wallet (a new install is a new MLS device). */
function deviceIdFor(wallet: string): string {
  const key = `myso-mls-device:${wallet.toLowerCase()}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = `web-${crypto.randomUUID()}`;
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `web-${crypto.randomUUID()}`;
  }
}


/**
 * Start MLS for `signer` on `client`. Resolves once this tab holds the device lock and the session
 * is open (other tabs keep waiting in the background). Safe to call repeatedly.
 */
export async function startMls(
  client: MessagingClientLike,
  signer: Signer,
  options: { primary?: boolean } = {},
): Promise<MlsSession | null> {
  // The account the device belongs to (zkLogin: the zkLogin address, which survives sign-ins;
  // the ephemeral key changes every time). Device id, lock and store are keyed by it.
  const wallet = relayerAuthSigner(signer).toMySoAddress().toLowerCase();
  const existing = sessions.get(wallet);
  if (existing) return existing.session;
  const primary = options.primary ?? true;
  if (typeof navigator === 'undefined' || !navigator.locks) {
    if (primary) setTabState('failed');
    return null;
  }
  const wasm = await loadWasm();
  if (primary) setTabState('starting');
  // Another tab holds the lock: say so until we get it.
  void navigator.locks.query().then((q) => {
    if (primary && q.held?.some((l) => l.name === `myso-mls:${wallet}`) && tabState === 'starting') {
      setTabState('waiting');
    }
  });

  return new Promise((resolve) => {
    void navigator.locks.request(`myso-mls:${wallet}`, async () => {
      const store = new IndexedDbMlsStore(wallet);
      try {
        // zkLogin certificates are checked by the client's own fullnode (never the relayer);
        // outages and expired proofs read as "unknown" (sends pause), never as invalid.
        const session = await client.messaging.openMlsSession({
          wasm,
          store,
          signer,
          deviceId: deviceIdFor(wallet),
          primary,
          // Only the human's device renews through the registry; agents use ed25519 (v1) keys.
          registry:
            primary && isMlsRegistryEnabled()
              ? { submitter: registrySubmitter(client as unknown as ClientWithCoreApi, signer) }
              : undefined,
        });
        let release: () => void = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        sessions.set(wallet, { session, store, release });
        if (primary) {
          primaryWallet = wallet;
          setTabState('ready');
        }
        // Own-device history: answer new devices / pick up history sent to this one.
        const selfSync = primary
          ? setInterval(() => void session.syncSelf().catch(() => {}), 60_000)
          : null;
        // Certificate renewal: now, then every few hours (registration, rotation, credential push).
        const maintain = async () => {
          const state = await session.maintain().catch((err) => {
            console.warn('[mls] renewal check failed (retried later):', err);
            return null;
          });
          if (state === 'revoked' || state === 'conflict') {
            // This device can't be trusted any more (revoked from another device, or its key was
            // lost). Retire it; the next start creates a new device under a new id.
            console.warn(`[mls] device ${state}; retiring it`);
            retireDeviceId(wallet);
            sessions.delete(wallet);
            if (primary) {
              primaryWallet = null;
              setTabState('failed');
            }
            await session.logout([]).catch(() => {});
            release();
          }
        };
        const renewal = primary && isMlsRegistryEnabled() ? setInterval(() => void maintain(), MAINTAIN_EVERY_MS) : null;
        if (renewal) void maintain();
        // Message backup (no-op unless turned on): incremental, in the background.
        const backup = primary
          ? setInterval(() => void session.backupNow().catch((err) => console.warn('[mls] backup failed:', err)), BACKUP_EVERY_MS)
          : null;
        void held.then(() => {
          if (selfSync) clearInterval(selfSync);
          if (renewal) clearInterval(renewal);
          if (backup) clearInterval(backup);
        });
        resolve(session);
        // Hold the lock for this tab's lifetime (or until logout releases it).
        await held;
        return;
      } catch (err) {
        console.warn('[mls] session failed to open:', err);
        if (primary) setTabState('failed');
        resolve(null);
        return;
      }
    });
  });
}

export function mlsSession(): MlsSession | null {
  return primaryWallet ? (sessions.get(primaryWallet)?.session ?? null) : null;
}

/** Logout: every device on this tab (human + agents) leaves its groups, retires, wipes state. */
export async function stopMls(groupIds: string[]): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  primaryWallet = null;
  setTabState('off');
  for (const { session, store, release } of all) {
    try {
      await session.logout(groupIds);
    } catch {
      await store.clear().catch(() => {});
    }
    release();
  }
}

/** MLS is on unless a build turns it off (`VITE_MLS_ENABLED=false`). New groups always use it. */
export function isMlsEnabled(): boolean {
  return import.meta.env.VITE_MLS_ENABLED !== 'false';
}

type MembershipClient = {
  messaging: {
    view: { groupsMetadata(o: { groupIds: string[] }): Promise<Record<string, { data?: { contents?: { key: string; value: string }[] } }>> };
  };
};

/**
 * For every `mls1` group this wallet is in on-chain but this device isn't in the MLS group (new
 * device, cleared storage, added while offline): take the Welcome or join by external commit.
 * Reads also do this on demand, so groups discovered later are covered too.
 */
export async function ensureMlsMembership(client: MembershipClient, groupIds: string[]): Promise<void> {
  const session = mlsSession();
  if (!session || groupIds.length === 0) return;
  const meta = await client.messaging.view.groupsMetadata({ groupIds }).catch(() => ({}) as Record<string, never>);
  for (const groupId of groupIds) {
    const flag = meta[groupId]?.data?.contents?.find((c) => c.key === 'e2ee')?.value;
    if (flag !== 'mls1' || session.hasGroup(groupId)) continue;
    // Pending Welcome first, else external commit; throttled and backed off inside the session.
    if (!(await session.ensureGroup(groupId).catch(() => false))) {
      console.warn('[mls] could not join', groupId.slice(0, 10), '(will retry on open)');
    }
  }
}

// === Passkey message backup (M8) ===

export type MlsBackupStatus = { available: boolean; enabled: boolean; keyId: string | null };

/** Whether backup is on for this tab's device. */
export async function mlsBackupStatus(): Promise<MlsBackupStatus> {
  const session = mlsSession();
  const { backupPasskeyAvailable } = await import('./backup-passkey');
  if (!session) return { available: false, enabled: false, keyId: null };
  const key = await session.backupKey();
  return { available: backupPasskeyAvailable(), enabled: key !== null, keyId: key?.keyId ?? null };
}

/** Turn backup on (one passkey prompt): restores what's backed up, then backs up this device. */
export async function enableMlsBackup(): Promise<{ restored: number; backedUp: number }> {
  const session = mlsSession();
  if (!session) throw new Error('End-to-end encryption isn’t running in this tab.');
  const { getBackupPrf } = await import('./backup-passkey');
  const prf = await getBackupPrf(session.wallet, { allowCreate: true });
  try {
    return await session.enableBackup(prf);
  } finally {
    prf.fill(0);
  }
}

/** Turn backup off here; with `deleteRemote`, also delete the stored backup. */
export async function disableMlsBackup(deleteRemote: boolean): Promise<void> {
  await mlsSession()?.disableBackup({ deleteRemote });
}
