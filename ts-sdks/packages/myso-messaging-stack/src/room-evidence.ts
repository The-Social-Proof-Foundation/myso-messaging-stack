// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import {anchorUri, expectedDigestHex, parseAnchorUri} from './anchors.js';

export interface RoomMessageAnchor<Sequence extends string | number = string> {
  seq: Sequence;
  sender: string;
  contentDigest: string;
  contentUri: string;
  createdAtMs: number;
  transactionId: string;
}

export interface DigestVerificationRow<Sequence extends string | number = number> {
  seq: Sequence;
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
 * The caller supplies trusted chain/indexer anchors for the selected room. This
 * function correlates them with SDK-decrypted messages and recomputes the text
 * hash. It does not establish chain finality, agent authority, or the truth of
 * a message's claims. Missing plaintext/signatures never count as verified.
 */
export function matchDigestsToMessages<Sequence extends string | number>(
  digests: readonly RoomMessageAnchor<Sequence>[],
  messages: readonly VerifiableMessage[],
  options: { groupUuid: string },
): DigestVerificationRow<Sequence>[] {
  anchorUri(options.groupUuid, "validation");
  const used = new Set<string>();
  const seenSequences = new Set<string>();
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  const sameSender = (m: VerifiableMessage, digest: RoomMessageAnchor<Sequence>) =>
    m.senderAddress.toLowerCase() === digest.sender.toLowerCase();
  // Never sort u64 sequence numbers through floating point.
  const sequence = (value: Sequence): bigint => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Unsafe anchor sequence number');
    if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid anchor sequence');
    const parsed = BigInt(value);
    if (parsed > 18446744073709551615n) throw new Error('Anchor sequence exceeds u64');
    if (seenSequences.has(String(parsed))) throw new Error('Duplicate anchor sequence');
    seenSequences.add(String(parsed));
    return parsed;
  };
  const ordered = digests.map((digest) => ({digest, seq: sequence(digest.seq)}))
    .sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0).map(({digest}) => digest);

  // Digests this app anchored carry the message id in their pointer, which is exact. Resolve
  // those first so a time-window guess can never steal a message that has a precise match.
  const matched = new Map<Sequence, VerifiableMessage>();
  for (const digest of ordered) {
    const pointer = parseAnchorUri(digest.contentUri);
    const id = pointer?.groupUuid === options.groupUuid ? pointer.messageId : null;
    const message = id ? byId.get(id) : undefined;
    if (message && !used.has(message.messageId) && sameSender(message, digest)) {
      matched.set(digest.seq, message);
      used.add(message.messageId);
    }
  }

  return ordered.map((digest) => {
    let best = matched.get(digest.seq) ?? null;
    // An explicit pointer is authoritative about which message it names. Do not
    // "repair" a wrong room/message by guessing a nearby message with equal text.
    if (!best && !parseAnchorUri(digest.contentUri) && !digest.contentUri.startsWith('myso-chat')) {
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
    const hasText = typeof best?.text === 'string';
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
        best && hasText && (!pointer || pointer.groupUuid === options.groupUuid)
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
  /** Matched messages whose signature or content hash failed. */
  failed: number;
  /** Matched messages whose signature or plaintext hash is unavailable. */
  unchecked: number;
}

export function summarizeVerification(rows: readonly DigestVerificationRow<string | number>[]): VerificationSummary {
  let matched = 0;
  let verified = 0;
  let failed = 0;
  let unchecked = 0;
  for (const row of rows) {
    if (row.matchedMessageId === null) continue;
    matched += 1;
    if (row.senderVerified === false || row.contentVerified === false) failed += 1;
    else if (row.senderVerified === true && row.contentVerified === true) verified += 1;
    else unchecked += 1;
  }
  return {total: rows.length, matched, verified, unmatched: rows.length - matched, failed, unchecked};
}
