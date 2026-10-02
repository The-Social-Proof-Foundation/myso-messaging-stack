import {describe, expect, it} from 'vitest';

import type {CollectResult} from '../pagination';
import {upsertCollectedSubAgent} from './seed-sub-agent';
import type {SubAgentRow} from './social-api';

function row(id: string, parent: string | null = null): SubAgentRow {
  return {
    agent_object_id: id,
    derived_address: `0x${id}`,
    account_id: '0xacc',
    label: id,
    identity_class: 1,
    capabilities: 3,
    delegatable_caps: 3,
    parent_object_id: parent,
    depth: parent ? 1 : 0,
    registered_by: '0x1',
    expires_at_ms: null,
    active: true,
    created_at_ms: 1,
    deactivated_at_ms: null,
    revoked_at_ms: null,
    updated_at_ms: 1,
    organization_id: '0xorg',
  };
}

function collected(items: SubAgentRow[]): CollectResult<SubAgentRow> {
  return {
    items,
    totalCount: items.length,
    complete: true,
    reason: 'short-page',
    pages: 1,
    partialError: null,
  };
}

describe('upsertCollectedSubAgent', () => {
  it('appends a new child and bumps the total', () => {
    const next = upsertCollectedSubAgent(collected([row('root')]), row('child', 'root'));
    expect(next.items.map((item) => item.agent_object_id)).toEqual(['root', 'child']);
    expect(next.totalCount).toBe(2);
    expect(next.items[1]?.parent_object_id).toBe('root');
  });

  it('replaces a placeholder when the indexed row arrives', () => {
    const seeded = upsertCollectedSubAgent(collected([row('root')]), row('0xChild', 'root'));
    const indexed = {...row('0xchild', 'root'), label: 'Indexed'};
    const next = upsertCollectedSubAgent(seeded, indexed);
    expect(next.items).toHaveLength(2);
    expect(next.totalCount).toBe(2);
    expect(next.items[1]?.label).toBe('Indexed');
  });

  it('starts a list when nothing is cached yet', () => {
    const next = upsertCollectedSubAgent(undefined, row('root'));
    expect(next.items).toHaveLength(1);
    expect(next.totalCount).toBe(1);
    expect(next.complete).toBe(true);
  });
});
