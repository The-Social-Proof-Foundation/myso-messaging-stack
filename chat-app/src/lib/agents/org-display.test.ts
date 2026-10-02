import {describe, expect, it} from 'vitest';

import {ORG_PERM} from './org-permissions';
import {
  formatTimestamp,
  groupOrganizationMembers,
  humanizeKey,
  permissionSummary,
  titleizeStatus,
} from './org-display';

describe('titleizeStatus', () => {
  it('title-cases snake and kebab statuses', () => {
    expect(titleizeStatus('pending')).toBe('Pending');
    expect(titleizeStatus('on_leave')).toBe('On leave');
    expect(titleizeStatus('')).toBe('Unknown');
  });
});

describe('humanizeKey', () => {
  it('turns role and action keys into sentences', () => {
    expect(humanizeKey('memory_administrator')).toBe('Memory administrator');
    expect(humanizeKey('grant_role')).toBe('Grant role');
    expect(humanizeKey('')).toBe('—');
  });
});

describe('permissionSummary', () => {
  it('lists permission names and handles an empty mask', () => {
    expect(permissionSummary(ORG_PERM.MEMORY_READ | ORG_PERM.DASHBOARD_VIEWER)).toBe(
      'Read shared memory, View dashboard',
    );
    expect(permissionSummary(0)).toBe('No permissions');
  });
});

describe('groupOrganizationMembers', () => {
  it('collapses one-bit grants for the same wallet into a single member', () => {
    const members = groupOrganizationMembers(
      [
        {member_address: '0xabc', permission_kind: ORG_PERM.MEMORY_READ, active: true},
        {member_address: '0xabc', permission_kind: ORG_PERM.MEMORY_WRITE, active: true},
        {member_address: '0xdef', permission_kind: ORG_PERM.AUDITOR, active: false},
      ],
      [{member_address: '0xabc', role_name: 'admin', active: true}],
    );

    expect(members).toEqual([
      {
        address: '0xabc',
        permissionMask: ORG_PERM.MEMORY_READ | ORG_PERM.MEMORY_WRITE,
        roles: ['admin'],
        active: true,
      },
      {
        address: '0xdef',
        permissionMask: ORG_PERM.AUDITOR,
        roles: [],
        active: false,
      },
    ]);
  });
});

describe('formatTimestamp', () => {
  it('rejects empty and unparseable values', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('not-a-date')).toBe('—');
    expect(formatTimestamp(Date.now())).toBe('just now');
  });
});
