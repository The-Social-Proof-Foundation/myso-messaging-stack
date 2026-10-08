import {describe, expect, it} from 'vitest';
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';

import {
  DELEGATE_CAPABILITIES,
  DELEGATE_MAX_TTL_MS,
  DelegateError,
  delegateKeyRef,
  isValidDelegateName,
  parseMyDataKey,
  delegateAad,
  encryptDelegateSeed,
  validateDelegatePolicy,
} from './automation-delegate';

/**
 * Reference opener. This is a line-for-line mirror of `decryptSeed` in
 * `myso-memory/services/automation-sidecar/src/encrypt.ts`; if the two ever
 * disagree, the browser encrypts something the bridge cannot open.
 */
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

function bridgeKeyPair() {
  const {privateKey} = generateKeyPairSync('x25519');
  const der = privateKey.export({format: 'der', type: 'pkcs8'});
  const raw = Buffer.from(der.subarray(der.length - 32));
  const pub = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  return {privateRaw: raw, publicRaw: Buffer.from(pub.subarray(pub.length - 32))};
}

function bridgeOpen(envelope: string, privateRaw: Buffer, publicRaw: Buffer, aad: Uint8Array): Buffer {
  const raw = Buffer.from(envelope, 'base64url');
  expect(raw[0]).toBe(1);
  const ephemeralPublic = Buffer.from(raw.subarray(1, 33));
  const iv = raw.subarray(33, 45);
  const body = raw.subarray(45);
  const shared = diffieHellman({
    privateKey: createPrivateKey({key: Buffer.concat([X25519_PKCS8, privateRaw]), format: 'der', type: 'pkcs8'}),
    publicKey: createPublicKey({key: Buffer.concat([X25519_SPKI, ephemeralPublic]), format: 'der', type: 'spki'}),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, publicRaw]), 'myso-automation-delegate-v1', 32),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

describe('encryptDelegateSeed', () => {
  it('produces an envelope the bridge opens', async () => {
    const pair = bridgeKeyPair();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const encrypted_key = await encryptDelegateSeed(
      seed,
      {id: 'k1', publicKey: new Uint8Array(pair.publicRaw)},
      '0xAccount',
      'nightly',
      '0xAgent',
    );
    const opened = bridgeOpen(encrypted_key, pair.privateRaw, pair.publicRaw, delegateAad('0xaccount', 'nightly', '0xagent'));
    expect(new Uint8Array(opened)).toEqual(seed);
  });

  it('does not contain the seed and differs every time', async () => {
    const pair = bridgeKeyPair();
    const key = {id: 'k1', publicKey: new Uint8Array(pair.publicRaw)};
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const a = await encryptDelegateSeed(seed, key, '0xa', 'n', '0xb');
    const b = await encryptDelegateSeed(seed, key, '0xa', 'n', '0xb');
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').includes(Buffer.from(seed))).toBe(false);
  });

  it('is bound to its account, name and agent', async () => {
    const pair = bridgeKeyPair();
    const encrypted_key = await encryptDelegateSeed(
      crypto.getRandomValues(new Uint8Array(32)),
      {id: 'k1', publicKey: new Uint8Array(pair.publicRaw)},
      '0xa',
      'n',
      '0xb',
    );
    for (const other of [delegateAad('0xz', 'n', '0xb'), delegateAad('0xa', 'm', '0xb'), delegateAad('0xa', 'n', '0xz')]) {
      expect(() => bridgeOpen(encrypted_key, pair.privateRaw, pair.publicRaw, other)).toThrow();
    }
  });

  it('refuses a seed that is not 32 bytes', async () => {
    const pair = bridgeKeyPair();
    await expect(
      encryptDelegateSeed(new Uint8Array(31), {id: 'k1', publicKey: new Uint8Array(pair.publicRaw)}, '0xa', 'n', '0xb'),
    ).rejects.toBeInstanceOf(DelegateError);
  });
});

describe('delegateAad', () => {
  it('treats ids as equal across case and zero padding', () => {
    expect(delegateAad('0x00ABC', 'n', '0x0DEF')).toEqual(delegateAad('0xabc', 'n', '0xdef'));
  });
});

describe('parseMyDataKey', () => {
  it('parses id:key', () => {
    const key = parseMyDataKey(`k1:${Buffer.alloc(32, 7).toString('base64url')}`);
    expect(key?.id).toBe('k1');
    expect(key?.publicKey).toHaveLength(32);
  });

  it('is null when unset or blank', () => {
    expect(parseMyDataKey(undefined)).toBeNull();
    expect(parseMyDataKey('  ')).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(() => parseMyDataKey('nokey')).toThrow(DelegateError);
    expect(() => parseMyDataKey('k1:short')).toThrow(DelegateError);
    expect(() => parseMyDataKey('bad id:' + Buffer.alloc(32).toString('base64url'))).toThrow(DelegateError);
  });
});

describe('validateDelegatePolicy', () => {
  const now = 1_800_000_000_000;
  const ok = {name: 'nightly', expiresAtMs: now + 7 * 24 * 3600 * 1000, maxActionSpendMist: '1000000'};

  it('accepts a bounded delegate', () => {
    expect(() => validateDelegatePolicy(ok, now)).not.toThrow();
  });

  it('requires a bounded lifetime', () => {
    expect(() => validateDelegatePolicy({...ok, expiresAtMs: now + 60_000}, now)).toThrow(/hour/);
    expect(() => validateDelegatePolicy({...ok, expiresAtMs: now + DELEGATE_MAX_TTL_MS + 1}, now)).toThrow(/90 days/);
    expect(() => validateDelegatePolicy({...ok, expiresAtMs: Number.NaN}, now)).toThrow(DelegateError);
  });

  it('requires a positive spending limit', () => {
    for (const bad of ['', '0', '-5', '1.5', 'abc', '00']) {
      expect(() => validateDelegatePolicy({...ok, maxActionSpendMist: bad}, now)).toThrow(/spending limit/);
    }
  });

  it('requires a plain name', () => {
    for (const bad of ['', 'a b', 'a/b', 'x'.repeat(65)]) {
      expect(() => validateDelegatePolicy({...ok, name: bad}, now)).toThrow(/Name the delegate/);
    }
  });
});

describe('delegate identity', () => {
  it('grants memory and nothing else', () => {
    // read 1 | write 2 | mydata 4
    expect(DELEGATE_CAPABILITIES).toBe(7);
  });

  it('builds the ref a job selects it by', () => {
    expect(delegateKeyRef('nightly')).toBe('delegate:nightly');
    expect(isValidDelegateName('nightly')).toBe(true);
  });
});
