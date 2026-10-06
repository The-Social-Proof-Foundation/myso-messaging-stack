import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import type { Transaction } from '@socialproof/myso/transactions';
import {
  decodeJwt,
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from '@socialproof/myso/zklogin';
import { readMySocialAuthConfig } from './mysocial-auth-config';
import { refreshAuthSessionNow } from './mysocial-session-refresh';
import { getCurrentNetwork } from './network-utils';
import { signAndExecuteTransactionAndWait } from './sign-and-wait';
import { getAuthSessionRaw, setAuthSessionRaw } from './mysocial-auth-storage';
import {
  clearZkLoginSigner as clearPersistedZkLoginSigner,
  loadZkLoginSigner,
  saveZkLoginSigner,
  type ZkLoginRestoreRecord,
} from './zklogin/persist';
import { zkLoginProverNetwork } from './zklogin/prover-network';

const ACCOUNT_FLAG = 'mysocial_zklogin_account';
const PENDING_KEY = 'mysocial_zklogin_pending';
const CURRENT_KEY = 'mysocial_zklogin_current';
const BROADCAST_CHANNEL_NAME = 'mysocial-auth';
const PROVER_URL =
  import.meta.env.VITE_ZKLOGIN_PROVER_URL ||
  'https://prover.testnet.mysocial.network/prove';
const PROOF_VERSION = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EPOCH_DELTA = 30;
const CLOCK_CACHE_MS = 60_000;

export const ZKLOGIN_PROOF_EXPIRED_EVENT = 'mysocial-zklogin-expired';
export type ZkLoginRestoreStatus = 'ok' | 'expired' | 'missing' | 'clock-unavailable' | 'invalid';

type ChainClock = { epoch: number; epochDurationMs: number; maxEpochDelta: number | null };

type ZkProof = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  proofVersion: number;
};

type Pending = {
  ephemeral: Ed25519Keypair;
  randomness: string;
  maxEpoch: number;
  nonce: string;
  clock?: ChainClock;
};

type ZkSession = Pending & {
  address: string;
  addressSeed: string;
  proof: ZkProof;
};

type AuthResult = {
  type?: string;
  nonce?: string;
  state?: string;
  id_token?: string;
  access_token?: string;
  session_access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  user?: { address?: string; sub?: string; email?: string; name?: string };
  signingKey?: string;
};

const PROOF_KEY = 'mysocial_zklogin_proving';

let pending: Pending | null = null;
let current: ZkSession | null = null;
let proofInFlight = false;
let proofGaveUp = false;
let finishFlight: Promise<{ address: string; keypair: Ed25519Keypair }> | null = null;
let cachedClock: (ChainClock & { at: number }) | null = null;

function markProofInFlight(): void {
  proofInFlight = true;
  try {
    sessionStorage.setItem(PROOF_KEY, '1');
  } catch {
    // ignore quota / private mode
  }
}

function clearProofInFlight(): void {
  proofInFlight = false;
  try {
    sessionStorage.removeItem(PROOF_KEY);
  } catch {
    // ignore
  }
}

/** True while this page is still waiting on the zkLogin prover. */
export function zkLoginProofRunning(): boolean {
  return proofInFlight;
}

