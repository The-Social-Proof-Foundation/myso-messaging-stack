import {describe, expect, it} from 'vitest';

import {
  agentNamesByDerivedAddress,
  conversationPeerLabel,
  isKnownAgentAddress,
  knownAgentAddressSet,
} from './agent-display-name';

const AGENT = '0x2663000000000000000000000000000000000000000000000000000000005bf0';

describe('conversationPeerLabel', () => {
  const names = agentNamesByDerivedAddress([
    {derived_address: AGENT, label: 'Researcher'},
    {derived_address: '0xabc', label: '   '},
  ]);

  it('uses the agent name for an agent address', () => {
    expect(conversationPeerLabel(AGENT.toUpperCase(), names, '0x2663…5bf0')).toBe('Researcher');
  });

  it('keeps the profile label for a person', () => {
    expect(conversationPeerLabel('0x111', names, 'Brandon Shaw')).toBe('Brandon Shaw');
  });

  it('ignores a blank agent label', () => {
    expect(conversationPeerLabel('0xabc', names, '0xabc…')).toBe('0xabc…');
  });

  it('matches a bare metadata hex to the padded derived address', () => {
    const padded = `0x${'11'.repeat(32)}`;
    const named = agentNamesByDerivedAddress([{derived_address: padded, label: 'Scout'}]);
    expect(conversationPeerLabel('11'.repeat(32), named, '0x1111…')).toBe('Scout');
  });
});

describe('knownAgentAddressSet', () => {
  it('treats derived addresses and creator actors as the same agent', () => {
    const padded = `0x${'22'.repeat(32)}`;
    const known = knownAgentAddressSet([padded.toUpperCase()], ['22'.repeat(32)]);
    expect(isKnownAgentAddress(padded, known)).toBe(true);
    expect(isKnownAgentAddress('0x33', known)).toBe(false);
    expect(known.size).toBe(1);
  });
});
