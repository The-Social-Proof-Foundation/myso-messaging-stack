import {describe, expect, it} from 'vitest';

import {CAP_JURY, hasJuryCapability, isSuspended, rosterHealthLine, sortDuties} from './jury';
import type {JurorAssignmentInfo} from './social-api';

function duty(over: Partial<JurorAssignmentInfo>): JurorAssignmentInfo {
  return {
    caseId: '0xc1',
    round: 0,
    agentId: '0xa1',
    status: 1,
    dutyKind: 'accept',
    deadlineMs: 100,
    commitment: null,
    revealed: false,
    caseState: 3,
    subjectKind: 1,
    subjectId: '0x7a5c',
    ...over,
  };
}

describe('juror capability', () => {
  it('is the CAP_JURY bit and nothing else', () => {
    expect(CAP_JURY).toBe(262144);
    expect(hasJuryCapability({capabilities: CAP_JURY | 7})).toBe(true);
    expect(hasJuryCapability({capabilities: 7})).toBe(false);
    expect(hasJuryCapability({capabilities: 524288})).toBe(false);
  });
});

describe('suspension', () => {
  it('lasts only until its end time', () => {
    expect(isSuspended({status: 3, suspendedUntilMs: 500}, 100)).toBe(true);
    expect(isSuspended({status: 3, suspendedUntilMs: 500}, 500)).toBe(false);
    expect(isSuspended({status: 1, suspendedUntilMs: 500}, 100)).toBe(false);
    expect(isSuspended({status: 3, suspendedUntilMs: null}, 100)).toBe(false);
  });
});

describe('duty order', () => {
  it('puts the soonest deadline first and duties waiting on the next phase last', () => {
    const rows = [
      duty({caseId: '0xc3', dutyKind: null, deadlineMs: null}),
      duty({caseId: '0xc2', deadlineMs: 300}),
      duty({caseId: '0xc1', deadlineMs: 100}),
    ];
    expect(sortDuties(rows).map((r) => r.caseId)).toEqual(['0xc1', '0xc2', '0xc3']);
  });

  it('breaks a tie on the case id and leaves its input alone', () => {
    const rows = [duty({caseId: '0xb', deadlineMs: 5}), duty({caseId: '0xa', deadlineMs: 5})];
    expect(sortDuties(rows).map((r) => r.caseId)).toEqual(['0xa', '0xb']);
    expect(rows[0]!.caseId).toBe('0xb');
  });
});

describe('rosterHealthLine', () => {
  it('counts owners, not agents, against the floor', () => {
    const thin = rosterHealthLine({active: 12, suspended: 0, eligibleOwners: 3, minimum: 5});
    expect(thin.thin).toBe(true);
    expect(thin.text).toBe('3 independent owners eligible (5 needed): juries may be unavailable and proposals wait up to 30 days.');
    const ok = rosterHealthLine({active: 1, suspended: 0, eligibleOwners: 1, minimum: 1});
    expect(ok.thin).toBe(false);
    expect(ok.text).toBe('1 independent owner eligible (1 needed) across 1 active juror.');
  });
});