/** True while the OAuth session is stored and the zkLogin proof is still being built. */
export function zkLoginProofInFlight(): boolean {
  if (proofInFlight) return true;
  try {
    return sessionStorage.getItem(PROOF_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when a zkLogin nonce is saved and the proof has not been stored yet. */
export function zkLoginPending(): boolean {
  if (proofGaveUp) return false;
  if (pending) return true;
  try {
    return sessionStorage.getItem(PENDING_KEY) != null;
  } catch {
    return false;
  }
}

export function isZkLoginAccount(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(ACCOUNT_FLAG) === '1';
}

export function zkLoginEphemeralKeypair(): Ed25519Keypair | null {
  return current?.ephemeral ?? null;
}

/** zk account that holds the MySo balance. Chain transactions must use this address. */
export function zkLoginChainAddress(): string | null {
  return current?.address ?? null;
}

function persistSessionCache(): void {
  if (!current || typeof window === 'undefined') return;
  sessionStorage.setItem(
    CURRENT_KEY,
    JSON.stringify({
      secretKey: current.ephemeral.getSecretKey(),
      address: current.address,
      addressSeed: current.addressSeed,
      maxEpoch: current.maxEpoch,
      proofPoints: current.proof.proofPoints,
      issBase64Details: current.proof.issBase64Details,
      headerBase64: current.proof.headerBase64,
      proofVersion: current.proof.proofVersion,
    }),
  );
  localStorage.setItem(ACCOUNT_FLAG, '1');
}

function readLegacySessionProof(): { secret: string; record: ZkLoginRestoreRecord } | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(CURRENT_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<ZkLoginRestoreRecord> & { secretKey?: string };
    if (!saved.secretKey || !saved.address || !saved.proofPoints || !saved.addressSeed) return null;
    if (!saved.issBase64Details || !saved.headerBase64 || saved.maxEpoch == null) return null;
    return {
      secret: saved.secretKey,
      record: {
        address: saved.address,
        addressSeed: saved.addressSeed,
        maxEpoch: saved.maxEpoch,
        proofPoints: saved.proofPoints,
        issBase64Details: saved.issBase64Details,
        headerBase64: saved.headerBase64,
        proofVersion: saved.proofVersion ?? PROOF_VERSION,
        sub: saved.sub,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Signer whose address is the zkLogin account. Chain calls such as paid-messaging
 * `setPolicy` read `toMySoAddress()` and `signAndExecuteTransaction`.
 */
export function zkLoginTransactionSigner(ephemeral: Ed25519Keypair): Signer {
  const address = zkLoginChainAddress();
  if (!address) return ephemeral;
  return new Proxy(ephemeral, {
    get(target, prop, receiver) {
      if (prop === 'toMySoAddress') return () => address;
      if (prop === 'signAndExecuteTransaction') {
        return async (input: { transaction: Transaction; client: ClientWithCoreApi }) => {
          const digest = await signAndExecuteTransactionAndWait(
            input.client,
            ephemeral,
            input.transaction,
            {
              logPrefix: 'PaidMessaging',
              senderAddress: address,
              signTransactionBytes: async (txBytes) => {
                const signature = await zkLoginChainSignature(txBytes);
                if (!signature) {
                  throw new Error('Sign in again so this zkLogin account can sign the transaction.');
                }
                return signature;
              },
            },
          );
          if (!digest) {
            throw new Error('Paid messaging transaction did not return a digest.');
          }
          return {
            $kind: 'Transaction' as const,
            Transaction: { digest, status: { success: true } },
          };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Signer;
}

async function requireActiveZkSession(): Promise<ZkSession> {
  if (!current) {
    const restored = await restoreZkLoginSignerStatus();
    if (restored === 'expired' || restored === 'invalid' || restored === 'missing') {
      notifyZkLoginProofExpired();
      throw new Error('Sign in again to refresh zkLogin.');
    }
    if (restored !== 'ok' || !current) {
      throw new Error('Sign in again so this zkLogin account can sign the transaction.');
    }
  }
  let clock: ChainClock;
  try {
    clock = await chainClock();
  } catch {
    throw new Error('Could not read the current epoch.');
  }
  if (zkLoginProofExpiredOnChain(clock.epoch, current.maxEpoch, clock.maxEpochDelta)) {
    await discardUnusableProof();
    notifyZkLoginProofExpired();
    throw new Error('Sign in again to refresh zkLogin.');
  }
  if (!proofAcceptable(current.proof)) {
    await discardUnusableProof();
    throw new Error('Sign in again to refresh zkLogin.');
  }
  return current;
}

/** Wrap an ephemeral signature so the chain accepts it as the zkLogin account. */
export async function zkLoginChainSignature(txBytes: Uint8Array): Promise<string | null> {
  const session = await requireActiveZkSession();
  const signed = await session.ephemeral.signTransaction(txBytes);
  return getZkLoginSignature({
    inputs: {
      proofPoints: session.proof.proofPoints,
      issBase64Details: session.proof.issBase64Details,
      headerBase64: session.proof.headerBase64,
      addressSeed: session.addressSeed,
    },
    maxEpoch: session.maxEpoch,
    userSignature: signed.signature,
  });
}

/** Personal-message intent for owner authentication; never exports the ephemeral key. */
export async function zkLoginPersonalMessageSignature(bytes: Uint8Array): Promise<string | null> {
  const session = await requireActiveZkSession();
  const signed = await session.ephemeral.signPersonalMessage(bytes);
  return getZkLoginSignature({
    inputs: {
      proofPoints: session.proof.proofPoints,
      issBase64Details: session.proof.issBase64Details,
      headerBase64: session.proof.headerBase64,
      addressSeed: session.addressSeed,
    },
    maxEpoch: session.maxEpoch,
    userSignature: signed.signature,
  });
}

export function clearZkLoginSigner(): void {
  current = null;
  pending = null;
  proofGaveUp = false;
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(CURRENT_KEY);
    sessionStorage.removeItem(PROOF_KEY);
    localStorage.removeItem(ACCOUNT_FLAG);
  }
  void clearPersistedZkLoginSigner();
}

function authConfig() {
  const { config, error } = readMySocialAuthConfig();
  if (!config) throw new Error(error || 'MySocial auth is not configured.');
  return config;
}

function rpcUrl(): string {
  return import.meta.env.VITE_MYSO_RPC_URL || 'https://fullnode.testnet.mysocial.network:9000';
}

function saltApi(): string {
  return authConfig().apiBaseUrl.replace(/\/$/, '');
}

async function chainClock(): Promise<ChainClock> {
  if (cachedClock && Date.now() - cachedClock.at < CLOCK_CACHE_MS) {
    const { at: _at, ...clock } = cachedClock;
    return clock;
  }
  const response = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'mysox_getLatestMySoSystemState',
      params: [],
    }),
  });
  const body = (await response.json()) as {
    result?: {
      epoch?: string | number;
      epochDurationMs?: string | number;
      zkloginMaxEpochUpperBoundDelta?: string | number;
    };
  };
  const epoch = Number(body.result?.epoch);
  const duration = Number(body.result?.epochDurationMs);
  const delta = Number(body.result?.zkloginMaxEpochUpperBoundDelta);
  if (!Number.isFinite(epoch)) throw new Error('Could not read the current epoch.');
  const clock: ChainClock = {
    epoch,
    epochDurationMs: Number.isFinite(duration) && duration > 0 ? duration : 86_400_000,
    maxEpochDelta: Number.isFinite(delta) && delta > 0 ? delta : null,
  };
  cachedClock = { ...clock, at: Date.now() };
  return clock;
}

function chainEpochCap(maxEpochDelta: number | null): number {
  return maxEpochDelta != null && maxEpochDelta > 0 ? maxEpochDelta : DEFAULT_MAX_EPOCH_DELTA;
}

function horizonEpochs(epochDurationMs: number, maxEpochDelta: number | null): number {
  const chainCap = chainEpochCap(maxEpochDelta);
  if (getCurrentNetwork() !== 'mainnet') return chainCap;
  const sevenDays = Math.max(1, Math.ceil(SEVEN_DAYS_MS / epochDurationMs));
  return Math.max(1, Math.min(sevenDays, chainCap));
}

function proofExceedsChainCap(epoch: number, maxEpoch: number, maxEpochDelta: number | null): boolean {
  return maxEpoch > epoch + chainEpochCap(maxEpochDelta);
}

export function zkLoginProofExpiredOnChain(
  epoch: number,
  maxEpoch: number,
  maxEpochDelta: number | null,
): boolean {
  return epoch >= maxEpoch || proofExceedsChainCap(epoch, maxEpoch, maxEpochDelta);
}

function jwtClaims(jwt: string): { nonce?: string } {
  const payload = jwt.split('.')[1] ?? '';
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
  const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return JSON.parse(json) as { nonce?: string };
}

function base64UrlBits(value: string): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bits: number[] = [];
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid token encoding.');
    for (let shift = 5; shift >= 0; shift -= 1) bits.push((index >> shift) & 1);
  }
  return bits;
}

function decodePackedClaim(value: string, index: number): string {
  let bits = base64UrlBits(value);
  const first = index % 4;
  if (first === 1) bits = bits.slice(2);
  else if (first === 2) bits = bits.slice(4);
  else if (first !== 0) throw new Error('Issuer claim is not packed.');
  const last = (index + value.length - 1) % 4;
  if (last === 2) bits = bits.slice(0, -2);
  else if (last === 1) bits = bits.slice(0, -4);
  else if (last !== 3) throw new Error('Issuer claim is not packed.');
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2);
  }
  return new TextDecoder().decode(bytes);
}

function extractIssClaim(jwt: string): { value: string; indexMod4: number } {
  const payload = jwt.split('.')[1] ?? '';
  for (let start = 0; start < payload.length; start += 1) {
    if (start % 4 === 3) continue;
    for (let end = start + 8; end <= payload.length; end += 1) {
      const last = (start + (end - start) - 1) % 4;
      if (last === 0) continue;
      try {
        const decoded = decodePackedClaim(payload.slice(start, end), start);
        if (!decoded.startsWith('"iss":') || (!decoded.endsWith(',') && !decoded.endsWith('}'))) continue;
        const parsed = JSON.parse(`{${decoded.slice(0, -1)}}`) as { iss?: string };
        if (typeof parsed.iss === 'string' && Object.keys(parsed).length === 1) {
          return { value: payload.slice(start, end), indexMod4: start % 4 };
        }
      } catch {
        // not the issuer window
      }
    }
  }
  throw new Error('OAuth token is missing the issuer claim.');
}

async function saltFor(accessToken: string, iss: string, aud: string): Promise<string> {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const endpoint = `${saltApi()}/zklogin-salt`;
  const existing = await fetch(endpoint, { headers });
  if (existing.ok) {
    const body = (await existing.json()) as { salt?: string };
    if (body.salt) return body.salt;
  }
  const salt = BigInt(
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  ).toString();
  const saved = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ salt, iss, aud }),
  });
  if (saved.status === 409) {
    const again = await fetch(endpoint, { headers });
    const body = (await again.json()) as { salt?: string };
    if (!body.salt) throw new Error('Could not store the zkLogin salt.');
    return body.salt;
  }
  if (!saved.ok) throw new Error('Could not store the zkLogin salt.');
  return salt;
}

