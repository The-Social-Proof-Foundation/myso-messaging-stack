import { describe, expect, it } from 'vitest';
import {
  loginIdentityAction,
  oauthTokenFromAuthResult,
  readLegacySessionCopy,
  serializePendingLogin,
  shouldMintMessagingKey,
  stripLegacyPendingSecret,
} from './identity';

describe('loginIdentityAction', () => {
  it('renews an expired proof without changing person', () => {
    expect(
      loginIdentityAction(
        { secret: 'key', sub: 'subject-a', zkAddress: '0xabc', proofUsable: false },
        'subject-a',
        '0xabc',
      ),
    ).toBe('renew-proof');
  });

  it('reuses a still-valid proof for the same subject', () => {
    expect(
      loginIdentityAction(
        { secret: 'key', sub: 'subject-a', zkAddress: '0xabc', proofUsable: true },
        'subject-a',
        '0xabc',
      ),
    ).toBe('reuse-proof');
  });

  it('does not reuse a key that belongs to another subject', () => {
    expect(
      loginIdentityAction(
        { secret: 'key', sub: 'subject-a', zkAddress: '0xabc', proofUsable: true },
        'subject-b',
        '0xdef',
      ),
    ).toBe('account-switch');
  });

  it('adopts a brand-new key and mints only when nothing is stored', () => {
    expect(loginIdentityAction(null, 'subject-a', '0xabc')).toBe('adopt');
    expect(shouldMintMessagingKey(false)).toBe(true);
    expect(shouldMintMessagingKey(true)).toBe(false);
  });

  it('reuses a legacy row only when the chain address matches', () => {
    expect(
      loginIdentityAction(
        { secret: 'key', zkAddress: '0xAbC', proofUsable: false },
        'subject-a',
        '0xabc',
      ),
    ).toBe('renew-proof');
    expect(
      loginIdentityAction(
        { secret: 'key', zkAddress: '0xabc', proofUsable: true },
        'subject-a',
        '0xdef',
      ),
    ).toBe('account-switch');
  });
});

describe('login handoff storage', () => {
  it('omits the chat secret from the pending OAuth payload', () => {
    const pending = serializePendingLogin({
      randomness: '1',
      maxEpoch: 3,
      nonce: 'nonce',
      state: 'state',
    });
    expect(pending).not.toContain('secretKey');
    expect(JSON.parse(pending)).toEqual({ randomness: '1', maxEpoch: 3, nonce: 'nonce', state: 'state' });
  });

  it('strips a legacy plaintext secret from the pending payload', () => {
    const { pending, secret } = stripLegacyPendingSecret(
      JSON.stringify({ secretKey: 'do-not-keep', nonce: 'n', state: 's' }),
    );
    expect(secret).toBe('do-not-keep');
    expect(pending).not.toContain('secretKey');
    expect(pending).not.toContain('do-not-keep');
  });

  it('reads a legacy session copy so it can be encrypted and deleted', () => {
    const copy = readLegacySessionCopy(JSON.stringify({ secretKey: 'legacy-secret', address: '0x1', sub: 's' }));
    expect(copy?.secret).toBe('legacy-secret');
    expect(readLegacySessionCopy('{"address":"0x1"}')).toBeNull();
  });

  it('ignores a signing key supplied by the auth popup', () => {
    expect(oauthTokenFromAuthResult({ signingKey: 'foreign-key', access_token: 'token' })).toBeNull();
    expect(
      oauthTokenFromAuthResult({
        signingKey: 'foreign-key',
        id_token: 'jwt',
        access_token: 'token',
      }),
    ).toEqual({ idToken: 'jwt', accessToken: 'token' });
  });
});
