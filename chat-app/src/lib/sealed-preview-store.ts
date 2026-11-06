/**
 * Sidebar last-message previews, sealed at rest.
 *
 * Previews are decrypted message text, so they must not sit in localStorage as cleartext.
 * They are sealed with AES-256-GCM under a non-extractable device key that lives in
 * IndexedDB (the same pattern as `zklogin/persist.ts`), with the wallet bound in the AAD so
 * one account's blob can't be opened as another's. iOS parity: `MessagingVault` seals its
 * inbox chrome the same way.
 *
 * Logout calls `clearSealedPreviews()`, which drops the device key, so any sealed blob left
 * behind is unreadable.
 */

import type { StoredSidebarPreview } from './sidebar-chrome-store';

const DB_NAME = 'chat-app-sealed-previews';
const STORE = 'kv';
const DEVICE_KEY = 'device-key';
const AAD_LABEL = 'chat-app-sidebar-previews-v1:';
/** Pre-sealing cleartext cache; migrated once, then deleted. */
const LEGACY_LOCALSTORAGE_KEY = 'chat-app-sidebar-previews';

type SealedBlob = { iv: Uint8Array; ct: ArrayBuffer };

export interface SealedPreviewBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
}

function previewsKey(wallet: string): string {
  return `previews:${wallet}`;
}

function normalizeWallet(wallet: string | null | undefined): string | null {
  const w = wallet?.trim().toLowerCase();
  return w ? w : null;
}

function aadFor(wallet: string): Uint8Array {
  return new TextEncoder().encode(AAD_LABEL + wallet);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function indexedDbBackend(): SealedPreviewBackend {
  return {
    get: (key) => withStore('readonly', (store) => store.get(key)),
    set: (key, value) => withStore('readwrite', (store) => store.put(value, key)).then(() => {}),
    clear: () => withStore('readwrite', (store) => store.clear()).then(() => {}),
  };
}

/** In-memory backend for tests and environments without IndexedDB. */
export function createMemorySealedPreviewBackend(): SealedPreviewBackend & {
  snapshot(): Map<string, unknown>;
} {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    clear: async () => {
      map.clear();
    },
    snapshot: () => map,
  };
}

let backend: SealedPreviewBackend | null = null;

function getBackend(): SealedPreviewBackend | null {
  if (backend) return backend;
  if (typeof indexedDB === 'undefined' || typeof crypto?.subtle === 'undefined') return null;
  backend = indexedDbBackend();
  return backend;
}

/** Test hook: swap the storage backend (pass `null` to restore the default). */
export function setSealedPreviewBackendForTests(next: SealedPreviewBackend | null): void {
  backend = next;
  deviceKeyPromise = null;
}

let deviceKeyPromise: Promise<CryptoKey> | null = null;

async function deviceKey(store: SealedPreviewBackend): Promise<CryptoKey> {
  if (!deviceKeyPromise) {
    deviceKeyPromise = (async () => {
      const existing = await store.get(DEVICE_KEY);
      if (existing instanceof CryptoKey) return existing;
      // Non-extractable: page script can use it but never read the raw key bytes.
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await store.set(DEVICE_KEY, key);
      return key;
    })().catch((error) => {
      deviceKeyPromise = null;
      throw error;
    });
  }
  return deviceKeyPromise;
}

function sanitize(raw: unknown): Map<string, StoredSidebarPreview> {
  const out = new Map<string, StoredSidebarPreview>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [groupId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as Partial<StoredSidebarPreview> | null;
    if (!e || typeof e.order !== 'number') continue;
    out.set(groupId, {
      text: typeof e.text === 'string' ? e.text : '',
      order: e.order,
      verified: Boolean(e.verified),
      ...(typeof e.at === 'number' ? { at: e.at } : {}),
    });
  }
  return out;
}

/** Reads the old cleartext cache for `wallet` and removes the cleartext from localStorage. */
function takeLegacyPreviews(wallet: string): Map<string, StoredSidebarPreview> {
  try {
    if (typeof localStorage === 'undefined') return new Map();
    const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
    if (!raw) return new Map();
    localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
    const root = JSON.parse(raw) as Record<string, unknown>;
    return sanitize(root[wallet]);
  } catch {
    return new Map();
  }
}

/**
 * Load and unseal `wallet`'s previews. Never throws: a missing, corrupt or foreign blob
 * reads as empty (previews refill from the relayer).
 */
export async function loadSealedPreviews(
  wallet: string | null | undefined,
): Promise<Map<string, StoredSidebarPreview>> {
  const w = normalizeWallet(wallet);
  if (!w) return new Map();
  const legacy = takeLegacyPreviews(w);
  const store = getBackend();
  if (!store) return legacy;
  try {
    const blob = (await store.get(previewsKey(w))) as SealedBlob | undefined;
    let sealed = new Map<string, StoredSidebarPreview>();
    if (blob?.iv && blob.ct) {
      const key = await deviceKey(store);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.iv, additionalData: aadFor(w) },
        key,
        blob.ct,
      );
      sealed = sanitize(JSON.parse(new TextDecoder().decode(plain)));
    }
    if (legacy.size === 0) return sealed;
    // One-time migration: keep the newer entry per group, then re-seal.
    for (const [groupId, entry] of legacy) {
      const prev = sealed.get(groupId);
      if (!prev || entry.order > prev.order) sealed.set(groupId, entry);
    }
    await saveSealedPreviews(w, sealed);
    return sealed;
  } catch {
    return legacy;
  }
}

/** Seal and store `wallet`'s previews. Best-effort; failures leave the previous blob. */
export async function saveSealedPreviews(
  wallet: string | null | undefined,
  previews: Map<string, StoredSidebarPreview>,
): Promise<void> {
  const w = normalizeWallet(wallet);
  const store = getBackend();
  if (!w || !store) return;
  try {
    const key = await deviceKey(store);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(Object.fromEntries(previews)));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor(w) },
      key,
      plain,
    );
    await store.set(previewsKey(w), { iv, ct } satisfies SealedBlob);
  } catch {
    // Quota / private mode — previews just refill from the relayer next time.
  }
}

/** Logout: drop every sealed preview and the device key, plus any legacy cleartext. */
export async function clearSealedPreviews(): Promise<void> {
  deviceKeyPromise = null;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {
    // ignore
  }
  const store = getBackend();
  if (!store) return;
  try {
    await store.clear();
  } catch {
    // ignore
  }
}