function restorePending(): Pending | null {
  if (pending) return pending;
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw) as {
    secretKey: string;
    randomness: string;
    maxEpoch: number;
    nonce: string;
    clock?: ChainClock;
  };
  pending = {
    ephemeral: Ed25519Keypair.fromSecretKey(saved.secretKey),
    randomness: saved.randomness,
    maxEpoch: saved.maxEpoch,
    nonce: saved.nonce,
    clock: saved.clock && Number.isFinite(saved.clock.epoch) ? saved.clock : undefined,
  };
  return pending;
}

async function beginZkLogin(): Promise<{ nonce: string; state: string }> {
  proofGaveUp = false;
  void loadZkLoginSigner();
  const ephemeral = new Ed25519Keypair();
  const randomness = generateRandomness();
  const clock = await chainClock();
  const maxEpoch = clock.epoch + horizonEpochs(clock.epochDurationMs, clock.maxEpochDelta);
  const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);
  pending = { ephemeral, randomness, maxEpoch, nonce, clock };
  const state = crypto.randomUUID().replace(/-/g, '');
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      secretKey: ephemeral.getSecretKey(),
      randomness,
      maxEpoch,
      nonce,
      state,
      clock,
    }),
  );
  return { nonce, state };
}

function issClaimDecodes(claim: { value: string; indexMod4: number } | undefined): boolean {
  if (!claim?.value || claim.indexMod4 > 2) return false;
  try {
    const decoded = decodePackedClaim(claim.value, claim.indexMod4);
    if (!decoded.startsWith('"iss":') || (!decoded.endsWith(',') && !decoded.endsWith('}'))) return false;
    const parsed = JSON.parse(`{${decoded.slice(0, -1)}}`) as { iss?: string };
    return typeof parsed.iss === 'string' && Object.keys(parsed).length === 1;
  } catch {
    return false;
  }
}

