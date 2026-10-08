const sameId = (left: string, right: string): boolean =>
  left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();

const bareId = (value: string) => value.replace(/^0x/i, '').toLowerCase();

/**
 * True when an audit entry concerns this agent. Entries name an agent in several places: as the
 * target (grants, revokes), as the actor (things the agent did), or inside the recorded states and
 * metadata (budget and spend entries are targeted at the organization). Matching only `target_id`
 * left agents with an empty log while the organization log listed their actions.
 */
export function auditRowMentionsAgent(
  row: {target_id: string; actor_address: string; prev_state: unknown; new_state: unknown; metadata: unknown},
  agentIds: ReadonlyArray<string>,
): boolean {
  const ids = agentIds.filter(Boolean).map(bareId);
  if (ids.length === 0) return false;
  if (ids.some((id) => sameId(row.target_id ?? '', id) || sameId(row.actor_address ?? '', id))) return true;
  const detail = JSON.stringify([row.prev_state, row.new_state, row.metadata]).toLowerCase();
  return ids.some((id) => detail.includes(id));
}
