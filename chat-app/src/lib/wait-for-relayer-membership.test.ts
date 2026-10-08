import {describe, expect, it} from 'vitest';

import {isRelayerMembershipPending} from './wait-for-relayer-membership';

describe('isRelayerMembershipPending', () => {
  it('treats the relayer "not a member" message as transient', () => {
    expect(
      isRelayerMembershipPending(new Error('Address 0xabc is not a member of group 0xdef')),
    ).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isRelayerMembershipPending(new Error('network down'))).toBe(false);
    expect(isRelayerMembershipPending('nope')).toBe(false);
  });
});