function proofAcceptable(proof: ZkProof): boolean {
  return (
    proof.proofVersion === PROOF_VERSION &&
    proofPointsMatchChain(proof.proofPoints) &&
    issClaimDecodes(proof.issBase64Details) &&
    proof.headerBase64.length > 0
  );
}

async function discardUnusableProof(): Promise<void> {
  current = null;
  await clearPersistedZkLoginSigner();
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(ACCOUNT_FLAG);
  }
}

function notifyZkLoginProofExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ZKLOGIN_PROOF_EXPIRED_EVENT));
}

async function persistCurrent(sub?: string): Promise<void> {
  if (!current) return;
  persistSessionCache();
  await saveZkLoginSigner(current.ephemeral.getSecretKey(), {
    address: current.address,
    addressSeed: current.addressSeed,
    maxEpoch: current.maxEpoch,
    proofPoints: current.proof.proofPoints,
    issBase64Details: current.proof.issBase64Details,
    headerBase64: current.proof.headerBase64,
    proofVersion: current.proof.proofVersion,
    sub,
  });
}

async function activateLoadedProof(loaded: {
  secret: string;
  record: ZkLoginRestoreRecord;
}): Promise<ZkLoginRestoreStatus> {
  const clock = await chainClock().catch(() => null);
  const restoredProof: ZkProof = {
    proofPoints: loaded.record.proofPoints,
    issBase64Details: loaded.record.issBase64Details,
    headerBase64: loaded.record.headerBase64,
    proofVersion: loaded.record.proofVersion ?? PROOF_VERSION,
  };
  if (!clock) return 'clock-unavailable';
  if (zkLoginProofExpiredOnChain(clock.epoch, loaded.record.maxEpoch, clock.maxEpochDelta)) {
    await discardUnusableProof();
    return 'expired';
  }
  if (!proofAcceptable(restoredProof)) {
    await discardUnusableProof();
    return 'invalid';
  }
  current = {
    ephemeral: Ed25519Keypair.fromSecretKey(loaded.secret),
    randomness: '',
    maxEpoch: loaded.record.maxEpoch,
    nonce: '',
    clock,
    address: loaded.record.address,
    addressSeed: loaded.record.addressSeed,
    proof: restoredProof,
  };
  persistSessionCache();
  console.log(
    `[zkLogin] reused proof maxEpoch=${loaded.record.maxEpoch} currentEpoch=${clock.epoch} remaining=${Math.max(0, loaded.record.maxEpoch - clock.epoch)}`,
  );
  return 'ok';
}

