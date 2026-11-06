/**
 * IndexedDB-backed MLS state for one wallet (E2EE M6, web).
 *
 * Holds this device's MLS snapshot (signing key + every group's epoch secrets) and the unwrapped
 * message rows (MLS keys are single use, so these are the only readable copies). Every record is
 * sealed with AES-256-GCM under a non-extractable device key (same pattern as the sealed sidebar
 * previews) and bound to its record key in the AAD. Logout calls `clear()`, which drops the key too.
 */

import type { MlsStateStore, UnwrappedRow } from '@socialproof/myso-messaging-stack';

const STORE = 'kv';
const DEVICE_KEY = '__device_key__';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** JSON codec that survives Uint8Array and bigint fields. */
function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_k, v) =>
      v instanceof Uint8Array ? { $b: hex(v) } : typeof v === 'bigint' ? { $n: v.toString() } : v,
    ),
  );
}

function decode<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes), (_k, v) =>
    v && typeof v === 'object' && '$b' in v ? unhex(v.$b) : v && typeof v === 'object' && '$n' in v ? BigInt(v.$n) : v,
  ) as T;
}

type Sealed = { iv: Uint8Array; ct: ArrayBuffer };

export class IndexedDbMlsStore implements MlsStateStore {
  readonly #name: string;
  #db: Promise<IDBDatabase> | null = null;
  #key: Promise<CryptoKey> | null = null;

  constructor(wallet: string) {
    this.#name = `myso-mls-${wallet.toLowerCase()}`;
  }

  #open() {
    this.#db ??= openDb(this.#name);
    return this.#db;
  }

  #deviceKey() {
    this.#key ??= (async () => {
      const db = await this.#open();
      const existing = await tx(db, 'readonly', (s) => s.get(DEVICE_KEY));
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await tx(db, 'readwrite', (s) => s.put(key, DEVICE_KEY));
      return key;
    })();
    return this.#key;
  }

  async #put(id: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
      await this.#deviceKey(),
      encode(value) as Uint8Array<ArrayBuffer>,
    );
    const db = await this.#open();
    await tx(db, 'readwrite', (s) => s.put({ iv, ct } satisfies Sealed, id));
  }

  async #open1<T>(id: string, sealed: Sealed | undefined): Promise<T | null> {
    if (!sealed?.iv) return null;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(id) },
        await this.#deviceKey(),
        sealed.ct,
      );
      return decode<T>(new Uint8Array(pt));
    } catch {
      return null;
    }
  }

  async #get<T>(id: string): Promise<T | null> {
    const db = await this.#open();
    return this.#open1<T>(id, (await tx(db, 'readonly', (s) => s.get(id))) as Sealed | undefined);
  }

  async loadDevice() {
    return this.#get<{ snapshot: Uint8Array; deviceId: string }>('device');
  }

  async saveDevice(state: { snapshot: Uint8Array; deviceId: string }) {
    await this.#put('device', state);
  }

  async getCursor(groupId: string) {
    return (await this.#get<number>(`cursor:${groupId}`)) ?? 0;
  }

  async setCursor(groupId: string, order: number) {
    await this.#put(`cursor:${groupId}`, order);
  }

  async putRows(groupId: string, rows: UnwrappedRow[]) {
    for (const row of rows) {
      await this.#put(`row:${groupId}:${String(row.order).padStart(16, '0')}:${row.messageId}`, row);
    }
  }

  async listRows(groupId: string, options: { before?: number; limit: number }) {
    const db = await this.#open();
    const lower = `row:${groupId}:`;
    const upper =
      options.before === undefined ? `row:${groupId};` : `row:${groupId}:${String(options.before).padStart(16, '0')}`;
    const range = IDBKeyRange.bound(lower, upper, false, true);
    const [keys, values] = await Promise.all([
      tx(db, 'readonly', (s) => s.getAllKeys(range)),
      tx(db, 'readonly', (s) => s.getAll(range)),
    ]);
    const start = Math.max(0, keys.length - options.limit);
    const out: UnwrappedRow[] = [];
    for (let i = start; i < keys.length; i++) {
      const row = await this.#open1<UnwrappedRow>(String(keys[i]), values[i] as Sealed);
      if (row) out.push(row);
    }
    return out;
  }

  async hasRows(groupId: string, rows: { order: number; messageId: string }[]) {
    const db = await this.#open();
    const found = new Set<string>();
    for (const r of rows) {
      const id = `row:${groupId}:${String(r.order).padStart(16, '0')}:${r.messageId}`;
      if ((await tx(db, 'readonly', (s) => s.getKey(id))) !== undefined) found.add(`${r.order}:${r.messageId}`);
    }
    return found;
  }

  async getMeta(key: string) {
    return this.#get<string>(`meta:${key}`);
  }

  async setMeta(key: string, value: string | null) {
    if (value === null) {
      const db = await this.#open();
      await tx(db, 'readwrite', (s) => s.delete(`meta:${key}`));
    } else {
      await this.#put(`meta:${key}`, value);
    }
  }

  async groupIds() {
    const db = await this.#open();
    const keys = await tx(db, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound('row:', 'row;', false, true)));
    return [...new Set(keys.map((k) => String(k).split(':').slice(1, -2).join(':')))];
  }

  async clear() {
    const db = await this.#open();
    await tx(db, 'readwrite', (s) => s.clear());
    this.#key = null;
  }
}
