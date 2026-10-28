import type {AgentRoomInfo} from './social-api';

/** `messaging::room_kind_agent_room()`; the only room kind defined on-chain. */
export const AGENT_ROOM_KIND = 1;

export function roomKindLabel(kind: number): string {
  return kind === AGENT_ROOM_KIND ? 'Agent room' : `Room kind ${kind}`;
}

/** Display name: the indexed group name, else a short id so an un-indexed room is still tappable. */
export function roomTitle(room: Pick<AgentRoomInfo, 'groupName' | 'groupId'>): string {
  const name = room.groupName?.trim();
  if (name) return name;
  const id = room.groupId;
  return id.length > 12 ? `Room ${id.slice(0, 6)}…${id.slice(-4)}` : `Room ${id}`;
}

/** A room binding is only shown as a task link when the task id is a real object id. */
export function roomTaskLink(room: Pick<AgentRoomInfo, 'taskId'>): string | null {
  const id = room.taskId;
  return id && /^0x[0-9a-fA-F]{1,64}$/.test(id) ? id : null;
}

/** Shared verification logic requires the selected room UUID, independently of an anchor pointer. */
export { DIGEST_MATCH_WINDOW_MS, matchDigestsToMessages, messageIdFromAnchorUri,
  summarizeVerification, type DigestVerificationRow, type VerifiableMessage,
  type VerificationSummary } from '@socialproof/myso-messaging-stack';
