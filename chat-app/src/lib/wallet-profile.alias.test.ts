import { describe, expect, it } from 'vitest';
import { aliasMemberToProfileAddress } from './wallet-profile';

describe('aliasMemberToProfileAddress', () => {
  it('rewrites the messaging signer to the zkLogin profile wallet', () => {
    expect(
      aliasMemberToProfileAddress(
        '0x520A',
        '0x520a',
        '0x3195b0d',
      ),
    ).toBe('0x3195b0d');
  });

  it('leaves other members unchanged', () => {
    expect(
      aliasMemberToProfileAddress('0xpeer', '0x520a', '0x3195b0d'),
    ).toBe('0xpeer');
  });

  it('leaves the address unchanged when identities are missing or equal', () => {
    expect(aliasMemberToProfileAddress('0x520a', '0x520a', '0x520a')).toBe(
      '0x520a',
    );
    expect(aliasMemberToProfileAddress('0x520a', null, '0x3195')).toBe(
      '0x520a',
    );
  });
});
