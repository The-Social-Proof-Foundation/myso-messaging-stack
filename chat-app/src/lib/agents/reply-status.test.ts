import {describe, expect, it} from 'vitest';
import {REPLY_STATUS, actionStatus, thinkingLabel, withQueued} from './reply-status';

describe('reply status', () => {
  it('falls back to thinking', () => {
    expect(thinkingLabel(null)).toBe(REPLY_STATUS.thinking);
    expect(thinkingLabel('   ')).toBe(REPLY_STATUS.thinking);
    expect(thinkingLabel(REPLY_STATUS.saving)).toBe('Saving to memory…');
  });
  it('adds how many messages are waiting', () => {
    expect(withQueued('Thinking…', 0)).toBe('Thinking…');
    expect(withQueued('Thinking…', 2)).toBe('Thinking · 2 more queued');
    expect(withQueued(null, 3)).toBeNull();
  });
  it('words an automatic action', () => {
    expect(actionStatus('List my tasks')).toBe('Running: list my tasks…');
    expect(actionStatus('Search my memory…')).toBe('Running: search my memory…');
  });
});