export async function restoreZkLoginSignerStatus(): Promise<ZkLoginRestoreStatus> {
  if (zkLoginPending() && !current) return 'missing';
  if (current) {
    const clock = await chainClock().catch(() => null);
    if (!clock) return 'clock-unavailable';
    if (zkLoginProofExpiredOnChain(clock.epoch, current.maxEpoch, clock.maxEpochDelta)) {
      await discardUnusableProof();
      return 'expired';
    }
    if (!proofAcceptable(current.proof)) {
      await discardUnusableProof();
      return 'invalid';
    }
    return 'ok';
  }
  const loaded = (await loadZkLoginSigner().catch(() => null)) ?? readLegacySessionProof();
  if (!loaded) return 'missing';
  return activateLoadedProof(loaded);
}

export async function restoreZkLoginSigner(): Promise<boolean> {
  return (await restoreZkLoginSignerStatus()) === 'ok';
}

async function reuseStoredProofForSubject(sub: string): Promise<string | null> {
  const loaded = (await loadZkLoginSigner().catch(() => null)) ?? readLegacySessionProof();
  if (!loaded?.record.sub || loaded.record.sub !== sub) return null;
  if ((await activateLoadedProof(loaded)) !== 'ok') return null;
  return loaded.record.address;
}

async function reuseStoredProofForAddress(address: string): Promise<boolean> {
  const loaded = (await loadZkLoginSigner().catch(() => null)) ?? readLegacySessionProof();
  if (!loaded) return false;
  if (loaded.record.address.toLowerCase() !== address.toLowerCase()) return false;
  return (await activateLoadedProof(loaded)) === 'ok';
}

