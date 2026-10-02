import { decodeMySoPrivateKey } from '@socialproof/myso/cryptography';
import {
  Ed25519Keypair,
  Ed25519PublicKey,
} from '@socialproof/myso/keypairs/ed25519';
import { fromHex, normalizeMySoAddress } from '@socialproof/myso/utils';

const DERIVATION_DOMAIN = 'mysocial-agent-v1';

/** Organization-less agents (e.g. a child whose parent row has no org) hash a zero id. */
const ZERO_ORGANIZATION_ID = `0x${'0'.repeat(64)}`;

export interface AgentKeyPath {
  /** `AgenticOrganization` object id the agent belongs to (root agents) or inherits (children). */
  organizationId: string | null;
  /** Per-owner agent slot; the next free slot is the owner's total registered agent count. */
  index: number;
}

export interface DerivedAgentKey {
  keypair: Ed25519Keypair;
  /** 32-byte Ed25519 seed; this is the `key` the memory server client signs with. */
  seed: Uint8Array;
  publicKey: Uint8Array;
  /** On-chain `derived_address` for `memory::register_sub_agent*`. */
  address: string;
  path: AgentKeyPath;
}

function humanSecretKeyBytes(humanKeypair: Ed25519Keypair): Uint8Array {
  return decodeMySoPrivateKey(humanKeypair.getSecretKey()).secretKey;
}

function organizationIdBytes(organizationId: string | null): Uint8Array {
  return fromHex(normalizeMySoAddress(organizationId ?? ZERO_ORGANIZATION_ID));
}

function u32BigEndian(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Agent key index must be a u32, got ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Deterministically derives an agent keypair from the signed-in human key:
 * `sha256("mysocial-agent-v1" || human secret key || organizationId || u32be(index))`.
 * Nothing is persisted; the same login re-creates the same agent keys on any device.
 */
export async function deriveAgentKeypair(
  humanKeypair: Ed25519Keypair,
  path: AgentKeyPath,
): Promise<DerivedAgentKey> {
  const material = concatBytes([
    new TextEncoder().encode(DERIVATION_DOMAIN),
    humanSecretKeyBytes(humanKeypair),
    organizationIdBytes(path.organizationId),
    u32BigEndian(path.index),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', material);
  const seed = new Uint8Array(digest);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const publicKey = keypair.getPublicKey().toRawBytes();
  return {
    keypair,
    seed,
    publicKey,
    address: agentDerivedAddress(publicKey),
    path,
  };
}

/** MySo address of an Ed25519 public key (`blake2b256(0x00 || pk)`), used as `derived_address`. */
export function agentDerivedAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: ${publicKey.length}`);
  }
  return new Ed25519PublicKey(publicKey).toMySoAddress();
}

/**
 * Finds the derivation slot that produced `derivedAddress` by scanning indices
 * `0..maxIndex` under `organizationId`. Agent rows from the social server carry the
 * address but not the slot, so this is how a returning session recovers each agent key.
 */
export async function findAgentKeypair(
  humanKeypair: Ed25519Keypair,
  derivedAddress: string,
  organizationId: string | null,
  maxIndex: number,
): Promise<DerivedAgentKey | null> {
  const want = normalizeMySoAddress(derivedAddress);
  for (let index = 0; index <= maxIndex; index++) {
    const candidate = await deriveAgentKeypair(humanKeypair, {
      organizationId,
      index,
    });
    if (candidate.address === want) {
      return candidate;
    }
  }
  return null;
}
