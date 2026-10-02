import {describe, expect, it} from 'vitest';

import {buildAgentTree} from './agent-tree';
import {agentForestToChart, agentInitials, agentRoleLabel} from './agent-chart';
import {CAP} from './capabilities';
import type {SubAgentRow} from './social-api';

function row(
  id: string,
  parent: string | null,
  extras: Partial<SubAgentRow> = {},
): SubAgentRow {
  return {
    agent_object_id: id,
    derived_address: `0x${id}address0000`,
    account_id: '0xacc',
    label: id,
    identity_class: 1,
    capabilities: CAP.MEMORY_READ | CAP.MEMORY_WRITE | CAP.AI_SPEND,
    delegatable_caps: 0,
    parent_object_id: parent,
    depth: parent ? 1 : 0,
    registered_by: '0x1',
    expires_at_ms: null,
    active: true,
    created_at_ms: 0,
    deactivated_at_ms: null,
    revoked_at_ms: null,
    updated_at_ms: 0,
    organization_id: '0xorg',
    ...extras,
  };
}

describe('agentForestToChart', () => {
  it('nests children, counts the branch, and keeps multiple roots as siblings', () => {
    const chart = agentForestToChart(
      buildAgentTree([
        row('root', null, {label: 'Research lead'}),
        row('child', 'root', {label: 'Field scout'}),
        row('leaf', 'child'),
        row('peer', null, {label: 'Peer'}),
      ]),
    );

    expect(chart.map((node) => node.name)).toEqual(['Research lead', 'Peer']);
    expect(chart[0]?.reportsCount).toBe(1);
    expect(chart[0]?.teamHeadcount).toBe(2);
    expect(chart[0]?.role).toBe('Chat assistant');
    expect(chart[0]?.initials).toBe('RL');
    expect(chart[0]?.depth).toBe(0);
    expect(chart[0]?.children?.[0]?.depth).toBe(1);
    expect(chart[0]?.children?.[0]?.parentName).toBe('Research lead');
    expect(chart[0]?.children?.[0]?.children?.[0]?.name).toBe('leaf');
    expect(chart[0]?.children?.[0]?.children?.[0]?.depth).toBe(2);
    expect(chart[1]?.children).toBeUndefined();
  });

  it('treats revoked as the status even when the agent is also inactive', () => {
    const chart = agentForestToChart(
      buildAgentTree([
        row('gone', null, {label: 'Gone', active: false, revoked_at_ms: 10}),
        row('paused', null, {label: 'Paused', active: false, capabilities: 1}),
      ]),
    );

    expect(chart.map((node) => node.status)).toEqual(['revoked', 'inactive']);
    expect(chart[1]?.role).toBe('Custom');
  });
});

describe('agentInitials', () => {
  it('uses two letters from a single word and initials from a phrase', () => {
    expect(agentInitials('ada')).toBe('AD');
    expect(agentInitials('  ')).toBe('?');
  });
});

describe('agentRoleLabel', () => {
  it('names known presets and falls back to Custom', () => {
    expect(agentRoleLabel(0)).toBe('Custom');
  });
});