async function completeZkLogin(input: { jwt: string; accessToken: string }): Promise<string> {
  const active = restorePending();
  if (!active) throw new Error('zkLogin nonce expired. Sign in again.');
  if (jwtClaims(input.jwt).nonce !== active.nonce) {
    throw new Error('OAuth token nonce does not match zkLogin.');
  }
  const decoded = decodeJwt(input.jwt);
  if (!decoded.sub || !decoded.iss || !decoded.aud) {
    throw new Error('OAuth token is missing zkLogin claims.');
  }
  const reused = await reuseStoredProofForSubject(decoded.sub);
  if (reused) {
    pending = null;
    sessionStorage.removeItem(PENDING_KEY);
    persistSessionCache();
    return reused;
  }
  const salt = await saltFor(input.accessToken, decoded.iss, decoded.aud);
  const addressSeed = genAddressSeed(salt, 'sub', decoded.sub, decoded.aud).toString();
  const address = jwtToAddress(input.jwt, salt, false);
  if (await reuseStoredProofForAddress(address)) {
    pending = null;
    sessionStorage.removeItem(PENDING_KEY);
    await persistCurrent(decoded.sub);
    return address;
  }
  const proveUrl = PROVER_URL.endsWith('/prove') ? PROVER_URL : `${PROVER_URL.replace(/\/$/, '')}/prove`;
  const prove = await fetch(proveUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jwt: input.jwt,
      extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(active.ephemeral.getPublicKey()),
      maxEpoch: active.maxEpoch,
      jwtRandomness: active.randomness,
      salt,
      addressSeed,
      issBase64Details: extractIssClaim(input.jwt),
      headerBase64: input.jwt.split('.')[0],
      keyClaimName: 'sub',
      network: zkLoginProverNetwork(getCurrentNetwork()),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!prove.ok) {
    const raw = await prove.text();
    let message = 'zkLogin prover could not build a proof.';
    try {
      const body = JSON.parse(raw) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      if (raw.trim()) message = raw.trim().slice(0, 240);
    }
    throw new Error(message);
  }
  const proved = (await prove.json()) as {
    proofPoints?: {
      a?: ProofLimb;
      b?: ProofPairs;
      c?: ProofLimb;
    };
    headerBase64?: string;
  };
  const points = proved.proofPoints;
  if (!points?.a || !points.b || !points.c) {
    throw new Error('zkLogin prover returned an incomplete proof.');
  }
  const proofPoints = {
    a: decimalTriple(points.a),
    b: decimalPairs(points.b),
    c: decimalTriple(points.c),
  };
  if (!proofPointsMatchChain(proofPoints)) {
    throw new Error('zkLogin prover returned proof points the chain will not accept.');
  }
  const iss = extractIssClaim(input.jwt);
  current = {
    ...active,
    address,
    addressSeed,
    proof: {
      proofPoints: { a: proofPoints.a, b: proofPoints.b, c: proofPoints.c },
      issBase64Details: iss,
      headerBase64: proved.headerBase64 || input.jwt.split('.')[0] || '',
      proofVersion: PROOF_VERSION,
    },
  };
  pending = null;
  sessionStorage.removeItem(PENDING_KEY);
  await persistCurrent(decoded.sub);
  return address;
}

type ProofElement = string | { element?: string };
type ProofLimb = ProofElement[] | { e0?: ProofElement; e1?: ProofElement; e2?: ProofElement };
type ProofPairs = ProofElement[][] | Record<string, ProofElement>;

function elementToDecimal(element: ProofElement | undefined): string {
  const value = typeof element === 'string' ? element : element?.element ?? '';
  if (/^[0-9]+$/.test(value)) return value;
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return BigInt(`0x${hex || '0'}`).toString();
}

function decimalTriple(value: ProofLimb): string[] {
  if (Array.isArray(value)) return value.map((item) => elementToDecimal(item));
  return ['e0', 'e1', 'e2'].map((key) => elementToDecimal(value[key as 'e0' | 'e1' | 'e2']));
}

function decimalPairs(value: ProofPairs): string[][] {
  if (Array.isArray(value)) return value.map((pair) => pair.map((item) => elementToDecimal(item)));
  return [
    ['e01', 'e00'],
    ['e11', 'e10'],
    ['e20', 'e21'],
  ].map((pair) => pair.map((key) => elementToDecimal(value[key])));
}

function proofPointsMatchChain(points: { a: string[]; b: string[][]; c: string[] }): boolean {
  const decimal = (value: string) => /^[0-9]+$/.test(value);
  return (
    points.a.length === 3 &&
    points.c.length === 3 &&
    points.a.every(decimal) &&
    points.c.every(decimal) &&
    points.a[2] === '1' &&
    points.c[2] === '1' &&
    points.b.length === 3 &&
    points.b.every((pair) => pair.length === 2 && pair.every(decimal)) &&
    points.b[2]?.[0] === '1' &&
    points.b[2]?.[1] === '0'
  );
}

