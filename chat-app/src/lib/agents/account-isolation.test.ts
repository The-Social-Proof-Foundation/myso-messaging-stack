import {describe, expect, it} from 'vitest';

import {
  CROSS_ACCOUNT_FAIL_TOKEN,
  CrossAccountMemoryError,
  assertAgentAccountBinding,
  verifyCrossAccountIsolation,
  type AgentBinding,
} from './account-isolation';

const OWN = `0x${'ab'.repeat(32)}`;
const FOREIGN = `0x${'cd'.repeat(32)}`;
const AGENT = `0x${'11'.repeat(32)}`;

function binding(overrides: Partial<AgentBinding> = {}): AgentBinding {
  return {
    agentObjectId: AGENT,
    agentAccountId: OWN,
    derivedAddress: AGENT,
    chatCreatorActor: AGENT,
    expectedAccountId: OWN,
    ...overrides,
  };
}

describe('assertAgentAccountBinding', () => {
  it('accepts an agent registered under the session account', () => {
    expect(() => assertAgentAccountBinding(binding())).not.toThrow();
  });

  it('compares addresses regardless of 0x prefix or leading zeros', () => {
    expect(() =>
      assertAgentAccountBinding(
        binding({
          agentAccountId: OWN.slice(2),
          expectedAccountId: `0x00${OWN.slice(2)}`,
        }),
      ),
    ).not.toThrow();
  });

  it('refuses an agent registered under another account', () => {
    expect(() => assertAgentAccountBinding(binding({agentAccountId: FOREIGN}))).toThrow(
      CrossAccountMemoryError,
    );
  });

  it('refuses when the chat names a different actor than the agent key', () => {
    expect(() => assertAgentAccountBinding(binding({chatCreatorActor: FOREIGN}))).toThrow(
      /binding mismatch/,
    );
  });

  it('refuses when the session has no memory account', () => {
    expect(() => assertAgentAccountBinding(binding({expectedAccountId: ''}))).toThrow(
      CrossAccountMemoryError,
    );
  });
});

describe('verifyCrossAccountIsolation', () => {
  it('reports isolated when the foreign read is refused', async () => {
    const verdict = await verifyCrossAccountIsolation({
      ownAccountId: OWN,
      foreignAccountId: FOREIGN,
      readMemories: async (accountId) => {
        if (accountId === FOREIGN) throw new Error('403 forbidden');
        return 3;
      },
    });
    expect(verdict).toEqual({isolated: true, ownRows: 3});
  });

  it('reports a policy regression when the foreign read succeeds', async () => {
    const verdict = await verifyCrossAccountIsolation({
      ownAccountId: OWN,
      foreignAccountId: FOREIGN,
      readMemories: async () => 7,
    });
    expect(verdict.isolated).toBe(false);
    if (verdict.isolated === false) {
      expect(verdict.code).toBe(CROSS_ACCOUNT_FAIL_TOKEN);
    }
  });

  it('is inconclusive rather than passing when the same account is supplied twice', async () => {
    const verdict = await verifyCrossAccountIsolation({
      ownAccountId: OWN,
      foreignAccountId: OWN,
      readMemories: async () => 0,
    });
    expect(verdict.isolated).toBeNull();
  });

  it('is inconclusive when an account id is missing', async () => {
    const verdict = await verifyCrossAccountIsolation({
      ownAccountId: OWN,
      foreignAccountId: '',
      readMemories: async () => 0,
    });
    expect(verdict.isolated).toBeNull();
  });
});
