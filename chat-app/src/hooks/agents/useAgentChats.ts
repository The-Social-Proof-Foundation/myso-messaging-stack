import {useCallback, useMemo} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';

import {
  agentChatFromMetadata,
  attachOrganizations,
  chatsForAgent,
  groupChatsByAgent,
  mergeAgentChatRefs,
  normalizeMetadataHex,
  type AgentChatRef,
  type GroupMetadataLike,
} from '../../lib/agents/agent-chats';
import {fetchOrganizationMessagingGroups, type SubAgentRow} from '../../lib/agents/social-api';
import type {StoredGroup} from '../../lib/group-store';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useAgentConversations} from '../useAgentConversations';
import {useOrganizationMessagingGroups} from './useEnterpriseReads';
import {useSubAgents} from './useSubAgents';

/** `groupsMetadata` reads one dynamic field per group; batch to bound the object fetches. */
const METADATA_BATCH_SIZE = 50;

/**
 * On-chain `Metadata.data` is a `VecMap<String, String>` that the SDK parses as an ordered
 * `{contents: [{key, value}]}` list, not a plain object.
 */
function normalizeParsedMetadata(parsed: unknown): GroupMetadataLike {
  const row = parsed as {
    name?: string;
    uuid?: string;
    creator?: string;
    data?: {contents?: {key?: string; value?: string}[]};
  } | null;
  const data: Record<string, string> = {};
  for (const entry of row?.data?.contents ?? []) {
    if (entry?.key) data[entry.key] = entry.value ?? '';
  }
  return {
    name: row?.name ?? null,
    uuid: row?.uuid ?? null,
    creator: row?.creator ?? null,
    data,
  };
}