function storeSession(message: AuthResult, accessToken: string, address?: string) {
  const user = { ...(message.user ?? {}) };
  if (address) user.address = address;
  setAuthSessionRaw(
    JSON.stringify({
      access_token: accessToken,
      session_access_token: message.session_access_token ?? accessToken,
      refresh_token: message.refresh_token,
      id_token: message.id_token,
      sub: user.sub,
      user,
      expires_at: message.expires_in != null ? Date.now() + message.expires_in * 1000 : Date.now() + 36e5,
    }),
  );
  window.dispatchEvent(new CustomEvent('mysocial-auth-session-changed'));
}

async function bindZkLoginAddress(address: string, accessToken: string): Promise<void> {
  const response = await fetch(`${saltApi()}/zklogin-address`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address }),
  });
  if (!response.ok) throw new Error('Could not bind the zkLogin address.');
}

/** Store the OAuth session, prove, bind the zk address, then rotate the session JWT. */
async function finishZkLogin(message: AuthResult, accessToken: string): Promise<{ address: string; keypair: Ed25519Keypair }> {
  if (finishFlight) return finishFlight;
  finishFlight = runFinishZkLogin(message, accessToken).finally(() => {
    finishFlight = null;
  });
  return finishFlight;
}

async function runFinishZkLogin(message: AuthResult, accessToken: string): Promise<{ address: string; keypair: Ed25519Keypair }> {
  markProofInFlight();
  storeSession(message, accessToken);
  try {
    const address = await completeZkLogin({ jwt: message.id_token!, accessToken });
    await bindZkLoginAddress(address, accessToken);
    storeSession(message, accessToken, address);
    clearProofInFlight();
    const refreshed = await refreshAuthSessionNow();
    if (refreshed.status === 'revoked') {
      throw new Error('Sign in again to refresh zkLogin.');
    }
    if (refreshed.status === 'refreshed') {
      storeSession(
        {
          ...message,
          session_access_token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          expires_in: refreshed.expiresIn,
        },
        refreshed.accessToken,
        address,
      );
    }
    const keypair = zkLoginEphemeralKeypair();
    if (!keypair) throw new Error('zkLogin signing key is missing.');
    return { address, keypair };
  } catch (err) {
    proofGaveUp = true;
    throw err;
  } finally {
    clearProofInFlight();
    window.dispatchEvent(new CustomEvent('mysocial-auth-session-changed'));
  }
}

/** Continue a proof that was still running when the page reloaded. */
export async function resumePendingZkLogin(): Promise<{ address: string; keypair: Ed25519Keypair } | null> {
  if (proofInFlight || finishFlight) return finishFlight;
  if (!zkLoginPending()) return null;
  const raw = getAuthSessionRaw();
  if (!raw) return null;
  const session = JSON.parse(raw) as AuthResult & { access_token?: string };
  const accessToken = session.session_access_token || session.access_token;
  if (!session.id_token || !accessToken) return null;
  if (session.user?.address && zkLoginEphemeralKeypair()) return null;
  return finishZkLogin(session, accessToken);
}

/**
 * Same zkLogin popup the MySocial web app uses:
 * chain nonce, OAuth from the hosted picker, then a proof from the prover.
 */
