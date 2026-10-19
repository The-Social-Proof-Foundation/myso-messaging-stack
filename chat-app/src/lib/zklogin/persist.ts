/**
 * Durable zkLogin chat key for this browser profile.
 *
 * The Ed25519 messaging secret outlives the Groth16 proof. Both are sealed
 * together under a non-extractable AES-256-GCM device key. Nothing here is
 * exported or sent to a server. One signer slot per profile: an account switch
 * deletes the previous ciphertext before a new secret is written.
 */

const DB_NAME = 'mysocial-zklogin-session';
const STORE = 'session';
const DEVICE_KEY = 'device-key';
const SIGNER_KEY = 'signer';
const AAD_LABEL = 'mysocial-zklogin-signer-v2:signer';

export type ZkLoginRestoreRecord = {
  address: string;
  addressSeed: string;
  maxEpoch: number;
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  proofVersion?: number;
  sub?: string;
};

export type LoadedZkLoginSigner = {
  secret: string;
  sub?: string;
  /** Null once the proof has expired or been cleared. The secret is still set. */
  record: ZkLoginRestoreRecord | null;
};

type Payload = {
  secret: string;
  sub?: string;
  proof: ZkLoginRestoreRecord | null;
};

type Envelope = {
  v: 2;
  iv: number[];
  cipher: number[];
};

type LegacyRecord = ZkLoginRestoreRecord & {
  iv: number[];
  cipher: number[];
  v?: number;
};

export type ZkLoginBackend = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Associated data bound to the signer envelope. A swapped blob will not decrypt. */
export function zkLoginSignerAad(): Uint8Array {
  return new TextEncoder().encode(AAD_LABEL);
}

let backendOverride: ZkLoginBackend | null = null;
let loadedSigner: LoadedZkLoginSigner | null | undefined;
let loadedSignerPending: Promise<LoadedZkLoginSigner | null> | null = null;
let cacheGeneration = 0;

/** Test hook. Production uses IndexedDB. Pass null to restore it. */
export function setZkLoginBackendForTests(backend: ZkLoginBackend | null): void {
  backendOverride = backend;
  forgetDecryptedZkLoginSigner();
}

export function createMemoryZkLoginBackend(): ZkLoginBackend & { snapshot(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    snapshot: () => map,
  };
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

function indexedDbBackend(): ZkLoginBackend {
  return {
    get: (key) =>
      openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => {
              db.close();
              reject(request.error);
            };
          }),
      ),
    set: (key, value) =>
      openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          }),
      ),
    delete: (key) =>
      openDb().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          }),
      ),
  };
}

function backend(): ZkLoginBackend {
  return backendOverride ?? indexedDbBackend();
}

/** Drop the decrypted copy. The ciphertext stays until {@link clearZkLoginSigner}. */
export function forgetDecryptedZkLoginSigner(): void {
  cacheGeneration += 1;
  loadedSigner = undefined;
  loadedSignerPending = null;
}

async function wrappingKey(): Promise<CryptoKey> {
  const store = backend();
  const existing = await store.get(DEVICE_KEY);
  if (existing) return existing as CryptoKey;
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await store.set(DEVICE_KEY, created);
  return created;
}

async function seal(payload: Payload): Promise<Envelope> {
  const key = await wrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: zkLoginSignerAad() },
      key,
      plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer,
    ),
  );
  return { v: 2, iv: Array.from(iv), cipher: Array.from(cipher) };
}

async function openEnvelope(envelope: Envelope): Promise<Payload> {
  const key = await wrappingKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(envelope.iv), additionalData: zkLoginSignerAad() },
    key,
    new Uint8Array(envelope.cipher),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Payload;
}

function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Envelope>;
  return record.v === 2 && Array.isArray(record.iv) && Array.isArray(record.cipher);
}

function isLegacy(value: unknown): value is LegacyRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LegacyRecord>;
  return record.v !== 2 && Array.isArray(record.iv) && Array.isArray(record.cipher) && typeof record.address === 'string';
}

async function openLegacy(stored: LegacyRecord): Promise<Payload> {
  const key = await wrappingKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(stored.iv) },
    key,
    new Uint8Array(stored.cipher),
  );
  const { iv: _iv, cipher: _cipher, v: _v, ...record } = stored;
  return {
    secret: new TextDecoder().decode(plain),
    sub: record.sub,
    proof: record,
  };
}

function toLoaded(payload: Payload): LoadedZkLoginSigner {
  return {
    secret: payload.secret,
    sub: payload.sub ?? payload.proof?.sub,
    record: payload.proof,
  };
}

async function writePayload(payload: Payload): Promise<LoadedZkLoginSigner> {
  const envelope = await seal(payload);
  await backend().set(SIGNER_KEY, envelope);
  const loaded = toLoaded(payload);
  loadedSigner = loaded;
  return loaded;
}

async function readStored(): Promise<LoadedZkLoginSigner | null> {
  const stored = await backend().get(SIGNER_KEY);
  if (!stored) return null;
  const key = await backend().get(DEVICE_KEY);
  if (!key) return null;
  try {
    if (isEnvelope(stored)) return toLoaded(await openEnvelope(stored));
    if (isLegacy(stored)) {
      const payload = await openLegacy(stored);
      return await writePayload(payload);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encrypt the chat secret and, when present, the proof that lets this key act
 * as the zkLogin account. A null record keeps the secret and drops the proof.
 */
export async function saveZkLoginSigner(
  secret: string,
  record: ZkLoginRestoreRecord | null,
  sub?: string,
): Promise<void> {
  const boundSub = sub ?? record?.sub;
  await writePayload({
    secret,
    ...(boundSub ? { sub: boundSub } : {}),
    proof: record ? { ...record, ...(boundSub ? { sub: boundSub } : {}) } : null,
  });
}

export async function loadZkLoginSigner(): Promise<LoadedZkLoginSigner | null> {
  if (loadedSigner !== undefined) return loadedSigner;
  if (loadedSignerPending) return loadedSignerPending;
  const generation = cacheGeneration;
  loadedSignerPending = (async () => {
    try {
      const loaded = await readStored();
      if (generation === cacheGeneration) loadedSigner = loaded;
      return loaded;
    } finally {
      if (generation === cacheGeneration) loadedSignerPending = null;
    }
  })();
  return loadedSignerPending;
}

/** Drop the expired proof. The messaging secret and its subject stay sealed. */
export async function clearZkLoginProof(): Promise<void> {
  const loaded = await loadZkLoginSigner();
  if (!loaded?.secret) return;
  await writePayload({
    secret: loaded.secret,
    ...(loaded.sub ? { sub: loaded.sub } : {}),
    proof: null,
  });
}

/** Delete this profile's signer. The device wrapping key stays. */
export async function clearZkLoginSigner(): Promise<void> {
  forgetDecryptedZkLoginSigner();
  await backend().delete(SIGNER_KEY);
}
