import {expectedDigestHex, parseAnchorUri} from './anchor';
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
  /** The transaction that anchored this digest. */
  transactionId: string;
  /** The relayer message this digest was matched to by sender and send time, when loaded. */
  matchedMessageId: string | null;
  /** Signature check result from the SDK for the matched message; `null` if unmatched. */
  senderVerified: boolean | null;
  /**
   * Whether the matched message's text hashes to the on-chain digest. `null` when there is no
   * matched message or its text is not loaded.
   */
  contentVerified: boolean | null;
}

/** The slice of a decrypted message needed to correlate it with an on-chain digest. */
export interface VerifiableMessage {
  messageId: string;
  senderAddress: string;
  createdAt: number;
  senderVerified: boolean;
  /** The decrypted text, when loaded; lets the digest be recomputed and compared. */
  text?: string | null;
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
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  const sameSender = (m: VerifiableMessage, digest: GroupDigestInfo) =>
    m.senderAddress.toLowerCase() === digest.sender.toLowerCase();
  const ordered = [...digests].sort((a, b) => a.seq - b.seq);

  // Digests this app anchored carry the message id in their pointer, which is exact. Resolve
  // those first so a time-window guess can never steal a message that has a precise match.
  const matched = new Map<number, VerifiableMessage>();
  for (const digest of ordered) {
    const id = messageIdFromAnchorUri(digest.contentUri);
    const message = id ? byId.get(id) : undefined;
    if (message && !used.has(message.messageId) && sameSender(message, digest)) {
      matched.set(digest.seq, message);
      used.add(message.messageId);
    }
  }

  return ordered.map((digest) => {
    let best = matched.get(digest.seq) ?? null;
    if (!best) {
      // Anchors made elsewhere carry no message id: pair by sender and send time.
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const message of messages) {
        if (used.has(message.messageId) || !sameSender(message, digest)) continue;
        const delta = Math.abs(message.createdAt - digest.createdAtMs);
        if (delta <= DIGEST_MATCH_WINDOW_MS && delta < bestDelta) {
          best = message;
          bestDelta = delta;
        }
      }
      if (best) used.add(best.messageId);
    }
    const hasText = Boolean(best?.text && best.text.trim());
    const pointer = parseAnchorUri(digest.contentUri);
    return {
      seq: digest.seq,
      sender: digest.sender,
      contentDigest: digest.contentDigest,
      contentUri: digest.contentUri,
      createdAtMs: digest.createdAtMs,
      transactionId: digest.transactionId,
      matchedMessageId: best?.messageId ?? null,
      senderVerified: best ? best.senderVerified : null,
      // The pointer says how the digest was made; an anchor from elsewhere is read as plain sha256.
      contentVerified:
        best && hasText
          ? expectedDigestHex(best.text!, pointer ?? {version: 1, groupUuid: '', messageId: ''}) ===
            digest.contentDigest.toLowerCase()
          : null,
    };
  });
}

/** The message id this app puts in an anchor's pointer, or null for anchors made elsewhere. */
export function messageIdFromAnchorUri(uri: string): string | null {
  return parseAnchorUri(uri)?.messageId ?? null;
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
    // A content mismatch fails a row even when the sender's signature checked out.
    if (row.senderVerified && row.contentVerified !== false) verified += 1;
    else failed += 1;
  }
  return {total: rows.length, matched, verified, unmatched: rows.length - matched, failed};
}
