import {describe, expect, it} from 'vitest';

import {buildAgentTree, flattenAgentTree, groupAgentsByOrganization} from './agent-tree';
import type {SubAgentRow} from './social-api';

function row(id: string, parent: string | null): SubAgentRow {
  return {
    agent_object_id: id,
    derived_address: id,
    account_id: '0xacc',
    label: id,
    identity_class: 1,
    capabilities: 3,
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
  };
}

describe('buildAgentTree', () => {
  it('nests children under their parent', () => {
    const tree = buildAgentTree([row('root', null), row('child', 'root'), row('peer', null)]);
    expect(tree.map((n) => n.agent.agent_object_id)).toEqual(['root', 'peer']);
    expect(tree[0]!.children.map((n) => n.agent.agent_object_id)).toEqual(['child']);
    expect(flattenAgentTree(tree).map((a) => a.agent_object_id)).toEqual([
      'root',
      'child',
      'peer',
    ]);
  });
});

describe('groupAgentsByOrganization', () => {
  it('buckets agents under their organization and keeps nesting', () => {
    const groups = groupAgentsByOrganization(
      [{organization_id: '0xorgA'}, {organization_id: '0xorgB'}],
      [
        row('a-root', null),
        row('a-child', 'a-root'),
        row('b-root', null),
      ].map((agent, index) => ({
        ...agent,
        organization_id: index === 2 ? '0xorgB' : '0xorgA',
      })),
    );

    expect(groups.map((g) => g.organizationId)).toEqual(['0xorgA', '0xorgB']);
    expect(groups[0]!.agents.map((n) => n.agent.agent_object_id)).toEqual(['a-root']);
    expect(groups[0]!.agents[0]!.children.map((n) => n.agent.agent_object_id)).toEqual(['a-child']);
  });

  it('keeps an empty organization bucket so the section can show its empty state', () => {
    const groups = groupAgentsByOrganization([{organization_id: '0xorgA'}], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.agents).toEqual([]);
  });

  it('collects org-less and unknown-org agents into a trailing ungrouped bucket', () => {
    const agents = [
      {...row('orphan', null), organization_id: null},
      {...row('other', null), organization_id: '0xunknown'},
    ];

    const groups = groupAgentsByOrganization([{organization_id: '0xorgA'}], agents);

    expect(groups.map((g) => g.organizationId)).toEqual(['0xorgA', null]);
    expect(groups[1]!.agents.map((n) => n.agent.agent_object_id).sort()).toEqual([
      'orphan',
      'other',
    ]);
  });

  it('returns no buckets when there is nothing at all', () => {
    expect(groupAgentsByOrganization([], [])).toEqual([]);
  });
});