export async function signInWithZkLogin(
  provider: 'google' | 'apple' | 'none' = 'none',
  options?: { onAuthWindowClosed?: () => void },
): Promise<{ address: string; keypair: Ed25519Keypair }> {
  const { nonce, state } = await beginZkLogin();
  const { clientId, authOrigin, redirectUri } = authConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    nonce,
    return_origin: window.location.origin,
    mode: 'popup',
    provider,
    code_challenge_method: 'S256',
  });
  const popup = window.open(
    `${authOrigin.replace(/\/$/, '')}/login?${params.toString()}`,
    '_blank',
    'width=420,height=720',
  );
  if (!popup) throw new Error('The sign-in window was blocked.');
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(BROADCAST_CHANNEL_NAME) : null;
  const message = await new Promise<AuthResult>((resolve, reject) => {
    const finish = (data: AuthResult) => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      channel?.removeEventListener('message', onBroadcast);
      channel?.close();
      resolve(data);
    };
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      channel?.close();
      reject(new Error('Sign-in timed out.'));
    }, 180_000);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== new URL(authOrigin).origin) return;
      const data = event.data as AuthResult;
      if (!data || (data.type !== 'MYSOCIAL_AUTH_RESULT' && data.type !== 'MYSOCIAL_AUTH_ERROR')) return;
      finish(data);
    };
    const onBroadcast = (event: MessageEvent) => {
      const data = event.data as AuthResult;
      if (!data || data.nonce !== nonce || data.state !== state) return;
      if (data.type !== 'MYSOCIAL_AUTH_RESULT' && data.type !== 'MYSOCIAL_AUTH_ERROR') return;
      finish(data);
    };
    window.addEventListener('message', onMessage);
    channel?.addEventListener('message', onBroadcast);
  });
  try {
    popup.close();
  } catch {
    // opener policy can block close
  }
  if (message.type === 'MYSOCIAL_AUTH_ERROR') throw new Error(message.error || 'Sign-in failed.');
  if (message.nonce !== nonce || message.state !== state) throw new Error('Sign-in nonce did not match.');
  const accessToken = message.session_access_token || message.access_token;
  if (message.signingKey && accessToken) {
    options?.onAuthWindowClosed?.();
    clearZkLoginSigner();
    storeSession(message, accessToken, message.user?.address);
    return {
      address: message.user?.address || '',
      keypair: Ed25519Keypair.fromSecretKey(message.signingKey),
    };
  }
  if (!message.id_token || !accessToken) throw new Error('Sign-in did not return an OAuth token.');
  options?.onAuthWindowClosed?.();
  return finishZkLogin(message, accessToken);
}

/** Mobile sign-in. The zkLogin nonce is in the OAuth request so the callback can prove. */
export async function startZkLoginRedirect(
  provider: 'google' | 'apple' | 'none' = 'none',
): Promise<void> {
  const { nonce, state } = await beginZkLogin();
  const { clientId, authOrigin, redirectUri } = authConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    nonce,
    return_origin: window.location.origin,
    mode: 'redirect',
    provider,
    code_challenge_method: 'S256',
  });
  window.location.href = `${authOrigin.replace(/\/$/, '')}/login?${params.toString()}`;
}

/** True when this callback belongs to a zkLogin redirect started in this tab. */
export function zkLoginRedirectPending(): boolean {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw) as { state?: string };
    const state = new URLSearchParams(window.location.search).get('state');
    return Boolean(saved.state && state && saved.state === state);
  } catch {
    return false;
  }
}

/** Finish zkLogin from the redirect hash, then leave the OAuth session stored. */
export async function completeZkLoginRedirect(): Promise<boolean> {
  if (!zkLoginRedirectPending()) return false;
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return false;
  const saved = JSON.parse(raw) as { state?: string; nonce?: string };
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams((window.location.hash || '').slice(1));
  const idToken = hash.get('id_token') ?? params.get('id_token');
  const accessToken =
    hash.get('session_access_token') ?? hash.get('access_token') ?? params.get('session_access_token');
  if (!idToken || !accessToken) return false;
  if (params.get('nonce') !== saved.nonce) throw new Error('Sign-in nonce did not match.');
  const expiresIn = hash.get('expires_in') ?? params.get('expires_in');
  try {
    await finishZkLogin(
      {
        id_token: idToken,
        session_access_token: hash.get('session_access_token') ?? undefined,
        access_token: accessToken,
        refresh_token: hash.get('refresh_token') ?? params.get('refresh_token') ?? undefined,
        expires_in: expiresIn ? Number(expiresIn) : undefined,
        user: {
          sub: params.get('sub') ?? hash.get('sub') ?? undefined,
          email: params.get('email') ?? hash.get('email') ?? undefined,
        },
      },
      accessToken,
    );
  } catch (err) {
    console.warn('[zkLogin] proof did not finish; keeping the OAuth session', err);
  }
  return true;
}

export function sessionLooksLikeZkLogin(): boolean {
  const raw = getAuthSessionRaw();
  if (!raw) return false;
  try {
    const session = JSON.parse(raw) as { id_token?: string };
    return Boolean(session.id_token);
  } catch {
    return false;
  }
}
