/**
 * Agent messaging groups: the persistent association between a sub-agent and a
 * `PermissionedGroup<Messaging>`.
 *
 * The on-chain association lives in group metadata, written by the Move
 * `attach_agent_creator_metadata` helper:
 *
 *   agent_chat              = "true"
 *   creator_actor           = hex(agent derived address)      (64 hex chars, no 0x)
 *   creator_principal       = hex(human owner address)
 *   creator_sub_agent_id    = hex(SubAgent object id)         (only when the actor is a sub-agent)
 *   creator_identity_class  = decimal string
 *
 * Notably absent on-chain: the organization id. It is event-only, so we recover it by
 * mapping `creator_sub_agent_id` onto the sub-agent rows we already load. That keeps
 * discovery working from chain state alone — no local/session storage — which is what makes
 * the Agent chats section survive a reload and appear on a second device.
 */

/** Group metadata keys written by `attach_agent_creator_metadata`. */
export const AGENT_CHAT_METADATA_KEYS = {
  agentChat: 'agent_chat',
  creatorActor: 'creator_actor',
  creatorPrincipal: 'creator_principal',
  creatorSubAgentId: 'creator_sub_agent_id',
  creatorIdentityClass: 'creator_identity_class',
} as const;

export const AGENT_CHAT_FLAG_VALUE = 'true';

/** Where a conversation ref was discovered. Higher priority wins on merge. */
export type AgentChatSource = 'chain' | 'social' | 'relayer';

const SOURCE_PRIORITY: Record<AgentChatSource, number> = {
  chain: 3,
  social: 2,
  relayer: 1,
};

export interface AgentChatRef {
  groupId: string;
  uuid: string;
  name: string | null;
  /** `SubAgent` object id this group was created for, when known. */
  agentObjectId: string | null;
  creatorActor: string | null;
  creatorPrincipal: string | null;
  organizationId: string | null;
  createdAt: number | null;
  source: AgentChatSource;
}

/** Parsed group metadata as returned by `client.messaging.view.groupsMetadata`. */
export interface GroupMetadataLike {
  name?: string | null;
  uuid?: string | null;
  creator?: string | null;
  data?: Record<string, string> | null;
}

/**
 * Normalizes a metadata hex value (64 hex chars, no `0x`, lowercase) to canonical
 * `0x`-prefixed form so it compares equal to object ids and addresses from other sources.
 */
export function normalizeMetadataHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,64}$/.test(trimmed)) return null;
  return `0x${trimmed.padStart(64, '0')}`;
}

/** True when the group metadata marks this group as an agent chat. */
export function isAgentChatMetadata(data: Record<string, string> | null | undefined): boolean {
  return (data?.[AGENT_CHAT_METADATA_KEYS.agentChat] ?? '').toLowerCase() === AGENT_CHAT_FLAG_VALUE;
}

/**
 * Builds a ref from a group's metadata, or `null` when the group is not an agent chat.
 * `groupId` is authoritative (the caller derived or received it), while `uuid` comes from
 * metadata because the group id alone cannot be reversed into a uuid.
 */
export function agentChatFromMetadata(
  groupId: string,
  metadata: GroupMetadataLike | null | undefined,
  source: AgentChatSource = 'chain',
): AgentChatRef | null {
  if (!metadata || !isAgentChatMetadata(metadata.data)) return null;
  const data = metadata.data ?? {};
  const uuid = metadata.uuid ?? null;
  if (!uuid) return null;
  return {
    groupId,
    uuid,
    name: metadata.name ?? null,
    agentObjectId: normalizeMetadataHex(data[AGENT_CHAT_METADATA_KEYS.creatorSubAgentId]),
    creatorActor: normalizeMetadataHex(data[AGENT_CHAT_METADATA_KEYS.creatorActor]),
    creatorPrincipal: normalizeMetadataHex(data[AGENT_CHAT_METADATA_KEYS.creatorPrincipal]),
    organizationId: null,
    createdAt: null,
    source,
  };
}

/**
 * Merges refs describing the same group id, preferring the highest-priority source and
 * filling gaps (name, organization, agent id) from lower-priority sources.
 */
export function mergeAgentChatRefs(sources: AgentChatRef[][]): AgentChatRef[] {
  const byGroupId = new Map<string, AgentChatRef>();

  for (const list of sources) {
    for (const ref of list) {
      if (!ref.groupId) continue;
      const existing = byGroupId.get(ref.groupId);
      if (!existing) {
        byGroupId.set(ref.groupId, ref);
        continue;
      }
      const preferred =
        SOURCE_PRIORITY[ref.source] > SOURCE_PRIORITY[existing.source] ? ref : existing;
      const other = preferred === ref ? existing : ref;
      byGroupId.set(ref.groupId, {
        ...preferred,
        uuid: preferred.uuid || other.uuid,
        name: preferred.name ?? other.name,
        agentObjectId: preferred.agentObjectId ?? other.agentObjectId,
        creatorActor: preferred.creatorActor ?? other.creatorActor,
        creatorPrincipal: preferred.creatorPrincipal ?? other.creatorPrincipal,
        organizationId: preferred.organizationId ?? other.organizationId,
        createdAt: preferred.createdAt ?? other.createdAt,
      });
    }
  }

  return [...byGroupId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Refs grouped by the agent they were created for; agent-less refs are dropped. */
export function groupChatsByAgent(refs: AgentChatRef[]): Map<string, AgentChatRef[]> {
  const byAgent = new Map<string, AgentChatRef[]>();
  for (const ref of refs) {
    if (!ref.agentObjectId) continue;
    const list = byAgent.get(ref.agentObjectId) ?? [];
    list.push(ref);
    byAgent.set(ref.agentObjectId, list);
  }
  return byAgent;
}

export function chatsForAgent(refs: AgentChatRef[], agentObjectId: string): AgentChatRef[] {
  const wanted = normalizeMetadataHex(agentObjectId) ?? agentObjectId.toLowerCase();
  return refs.filter((ref) => ref.agentObjectId === wanted);
}

/**
 * Fills `organizationId` on refs whose agent we know about. The organization is not part of
 * group metadata, so this is the only way to place an agent chat under its organization
 * without trusting an indexer.
 */
export function attachOrganizations(
  refs: AgentChatRef[],
  agents: {agent_object_id: string; organization_id: string | null}[],
): AgentChatRef[] {
  const orgByAgent = new Map<string, string | null>();
  for (const agent of agents) {
    orgByAgent.set(agent.agent_object_id.toLowerCase(), agent.organization_id);
  }
  return refs.map((ref) =>
    ref.organizationId || !ref.agentObjectId
      ? ref
      : {...ref, organizationId: orgByAgent.get(ref.agentObjectId.toLowerCase()) ?? null},
  );
}
