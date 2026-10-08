import {describe, expect, it} from 'vitest';

import {auditRowMentionsAgent} from './audit';

const AGENT = '0xAbC123';
const ADDR = '0xdef456';
const row = (over: Partial<Parameters<typeof auditRowMentionsAgent>[0]> = {}) => ({
  target_id: '0xorg',
  actor_address: '0xowner',
  prev_state: null,
  new_state: null,
  metadata: null,
  ...over,
});

describe('auditRowMentionsAgent', () => {
  it('matches the agent as target, ignoring 0x and case', () => {
    expect(auditRowMentionsAgent(row({target_id: '0xabc123'}), [AGENT])).toBe(true);
  });
  it('matches the agent as actor, by its derived address', () => {
    expect(auditRowMentionsAgent(row({actor_address: '0xDEF456'}), [AGENT, ADDR])).toBe(true);
  });
  it('matches entries that only name the agent inside recorded state or metadata', () => {
    expect(auditRowMentionsAgent(row({new_state: {agent_id: '0xabc123', cap: 5}}), [AGENT])).toBe(true);
    expect(auditRowMentionsAgent(row({metadata: {agent: 'ABC123'}}), [AGENT])).toBe(true);
  });
  it('does not match unrelated entries', () => {
    expect(auditRowMentionsAgent(row(), [AGENT, ADDR])).toBe(false);
  });
  it('matches nothing when the agent has no ids', () => {
    expect(auditRowMentionsAgent(row({target_id: ''}), ['', ''])).toBe(false);
  });
});
