import {describe, expect, it} from 'vitest';

import {AiCreditApprovalRequiredError} from '@socialproof/memory';

import {MemoryClientError, classifyMemoryError} from './memory-client';

describe('classifyMemoryError', () => {
  it('maps approval-required errors', () => {
    const err = classifyMemoryError(
      new AiCreditApprovalRequiredError('need approval', 50, 80),
    );
    expect(err).toBeInstanceOf(MemoryClientError);
    expect(err.kind).toBe('approval_required');
    expect(err.thresholdMist).toBe(50);
  });

  it('maps insufficient credits', () => {
    const raw = new Error('not enough') as Error & {serverCode?: string};
    raw.serverCode = 'insufficient_ai_credits';
    expect(classifyMemoryError(raw).kind).toBe('insufficient_credits');
  });

  it('maps missing capability copy', () => {
    expect(classifyMemoryError(new Error('E_SUB_AGENT_MISSING_CAP')).kind).toBe(
      'missing_capability',
    );
  });

  it('maps revoked agents', () => {
    expect(classifyMemoryError(new Error('sub-agent not active')).kind).toBe('revoked');
  });

  it('maps fetch failures as unreachable', () => {
    const err = new TypeError('Failed to fetch');
    expect(classifyMemoryError(err).kind).toBe('unreachable');
  });
});
