/**
 * Automation delegates.
 *
 * Unattended jobs cannot use the user's own agent keys: those live in the
 * user's vault behind a passkey, and a 3am job has no one to touch the passkey.
 * Handing them to a server instead would make the operator a custodian. So an
 * unattended job gets a *delegate*: a fresh sub-agent the owner registers
 * on-chain with only what a memory job needs, then encrypts to the memory bridge.
 *
 *   capabilities  memory read + write + MYDATA read, nothing else
 *   delegatable   none, so it cannot mint children
 *   spend cap     required (`max_action_spend`)
 *   expiry        required, and short
 *   revocation    the owner's `revoke_sub_agent`, honoured by the relayer and
 *                 by the bridge on its very next request
 *
 * The delegate's seed is generated here, encrypted here, and leaves the browser
 * only as ciphertext that nothing but the bridge's MyData key can open. The user's
 * own agent seeds and wallet keys are never involved.
 *
 * The encrypting format is specified by, and tested against,
 * `myso-memory/services/automation-sidecar/src/encrypt.ts`.
 */

import {CAP} from './capabilities';

/** Memory read + write + MYDATA read: what recall and remember actually need. */
export const DELEGATE_CAPABILITIES = CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.MYDATA_READ;

/** Longest a delegate may live. Renewing is one gesture; a leaked key is not forever. */
export const DELEGATE_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const DELEGATE_MIN_TTL_MS = 60 * 60 * 1000;

const ENVELOPE_VERSION = 1;
const HKDF_INFO = 'myso-automation-delegate-v1';
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The bridge's public MyData key, as published by `pnpm gen:mydata-key`. */
export interface MyDataKey {
  id: string;
  publicKey: Uint8Array;
}

export class DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegateError';
  }
}

export function isValidDelegateName(name: string): boolean {
  return NAME.test(name);
}

/** The `target_agent_key_ref` a job uses to select a delegate. */
export function delegateKeyRef(name: string): string {
  return `delegate:${name}`;
}

export function normalizeObjectId(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
}

/** Additional authenticated data. Must match the bridge's `delegateAad` exactly. */
export function delegateAad(accountId: string, delegateRef: string, agentObjectId: string): Uint8Array {
  return new TextEncoder().encode(
    `myso-delegate-v1|${normalizeObjectId(accountId)}|${delegateRef}|${normalizeObjectId(agentObjectId)}`,
  );
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Parse `VITE_AUTOMATION_MYDATA_KEY` (`<id>:<base64url public key>`). */
export function parseMyDataKey(raw: string | undefined): MyDataKey | null {
  const value = raw?.trim();
  if (!value) return null;
  const at = value.indexOf(':');
  const id = at > 0 ? value.slice(0, at) : '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    throw new DelegateError('VITE_AUTOMATION_MYDATA_KEY must look like <id>:<base64url public key>.');
  }
  let publicKey: Uint8Array;
  try {
    publicKey = fromBase64Url(value.slice(at + 1));
  } catch {
    // atob throws a bare InvalidCharacterError, which says nothing about which
    // setting is wrong.
    throw new DelegateError('VITE_AUTOMATION_MYDATA_KEY must hold a base64url X25519 public key.');
  }
  if (publicKey.length !== 32) {
    throw new DelegateError('VITE_AUTOMATION_MYDATA_KEY must hold a 32-byte X25519 public key.');
  }
  return {id, publicKey};
}

/** The configured MyData key, or null when the bridge has not published one. */
export function configuredMyDataKey(): MyDataKey | null {
  return parseMyDataKey(import.meta.env.VITE_AUTOMATION_MYDATA_KEY);
}

/**
 * MyData a 32-byte delegate seed to the bridge.
 *
 *   shared = X25519(ephemeralPrivate, bridgePublic)
 *   key    = HKDF-SHA256(shared, salt = ephemeralPublic | bridgePublic, info)
 *   encrypted key = version | ephemeralPublic | iv | AES-256-GCM(seed, aad)   (base64url)
 */
export async function encryptDelegateSeed(
  seed: Uint8Array,
  myDataKey: MyDataKey,
  accountId: string,
  delegateRef: string,
  agentObjectId: string,
): Promise<string> {
  if (seed.length !== 32) throw new DelegateError('A delegate seed must be 32 bytes.');

  const subtle = crypto.subtle;
  const ephemeral = (await subtle.generateKey({name: 'X25519'}, true, ['deriveBits'])) as CryptoKeyPair;
  const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const recipient = await subtle.importKey('raw', myDataKey.publicKey, {name: 'X25519'}, false, []);
  const shared = await subtle.deriveBits({name: 'X25519', public: recipient}, ephemeral.privateKey, 256);

  const salt = new Uint8Array(64);
  salt.set(ephemeralPublic, 0);
  salt.set(myDataKey.publicKey, 32);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aesKey = await subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO)},
    hkdf,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await subtle.encrypt(
      {name: 'AES-GCM', iv, additionalData: delegateAad(accountId, delegateRef, agentObjectId)},
      aesKey,
      seed,
    ),
  );

  const envelope = new Uint8Array(1 + 32 + 12 + body.length);
  envelope[0] = ENVELOPE_VERSION;
  envelope.set(ephemeralPublic, 1);
  envelope.set(iv, 33);
  envelope.set(body, 45);
  return toBase64Url(envelope);
}

export interface DelegatePolicyInput {
  name: string;
  /** Absolute expiry, ms since epoch. */
  expiresAtMs: number;
  /** Spend cap in MIST, as a decimal string. */
  maxActionSpendMist: string;
}

/**
 * Validate what the owner is about to grant. Everything here is also enforced
 * by the bridge, so a UI that skips it still cannot create a usable delegate
 * that is unbounded; this exists to say so before an on-chain transaction.
 */
export function validateDelegatePolicy(input: DelegatePolicyInput, nowMs = Date.now()): void {
  if (!isValidDelegateName(input.name)) {
    throw new DelegateError("Name the delegate with 1-64 letters, digits, '.', '_' or '-'.");
  }
  const ttl = input.expiresAtMs - nowMs;
  if (!Number.isFinite(ttl) || ttl < DELEGATE_MIN_TTL_MS) {
    throw new DelegateError('A delegate must last at least an hour.');
  }
  if (ttl > DELEGATE_MAX_TTL_MS) {
    throw new DelegateError('A delegate may last at most 90 days. You can renew it later.');
  }
  if (!/^[1-9][0-9]*$/.test(input.maxActionSpendMist)) {
    throw new DelegateError('Set a spending limit greater than zero.');
  }
}
