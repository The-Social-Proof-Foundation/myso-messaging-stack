import {describe, expect, it} from 'vitest';

import {
  agentChatFromMetadata,
  attachOrganizations,
  chatsForAgent,
  groupChatsByAgent,
  isAgentChatMetadata,
  mergeAgentChatRefs,
  normalizeMetadataHex,
  type AgentChatRef,
} from './agent-chats';

const AGENT_ID = `0x${'a1'.repeat(32)}`;
const AGENT_ID_HEX = 'a1'.repeat(32);
const OWNER = `0x${'b2'.repeat(32)}`;

function metadata(overrides: Record<string, string> = {}, uuid = 'uuid-1') {
  return {
    name: 'Agent Chat',
    uuid,
    creator: AGENT_ID,
    data: {
      agent_chat: 'true',
      creator_actor: AGENT_ID_HEX,
      creator_principal: 'b2'.repeat(32),
      creator_sub_agent_id: AGENT_ID_HEX,
      creator_identity_class: '1',
      ...overrides,
    },
  };
}

function ref(overrides: Partial<AgentChatRef> = {}): AgentChatRef {
  return {
    groupId: '0xgroup1',
    uuid: 'uuid-1',
    name: null,
    agentObjectId: AGENT_ID,
    creatorActor: AGENT_ID,
    creatorPrincipal: OWNER,
    organizationId: null,
    createdAt: null,
    source: 'chain',
    ...overrides,
  };
}

describe('normalizeMetadataHex', () => {
  it('canonicalizes 64-hex values that carry no 0x prefix', () => {
    expect(normalizeMetadataHex(AGENT_ID_HEX)).toBe(AGENT_ID);
  });

  it('is case-insensitive and tolerates an existing 0x prefix', () => {
    expect(normalizeMetadataHex(`0X${AGENT_ID_HEX.toUpperCase()}`)).toBe(AGENT_ID);
  });

  it('left-pads short hex to a full 32-byte id', () => {
    expect(normalizeMetadataHex('ff')).toBe(`0x${'0'.repeat(62)}ff`);
  });

  it('rejects empty and non-hex input', () => {
    expect(normalizeMetadataHex('')).toBeNull();
    expect(normalizeMetadataHex(undefined)).toBeNull();
    expect(normalizeMetadataHex('not-hex')).toBeNull();
    expect(normalizeMetadataHex('ab'.repeat(40))).toBeNull();
  });
});

describe('isAgentChatMetadata', () => {
  it('accepts the Move flag value case-insensitively', () => {
    expect(isAgentChatMetadata({agent_chat: 'true'})).toBe(true);
    expect(isAgentChatMetadata({agent_chat: 'TRUE'})).toBe(true);
  });

  it('rejects missing or non-flag values', () => {
    expect(isAgentChatMetadata({})).toBe(false);
    expect(isAgentChatMetadata({agent_chat: 'false'})).toBe(false);
    expect(isAgentChatMetadata(null)).toBe(false);
    expect(isAgentChatMetadata(undefined)).toBe(false);
  });
});

describe('agentChatFromMetadata', () => {
  it('builds a ref from agent-chat metadata', () => {
    const built = agentChatFromMetadata('0xgroup1', metadata());

    expect(built).not.toBeNull();
    expect(built!.groupId).toBe('0xgroup1');
    expect(built!.uuid).toBe('uuid-1');
    expect(built!.name).toBe('Agent Chat');
    expect(built!.agentObjectId).toBe(AGENT_ID);
    expect(built!.creatorActor).toBe(AGENT_ID);
    expect(built!.creatorPrincipal).toBe(OWNER);
    expect(built!.source).toBe('chain');
  });

  it('returns null for a group that is not an agent chat', () => {
    expect(
      agentChatFromMetadata('0xg', {name: 'DM', uuid: 'u', data: {conversation_kind: 'dm'}}),
    ).toBeNull();
  });

  it('returns null when the uuid is missing, since groupId cannot be reversed', () => {
    expect(agentChatFromMetadata('0xg', {name: 'x', uuid: null, data: {agent_chat: 'true'}})).toBeNull();
  });

  it('tolerates a group created without a sub-agent id (human-attributed)', () => {
    const data = metadata();
    delete (data.data as Record<string, string>).creator_sub_agent_id;

    const built = agentChatFromMetadata('0xg', data);

    expect(built).not.toBeNull();
    expect(built!.agentObjectId).toBeNull();
    expect(built!.creatorActor).toBe(AGENT_ID);
  });
});

