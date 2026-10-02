import {describe, expect, it} from 'vitest';

import {classifyAgentChatError, formatAgentChatError} from './format-agent-chat-error';

describe('classifyAgentChatError', () => {
  it('classifies a missing platform membership as non-retryable', () => {
    const info = classifyAgentChatError(
      new Error('MoveAbort ... has_joined_platform failed with ENotPermitted'),
    );
    expect(info.kind).toBe('platform_not_joined');
    expect(info.retryable).toBe(false);
    expect(info.message).toMatch(/platform/i);
  });

  it('classifies EAlreadyJoined as retryable', () => {
    const info = classifyAgentChatError(new Error('abort code: EAlreadyJoined'));
    expect(info.kind).toBe('already_joined');
    expect(info.retryable).toBe(true);
  });

  it('classifies an agent-signature mismatch', () => {
    const info = classifyAgentChatError(new Error('EAgentSenderMismatch'));
    expect(info.kind).toBe('agent_must_sign');
    expect(info.retryable).toBe(false);
  });

  it('classifies a missing messaging capability', () => {
    expect(classifyAgentChatError(new Error('ESubAgentMissingCap')).kind).toBe(
      'missing_capability',
    );
    expect(classifyAgentChatError(new Error('cap_message_send missing')).kind).toBe(
      'missing_capability',
    );
  });

  it('classifies a revoked or deactivated agent', () => {
    expect(classifyAgentChatError(new Error('ESubAgentNotActive')).kind).toBe('agent_inactive');
    expect(classifyAgentChatError(new Error('this agent was revoked')).kind).toBe('agent_inactive');
  });

  it('treats relayer membership lag as retryable indexing', () => {
    const info = classifyAgentChatError(new Error('{"code":"NOT_GROUP_MEMBER"}'));
    expect(info.kind).toBe('indexing');
    expect(info.retryable).toBe(true);
  });

  it('classifies gas failures', () => {
    expect(classifyAgentChatError(new Error('No valid gas coins')).kind).toBe('gas');
  });

  it('classifies a duplicate group', () => {
    expect(classifyAgentChatError(new Error('object already exists')).kind).toBe('already_exists');
  });

  it('falls back to the raw message for unknown failures', () => {
    const info = classifyAgentChatError(new Error('something unusual happened'));
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('something unusual happened');
    expect(info.retryable).toBe(true);
  });

  it('handles non-Error throwables', () => {
    const info = classifyAgentChatError('plain string failure');
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('plain string failure');
  });

  it('provides a non-empty message for every classification', () => {
    for (const input of [
      'ENotPermitted',
      'EAgentSenderMismatch',
      'ESubAgentMissingCap',
      'NOT_GROUP_MEMBER',
      '',
    ]) {
      expect(formatAgentChatError(new Error(input)).length).toBeGreaterThan(0);
    }
  });
});
