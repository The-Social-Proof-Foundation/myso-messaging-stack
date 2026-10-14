import {sha256} from '@noble/hashes/sha2.js';

/** `message_log::MAX_CONTENT_URI_BYTES`. */
export const MAX_ANCHOR_URI_BYTES = 2048;

const encoder = new TextEncoder();

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Anchor pointer schemes. The scheme says how the digest was made, so an older anchor keeps
 * verifying after the format improves:
 *  - `myso-chat://<room>/<message>`: v1, digest = sha256(text).
 *  - `myso-chat+v2://<room>/<message>`: v2, digest = sha256(domain ‖ room ‖ message ‖ text).
 */
const V1_PREFIX = 'myso-chat://';
const V2_PREFIX = 'myso-chat+v2://';
const V2_DOMAIN = 'myso-anchor-v2';

export interface AnchorPointer {
  version: 1 | 2;
  groupUuid: string;
  messageId: string;
}

export function parseAnchorUri(uri: string): AnchorPointer | null {
  for (const [prefix, version] of [[V2_PREFIX, 2], [V1_PREFIX, 1]] as const) {
    if (!uri.startsWith(prefix)) continue;
    const rest = uri.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    return {version, groupUuid: rest.slice(0, slash), messageId: rest.slice(slash + 1)};
  }
  return null;
}

/**
 * What goes on-chain: a digest of the message, never the message. The v2 digest is bound to its
 * room and message id, so the same words sent twice, or in two rooms, never produce the same
 * digest, and one precomputed table of common messages cannot be reused against it.
 */
export function contentDigestV2(text: string, groupUuid: string, messageId: string): Uint8Array {
  return sha256(encoder.encode(`${V2_DOMAIN}\0${groupUuid}\0${messageId}\0${text}`));
}

/** Plain sha256 of the text: how the first anchors were made. */
export function contentDigestV1(text: string): Uint8Array {
  return sha256(encoder.encode(text));
}

/** Hex digest the chain should hold for `text` under the scheme the pointer declares. */
export function expectedDigestHex(text: string, pointer: AnchorPointer): string {
  return hexOf(
    pointer.version === 2
      ? contentDigestV2(text, pointer.groupUuid, pointer.messageId)
      : contentDigestV1(text),
  );
}

/** Where a reader can find the message off-chain; a pointer, not content. */
export function anchorUri(groupUuid: string, messageId: string): string {
  const uri = `${V2_PREFIX}${groupUuid}/${messageId}`;
  if (encoder.encode(uri).length > MAX_ANCHOR_URI_BYTES) {
    throw new Error('That message id is too long to anchor.');
  }
  return uri;
}

/** One anchor per message per room: the contract rejects a repeated key, so a double click is harmless. */
export function anchorDedupeKey(groupUuid: string, messageId: string): Uint8Array {
  return sha256(encoder.encode(`anchor:${groupUuid}:${messageId}`));
}

/** The contract also wants a per-sender nonce that has never been used. */
export function anchorNonce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): bigint {
  let value = 0n;
  for (const byte of random(16)) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * The indexer ids a digest as `<transaction digest>:<event index>`. A reader looking it up in an
 * explorer wants the transaction digest alone.
 */
export function transactionDigestOf(indexerId: string): string {
  return indexerId.split(':')[0] ?? indexerId;
}

export interface AnchoredInfo {
  seq: number;
  /** The transaction digest that published the anchor. */
  transactionId: string;
  /** Hex digest held on-chain. */
  contentDigest: string;
}

/** The digests the indexer has for this room, keyed by the message each one was matched to. */
export function anchoredMessageIds(
  rows: readonly {
    matchedMessageId: string | null;
    seq: number;
    transactionId: string;
    contentDigest: string;
  }[],
): Map<string, AnchoredInfo> {
  const out = new Map<string, AnchoredInfo>();
  for (const row of rows) {
    if (!row.matchedMessageId) continue;
    out.set(row.matchedMessageId, {
      seq: row.seq,
      transactionId: transactionDigestOf(row.transactionId),
      contentDigest: row.contentDigest,
    });
  }
  return out;
}
