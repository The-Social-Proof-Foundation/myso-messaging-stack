import { describe, expect, it } from 'vitest';
import {
  otherMemberAddresses,
  pickDmPeer,
  selfIdentityKeys,
} from './self-identity';

/** A zkLogin user is a principal plus an ephemeral messaging key. */
const PRINCIPAL = '0x3195B0DEa77347027ae462a1450b2af0be1e7979dd89556ff9e71a15980ee53c';
const MESSAGING = '0x7f2991e46e99ca8ed200ed70b63bd4a4c53424632f3e753aa730b7d732c4573f';
/** The peer, also identifiable by their own principal + messaging key. */
const PEER_PRINCIPAL =
  '0x179a92afe6646fa3666d6e5230897b39d40d66b56b03cdc253ca416a4c2827a4';
const PEER_MESSAGING =
  '0xa79c63c6e05bdffb8fbba16d2398e16b71ef09ba26b4bb64ade36283a8f1e06e';

const selfKeys = selfIdentityKeys([MESSAGING, PRINCIPAL]);

describe('selfIdentityKeys', () => {
  it('recognises both wallets of a zkLogin account', () => {
    expect(selfKeys.has(PRINCIPAL.toLowerCase())).toBe(true);
    expect(selfKeys.has(MESSAGING.toLowerCase())).toBe(true);
    expect(selfKeys.size).toBe(2);
  });

  it('ignores missing identities and normalises case and padding', () => {
    const keys = selfIdentityKeys([undefined, null, '  ', '0xABC']);
    expect([...keys]).toEqual(['0xabc']);
  });
});

describe('pickDmPeer', () => {
  it('finds the peer when the roster holds both of my wallets', () => {
    // The bug report: counting the viewer's messaging key as a member made a 1:1
    // chat render two avatars. Both self rows must be excluded.
    const roster = [PEER_MESSAGING, MESSAGING, PRINCIPAL];
    expect(pickDmPeer(roster, selfKeys)).toBe(PEER_MESSAGING);
    expect(otherMemberAddresses(roster, selfKeys)).toEqual([PEER_MESSAGING]);
  });

  it('does not need my principal to be a member row', () => {
    expect(pickDmPeer([PEER_MESSAGING, MESSAGING], selfKeys)).toBe(PEER_MESSAGING);
  });

  it('works while the messaging keypair is still deriving', () => {
    // Only the stored principal is known yet; the peer is still unambiguous.
    const principalOnly = selfIdentityKeys([PRINCIPAL]);
    expect(pickDmPeer([PEER_MESSAGING, PRINCIPAL], principalOnly)).toBe(PEER_MESSAGING);
  });

  it('never returns one of my own addresses as the peer', () => {
    const roster = [PEER_MESSAGING, MESSAGING];
    const peer = pickDmPeer(roster, selfIdentityKeys([PRINCIPAL]));
    // Ambiguous (the surviving non-principal row is in fact me), so report nothing
    // rather than persisting the viewer as this conversation's peer.
    expect(peer).toBeNull();
  });

  it('refuses to guess when a third address of mine remains unrecognised', () => {
    // A rotated messaging key keeps its permissions row on-chain and the client has no
    // mapping back to its owner: the count is 2, so this stays unresolved by design.
    const rotatedMessagingKey = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';
    expect(pickDmPeer([PEER_MESSAGING, rotatedMessagingKey], selfKeys)).toBeNull();
  });

  it('returns null for groups, empty rosters and peer duplicates', () => {
    expect(pickDmPeer([], selfKeys)).toBeNull();
    expect(pickDmPeer([MESSAGING], selfKeys)).toBeNull();
    expect(pickDmPeer([PEER_PRINCIPAL, PEER_MESSAGING, MESSAGING], selfKeys)).toBeNull();
  });

  it('matches regardless of address case', () => {
    const roster = [PEER_MESSAGING.toUpperCase().replace('0X', '0x'), MESSAGING];
    expect(pickDmPeer(roster, selfKeys)).toBe(roster[0]);
  });

  it('counts a duplicated wallet once, not once per casing', () => {
    const roster = [PEER_MESSAGING, PEER_MESSAGING.toUpperCase(), MESSAGING];
    expect(otherMemberAddresses(roster, selfKeys)).toEqual([PEER_MESSAGING]);
    expect(pickDmPeer(roster, selfKeys)).toBe(PEER_MESSAGING);
  });
});
