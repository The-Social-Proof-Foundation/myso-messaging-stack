import {describe, expect, it} from 'vitest';

import {agentCountLabel, formatByteSize, formatMysoUnits, graphqlNumber} from './profile-graphql';

describe('graphqlNumber', () => {
  it('reads indexer strings and numbers', () => {
    expect(graphqlNumber('2')).toBe(2);
    expect(graphqlNumber(1)).toBe(1);
    expect(graphqlNumber(null)).toBeNull();
    expect(graphqlNumber('nope')).toBeNull();
  });
});

describe('agentCountLabel', () => {
  it('pluralizes and notes inactive agents', () => {
    expect(agentCountLabel(1, 1)).toBe('1 agent');
    expect(agentCountLabel('12', '12')).toBe('12 agents');
    expect(agentCountLabel(4, 1)).toBe('4 agents · 1 active');
  });
});

describe('formatMysoUnits', () => {
  it('keeps whole amounts and trims decimals', () => {
    expect(formatMysoUnits('0')).toBe('0 MySo');
    expect(formatMysoUnits(1.5)).toBe('1.5 MySo');
    expect(formatMysoUnits(null)).toBe('—');
  });
});

describe('formatByteSize', () => {
  it('scales bytes', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(2048)).toBe('2.0 KB');
  });
});
