const DB_NAME = 'mysocial-zklogin-session'
const STORE = 'session'

export type ZkLoginRestoreRecord = {
  address: string
  addressSeed: string
  maxEpoch: number
  proofPoints: { a: string[]; b: string[][]; c: string[] }
  issBase64Details: { value: string; indexMod4: number }
  headerBase64: string
  proofVersion?: number
  sub?: string
}

type StoredRecord = ZkLoginRestoreRecord & {
  iv: number[]
  cipher: number[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        request.onsuccess = () => resolve(request.result as T | undefined)
        request.onerror = () => reject(request.error)
      }),
  )
}

function idbSet(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }),
  )
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }),
  )
}

async function wrappingKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>('device-key')
  if (existing) return existing
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await idbSet('device-key', created)
  return created
}

let loadedSigner: { secret: string; record: ZkLoginRestoreRecord } | null | undefined
let loadedSignerPending: Promise<{ secret: string; record: ZkLoginRestoreRecord } | null> | null = null

export async function saveZkLoginSigner(secret: string, record: ZkLoginRestoreRecord): Promise<void> {
  const key = await wrappingKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(secret)
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer,
    ),
  )
  const stored: StoredRecord = { ...record, iv: Array.from(iv), cipher: Array.from(cipher) }
  await idbSet('signer', stored)
  loadedSigner = { secret, record }
}

export async function loadZkLoginSigner(): Promise<{ secret: string; record: ZkLoginRestoreRecord } | null> {
  if (loadedSigner !== undefined) return loadedSigner
  if (loadedSignerPending) return loadedSignerPending
  loadedSignerPending = (async () => {
    const stored = await idbGet<StoredRecord>('signer')
    const key = await idbGet<CryptoKey>('device-key')
    if (!stored || !key) {
      loadedSigner = null
      return null
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(stored.iv) },
        key,
        new Uint8Array(stored.cipher),
      )
      const { iv: _iv, cipher: _cipher, ...record } = stored
      loadedSigner = { secret: new TextDecoder().decode(plain), record }
      return loadedSigner
    } catch {
      loadedSigner = null
      return null
    } finally {
      loadedSignerPending = null
    }
  })()
  return loadedSignerPending
}

export async function clearZkLoginSigner(): Promise<void> {
  loadedSigner = undefined
  loadedSignerPending = null
  await idbDelete('signer')
}
