import type {AgentRoomInfo, GroupDigestInfo} from './social-api';

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

export interface DigestVerificationRow {
  seq: number;
  sender: string;
  contentDigest: string;
  contentUri: string;
  createdAtMs: number;
  /** The relayer message this digest was matched to by sender and send time, when loaded. */
  matchedMessageId: string | null;
  /** Signature check result from the SDK for the matched message; `null` if unmatched. */
  senderVerified: boolean | null;
}

/** The slice of a decrypted message needed to correlate it with an on-chain digest. */
export interface VerifiableMessage {
  messageId: string;
  senderAddress: string;
  createdAt: number;
  senderVerified: boolean;
}

/** Digest timestamps and relayer timestamps differ by network latency, not by minutes. */
export const DIGEST_MATCH_WINDOW_MS = 30_000;

/**
 * Pairs each on-chain digest with the closest loaded message from the same sender within
 * {@link DIGEST_MATCH_WINDOW_MS}, consuming each message at most once. A digest with no
 * match is reported as unmatched; it is never reported as verified.
 *
 * What this proves: the digest exists on-chain at that sequence, from that sender, and (for
 * matched messages) the SDK verified the sender's signature. It does not recompute the
 * content hash, which needs the plaintext the room's members hold.
 */
export function matchDigestsToMessages(
  digests: readonly GroupDigestInfo[],
  messages: readonly VerifiableMessage[],
): DigestVerificationRow[] {
  const used = new Set<string>();
  return [...digests]
    .sort((a, b) => a.seq - b.seq)
    .map((digest) => {
      const sender = digest.sender.toLowerCase();
      let best: VerifiableMessage | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const message of messages) {
        if (used.has(message.messageId)) continue;
        if (message.senderAddress.toLowerCase() !== sender) continue;
        const delta = Math.abs(message.createdAt - digest.createdAtMs);
        if (delta <= DIGEST_MATCH_WINDOW_MS && delta < bestDelta) {
          best = message;
          bestDelta = delta;
        }
      }
      if (best) used.add(best.messageId);
      return {
        seq: digest.seq,
        sender: digest.sender,
        contentDigest: digest.contentDigest,
        contentUri: digest.contentUri,
        createdAtMs: digest.createdAtMs,
        matchedMessageId: best?.messageId ?? null,
        senderVerified: best ? best.senderVerified : null,
      };
    });
}

export interface VerificationSummary {
  total: number;
  matched: number;
  verified: number;
  unmatched: number;
  /** Matched messages whose signature check failed; these need attention. */
  failed: number;
}

export function summarizeVerification(rows: readonly DigestVerificationRow[]): VerificationSummary {
  let matched = 0;
  let verified = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.matchedMessageId === null) continue;
    matched += 1;
    if (row.senderVerified) verified += 1;
    else failed += 1;
  }
  return {total: rows.length, matched, verified, unmatched: rows.length - matched, failed};
}