describe('mergeAgentChatRefs', () => {
  it('de-duplicates by group id and prefers the highest-priority source', () => {
    const merged = mergeAgentChatRefs([
      [ref({groupId: 'g1', source: 'relayer', name: 'from relayer'})],
      [ref({groupId: 'g1', source: 'chain', name: 'from chain'})],
      [ref({groupId: 'g2', source: 'social', name: 'only social'})],
    ]);

    expect(merged).toHaveLength(2);
    const g1 = merged.find((r) => r.groupId === 'g1')!;
    expect(g1.source).toBe('chain');
    expect(g1.name).toBe('from chain');
    expect(merged.find((r) => r.groupId === 'g2')!.name).toBe('only social');
  });

  it('fills gaps in the preferred ref from lower-priority sources', () => {
    const merged = mergeAgentChatRefs([
      [ref({groupId: 'g1', source: 'chain', name: null, organizationId: null})],
      [ref({groupId: 'g1', source: 'relayer', name: 'Agent Chat', organizationId: '0xorg'})],
    ]);

    expect(merged[0]!.source).toBe('chain');
    expect(merged[0]!.name).toBe('Agent Chat');
    expect(merged[0]!.organizationId).toBe('0xorg');
  });

  it('orders by createdAt descending and ignores refs without a group id', () => {
    const merged = mergeAgentChatRefs([
      [ref({groupId: 'old', createdAt: 1}), ref({groupId: '', createdAt: 99})],
      [ref({groupId: 'new', createdAt: 50})],
    ]);

    expect(merged.map((r) => r.groupId)).toEqual(['new', 'old']);
  });
});

describe('groupChatsByAgent / chatsForAgent', () => {
  it('groups by agent and drops agent-less refs', () => {
    const grouped = groupChatsByAgent([
      ref({groupId: 'g1'}),
      ref({groupId: 'g2'}),
      ref({groupId: 'g3', agentObjectId: null}),
    ]);

    expect(grouped.get(AGENT_ID)?.map((r) => r.groupId)).toEqual(['g1', 'g2']);
    expect(grouped.size).toBe(1);
  });

  it('matches an agent id case-insensitively and with or without 0x', () => {
    const refs = [ref({groupId: 'g1'}), ref({groupId: 'g2', agentObjectId: OWNER})];

    expect(chatsForAgent(refs, AGENT_ID_HEX).map((r) => r.groupId)).toEqual(['g1']);
    expect(chatsForAgent(refs, AGENT_ID.toUpperCase()).map((r) => r.groupId)).toEqual(['g1']);
    expect(chatsForAgent(refs, OWNER).map((r) => r.groupId)).toEqual(['g2']);
  });
});

describe('attachOrganizations', () => {
  it('fills the organization from the agent row because metadata does not carry it', () => {
    const filled = attachOrganizations([ref(), ref({groupId: 'g2', organizationId: '0xexplicit'})], [
      {agent_object_id: AGENT_ID, organization_id: '0xorg'},
    ]);

    expect(filled[0]!.organizationId).toBe('0xorg');
    expect(filled[1]!.organizationId).toBe('0xexplicit');
  });

  it('leaves the organization null when the agent is unknown', () => {
    const filled = attachOrganizations([ref()], []);
    expect(filled[0]!.organizationId).toBeNull();
  });
});
