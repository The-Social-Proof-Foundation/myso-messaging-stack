import {describe, expect, it} from 'vitest';
import {deriveMySoAddressFromPublicKey} from '@socialproof/memory/account';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';

import {
  agentDerivedAddress,
  deriveAgentKeypair,
  findAgentKeypair,
} from './agent-keys';

const HUMAN = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
const OTHER_HUMAN = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9));
const ORG_A = `0x${'a1'.repeat(32)}`;
const ORG_B = `0x${'b2'.repeat(32)}`;

describe('deriveAgentKeypair', () => {
  it('returns the same address for the same inputs', async () => {
    const first = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 0});
    const second = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 0});
    expect(first.address).toBe(second.address);
    expect(Array.from(first.seed)).toEqual(Array.from(second.seed));
  });

  it('gives a different key for a different index', async () => {
    const a = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 0});
    const b = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 1});
    expect(a.address).not.toBe(b.address);
  });

  it('gives a different key for a different organization', async () => {
    const a = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 0});
    const b = await deriveAgentKeypair(HUMAN, {organizationId: ORG_B, index: 0});
    expect(a.address).not.toBe(b.address);
  });

  it('gives a different key for a different human', async () => {
    const a = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 0});
    const b = await deriveAgentKeypair(OTHER_HUMAN, {organizationId: ORG_A, index: 0});
    expect(a.address).not.toBe(b.address);
  });

  it('treats unpadded and padded organization ids the same', async () => {
    const padded = await deriveAgentKeypair(HUMAN, {
      organizationId: `0x${'0'.repeat(62)}ab`,
      index: 3,
    });
    const short = await deriveAgentKeypair(HUMAN, {organizationId: '0xab', index: 3});
    expect(short.address).toBe(padded.address);
  });

  it('rejects indices outside u32', async () => {
    await expect(
      deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: -1}),
    ).rejects.toThrow(/u32/);
    await expect(
      deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 2 ** 32}),
    ).rejects.toThrow(/u32/);
  });

  it('matches @socialproof/memory deriveMySoAddressFromPublicKey', async () => {
    const agent = await deriveAgentKeypair(HUMAN, {organizationId: ORG_A, index: 4});
    const fromSdk = await deriveMySoAddressFromPublicKey(agent.publicKey);
    expect(agent.address).toBe(fromSdk);
    expect(agentDerivedAddress(agent.publicKey)).toBe(fromSdk);
    expect(agent.keypair.toMySoAddress()).toBe(fromSdk);
  });
});

describe('findAgentKeypair', () => {
  it('recovers the slot that produced an address', async () => {
    const agent = await deriveAgentKeypair(HUMAN, {organizationId: ORG_B, index: 5});
    const found = await findAgentKeypair(HUMAN, agent.address, ORG_B, 10);
    expect(found?.path.index).toBe(5);
    expect(found?.address).toBe(agent.address);
  });

  it('returns null when the address is outside the scanned range', async () => {
    const agent = await deriveAgentKeypair(HUMAN, {organizationId: ORG_B, index: 5});
    expect(await findAgentKeypair(HUMAN, agent.address, ORG_B, 4)).toBeNull();
    expect(await findAgentKeypair(HUMAN, agent.address, ORG_A, 10)).toBeNull();
  });
});