function hashIds(ids: string[]): string {
  let hash = 2166136261;
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${ids.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Reads on-chain group metadata for the given groups.
 *
 * This is the authority for "is this group an agent chat, and which agent owns it" — it is
 * chain state, so it works after a reload and on any device without local bookkeeping.
 */
function useGroupMetadata(groupIds: string[]) {
  const client = useMessagingClient();
  const ids = useMemo(() => [...new Set(groupIds.filter(Boolean))].sort(), [groupIds]);
  const key = useMemo(() => hashIds(ids), [ids]);

  return useQuery({
    queryKey: ['agents', 'group-metadata', key],
    enabled: Boolean(client) && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, GroupMetadataLike>> => {
      const out: Record<string, GroupMetadataLike> = {};
      for (let i = 0; i < ids.length; i += METADATA_BATCH_SIZE) {
        const batch = ids.slice(i, i + METADATA_BATCH_SIZE);
        const rows = await client!.messaging.view.groupsMetadata({
          groupIds: batch,
          refresh: true,
        });
        for (const [groupId, parsed] of Object.entries(rows)) {
          out[groupId] = normalizeParsedMetadata(parsed);
        }
      }
      return out;
    },
  });
}

export interface AgentChatIndex {
  refs: AgentChatRef[];
  byAgent: Map<string, AgentChatRef[]>;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
}

/**
 * Every agent chat the wallet can see, merged from independent sources:
 *
 *  1. **chain** — groups the wallet is a member of (discovered from `MemberAdded` events)
 *     whose on-chain metadata says `agent_chat=true`. Self-healing and device-independent.
 *  2. **relayer** — `GET /v1/agent-conversations`. Carries `organizationId`/`groupName`
 *     hints, but its table is insert-only with no backfill, so it is never the only source.
 *
 * `groups` must be the discovered group list from `useGroupDiscovery` so discovery is not
 * repeated (the caller already owns that state).
 */
export function useAgentChatIndex(
  groups: StoredGroup[],
  options: {enabled?: boolean} = {},
): AgentChatIndex {
  const enabled = options.enabled ?? true;
  const agents = useSubAgents(false, {enabled});
  const conversations = useAgentConversations();
  const queryClient = useQueryClient();

  const groupIds = useMemo(() => groups.map((group) => group.groupId), [groups]);
  const metadata = useGroupMetadata(enabled ? groupIds : []);

  const chainRefs = useMemo(() => {
    if (!metadata.data) return [];
    const byGroupId = new Map(groups.map((group) => [group.groupId, group]));
    const refs: AgentChatRef[] = [];
    for (const [groupId, meta] of Object.entries(metadata.data)) {
      const built = agentChatFromMetadata(groupId, meta);
      if (!built) continue;
      const stored = byGroupId.get(groupId);
      refs.push({
        ...built,
        name: built.name ?? stored?.name ?? null,
        createdAt: stored?.createdAt ?? null,
      });
    }
    return refs;
  }, [metadata.data, groups]);

  const relayerRefs = useMemo<AgentChatRef[]>(() => {
    const refs: AgentChatRef[] = [];
    for (const conversation of conversations.conversations) {
      const uuid = conversation.groupUuid ?? '';
      if (!uuid) continue;
      refs.push({
        groupId: conversation.groupId,
        uuid,
        name: conversation.groupName ?? null,
        agentObjectId: normalizeMetadataHex(conversation.creatorSubAgentId),
        creatorActor: normalizeMetadataHex(conversation.creatorActor),
        creatorPrincipal: normalizeMetadataHex(conversation.creatorPrincipal),
        organizationId: conversation.organizationId ?? null,
        createdAt:
          typeof conversation.createdAt === 'number'
            ? conversation.createdAt * 1000
            : null,
        source: 'relayer',
      });
    }
    return refs;
  }, [conversations.conversations]);

  const refs = useMemo(
    () =>
      attachOrganizations(
        mergeAgentChatRefs([chainRefs, relayerRefs]),
        agents.items.map((agent) => ({
          agent_object_id: agent.agent_object_id,
          organization_id: agent.organization_id,
        })),
      ),
    [chainRefs, relayerRefs, agents.items],
  );

  const refresh = useCallback(() => {
    conversations.refresh();
    void metadata.refetch();
    void queryClient.invalidateQueries({queryKey: ['agents', 'organization-messaging-groups']});
  }, [conversations, metadata, queryClient]);

  return {
    refs,
    byAgent: useMemo(() => groupChatsByAgent(refs), [refs]),
    isLoading: agents.isInitialLoading || conversations.loading || metadata.isLoading,
    error: conversations.error ?? metadata.error ?? agents.error ?? null,
    refresh,
  };
}

/**
 * Chats for one agent, including the social indexer's per-organization view.
 *
 * The social read exists because the relayer's agent-group table can permanently miss an
 * event (it has no backfill) while the social indexer is watermark-resumable. Querying it
 * per selected agent keeps the global index cheap — it is one paged request for one org.
 */
export function useAgentChatsForAgent(
  agent: SubAgentRow | null,
  knownRefs: AgentChatRef[],
): {refs: AgentChatRef[]; isLoading: boolean; error: unknown} {
  const orgGroups = useOrganizationMessagingGroups(agent?.organization_id ?? null, {
    enabled: Boolean(agent?.organization_id),
  });

  const socialRefs = useMemo<AgentChatRef[]>(() => {
    if (!agent) return [];
    const wanted = normalizeMetadataHex(agent.agent_object_id);
    if (!wanted) return [];
    const refs: AgentChatRef[] = [];
    for (const row of orgGroups.items) {
      if (normalizeMetadataHex(row.creatorSubAgentId) !== wanted) continue;
      if (!row.groupUuid) continue;
      refs.push({
        groupId: row.groupId,
        uuid: row.groupUuid,
        name: row.groupName ?? null,
        agentObjectId: wanted,
        creatorActor: normalizeMetadataHex(row.creatorActor),
        creatorPrincipal: normalizeMetadataHex(row.creatorPrincipal),
        organizationId: row.organizationId ?? agent.organization_id,
        createdAt: typeof row.createdAtMs === 'number' ? row.createdAtMs : null,
        source: 'social',
      });
    }
    return refs;
  }, [agent, orgGroups.items]);

  const known = useMemo(() => {
    if (!agent) return [];
    const wanted = normalizeMetadataHex(agent.agent_object_id);
    if (!wanted) return [];
    return knownRefs.filter((ref) => ref.agentObjectId === wanted);
  }, [agent, knownRefs]);

  return {
    refs: mergeAgentChatRefs([known, socialRefs]),
    isLoading: orgGroups.isInitialLoading,
    error: orgGroups.error ?? null,
  };
}

function newestChat(refs: AgentChatRef[]): AgentChatRef | null {
  const ready = refs.filter((ref) => ref.uuid);
  if (ready.length === 0) return null;
  return [...ready].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

/**
 * The agent's existing messaging group, from the wallet's known chats first and then the
 * social indexer's organization list. Returns null when this agent has never started a chat.
 */
export async function findAgentChatRef(
  agent: Pick<SubAgentRow, 'agent_object_id' | 'organization_id'>,
  known: AgentChatRef[],
): Promise<AgentChatRef | null> {
  const cached = newestChat(chatsForAgent(known, agent.agent_object_id));
  if (cached) return cached;
  if (!agent.organization_id) return null;

  const wanted = normalizeMetadataHex(agent.agent_object_id);
  const collected: AgentChatRef[] = [];
  const limit = 100;
  for (let page = 0; page < 5; page += 1) {
    const result = await fetchOrganizationMessagingGroups(agent.organization_id, {
      limit,
      offset: page * limit,
    });
    for (const row of result.items) {
      if (!wanted || normalizeMetadataHex(row.creatorSubAgentId) !== wanted || !row.groupUuid) {
        continue;
      }
      collected.push({
        groupId: row.groupId,
        uuid: row.groupUuid,
        name: row.groupName ?? null,
        agentObjectId: wanted,
        creatorActor: normalizeMetadataHex(row.creatorActor),
        creatorPrincipal: normalizeMetadataHex(row.creatorPrincipal),
        organizationId: row.organizationId ?? agent.organization_id,
        createdAt: typeof row.createdAtMs === 'number' ? row.createdAtMs : null,
        source: 'social',
      });
    }
    const match = newestChat(collected);
    if (match) return match;
    if (result.items.length < limit) break;
  }
  return null;
}
