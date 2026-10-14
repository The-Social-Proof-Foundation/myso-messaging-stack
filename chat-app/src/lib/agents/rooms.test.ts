import {contentDigestV1, contentDigestV2} from './anchor';
import {describe, expect, it} from 'vitest';

import {
  AGENT_ROOM_KIND,
  DIGEST_MATCH_WINDOW_MS,
  matchDigestsToMessages,
  messageIdFromAnchorUri,
  roomKindLabel,
  roomTaskLink,
  roomTitle,
  summarizeVerification,
  type VerifiableMessage,
} from './rooms';
import type {GroupDigestInfo} from './social-api';

const digest = (seq: number, sender: string, createdAtMs: number): GroupDigestInfo => ({
  groupId: '0xg',
  seq,
  sender,
  recipient: '0xr',
  contentDigest: 'ab'.repeat(32),
  contentUri: `walrus://${seq}`,
  createdAtMs,
  transactionId: `tx${seq}`,
});

const message = (
  id: string,
  sender: string,
  createdAt: number,
  senderVerified = true,
): VerifiableMessage => ({messageId: id, senderAddress: sender, createdAt, senderVerified});

describe('room labels', () => {
  it('names the agent room kind and falls back for unknown kinds', () => {
    expect(roomKindLabel(AGENT_ROOM_KIND)).toBe('Agent room');
    expect(roomKindLabel(9)).toBe('Room kind 9');
  });

  it('prefers the indexed name and shortens an un-indexed id', () => {
    expect(roomTitle({groupName: ' Deploy ', groupId: '0xabc'})).toBe('Deploy');
    expect(roomTitle({groupName: null, groupId: `0x${'a'.repeat(64)}`})).toBe('Room 0xaaaa…aaaa');
    expect(roomTitle({groupName: '', groupId: '0x12'})).toBe('Room 0x12');
  });

  it('only links well-formed task ids', () => {
    expect(roomTaskLink({taskId: '0x7a5c'})).toBe('0x7a5c');
    expect(roomTaskLink({taskId: 'not-an-id'})).toBeNull();
    expect(roomTaskLink({taskId: null})).toBeNull();
  });
});

describe('matchDigestsToMessages', () => {
  it('pairs a digest with the closest message from the same sender', () => {
    const rows = matchDigestsToMessages(
      [digest(1, '0xA', 1_000)],
      [message('m-far', '0xa', 1_000 + 20_000), message('m-near', '0xa', 1_000 + 500)],
    );
    expect(rows[0]?.matchedMessageId).toBe('m-near');
    expect(rows[0]?.senderVerified).toBe(true);
  });

  it('never matches a different sender or a message outside the window', () => {
    const rows = matchDigestsToMessages(
      [digest(1, '0xa', 1_000), digest(2, '0xa', 2_000)],
      [message('other', '0xb', 1_000), message('late', '0xa', 2_000 + DIGEST_MATCH_WINDOW_MS + 1)],
    );
    expect(rows.map((r) => r.matchedMessageId)).toEqual([null, null]);
    expect(rows.map((r) => r.senderVerified)).toEqual([null, null]);
  });

  it('consumes each message at most once and orders rows by sequence', () => {
    const rows = matchDigestsToMessages(
      [digest(2, '0xa', 1_100), digest(1, '0xa', 1_000)],
      [message('only', '0xa', 1_050)],
    );
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]?.matchedMessageId).toBe('only');
    expect(rows[1]?.matchedMessageId).toBeNull();
  });

  it('reports a failed signature check on a matched message as unverified', () => {
    const rows = matchDigestsToMessages(
      [digest(1, '0xa', 1_000)],
      [message('bad', '0xa', 1_000, false)],
    );
    expect(rows[0]?.senderVerified).toBe(false);
  });
});

describe('summarizeVerification', () => {
  it('counts matched, verified, unmatched and failed rows', () => {
    const rows = matchDigestsToMessages(
      [digest(1, '0xa', 1_000), digest(2, '0xa', 5_000), digest(3, '0xb', 9_000)],
      [message('m1', '0xa', 1_000), message('m2', '0xa', 5_000, false)],
    );
    expect(summarizeVerification(rows)).toEqual({
      total: 3,
      matched: 2,
      verified: 1,
      unmatched: 1,
      failed: 1,
    });
  });
});

describe('anchors made by this app', () => {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  /** A current (v2) anchor: pointer and digest both name the room and message. */
  const anchored = (seq: number, sender: string, messageId: string, text: string, createdAtMs: number) => ({
    ...digest(seq, sender, createdAtMs),
    contentUri: `myso-chat+v2://room-1/${messageId}`,
    contentDigest: hex(contentDigestV2(text, 'room-1', messageId)),
  });
  /** One of the first anchors, made before digests were bound to the room. */
  const legacy = (seq: number, sender: string, messageId: string, text: string, createdAtMs: number) => ({
    ...digest(seq, sender, createdAtMs),
    contentUri: `myso-chat://room-1/${messageId}`,
    contentDigest: hex(contentDigestV1(text)),
  });

  it('matches by the message id in the pointer, however long after the message it was anchored', () => {
    const rows = matchDigestsToMessages(
      [anchored(0, '0xa', 'm-old', 'hello', 9_999_999)],
      [{...message('m-old', '0xa', 1_000), text: 'hello'}],
    );
    expect(rows[0]?.matchedMessageId).toBe('m-old');
    expect(rows[0]?.contentVerified).toBe(true);
    expect(rows[0]?.senderVerified).toBe(true);
  });

  it('still verifies the first anchors, made with a plain sha256', () => {
    const [row] = matchDigestsToMessages(
      [legacy(0, '0xa', 'm1', 'hello', 5)],
      [{...message('m1', '0xa', 5), text: 'hello'}],
    );
    expect(row?.contentVerified).toBe(true);
  });

  it('flags text that no longer hashes to the digest', () => {
    const [row] = matchDigestsToMessages(
      [anchored(0, '0xa', 'm1', 'original', 5)],
      [{...message('m1', '0xa', 5), text: 'edited afterwards'}],
    );
    expect(row?.contentVerified).toBe(false);
    expect(summarizeVerification([row!]).failed).toBe(1);
    expect(summarizeVerification([row!]).verified).toBe(0);
  });

  it('does not recompute when the text is not loaded', () => {
    const [row] = matchDigestsToMessages([anchored(0, '0xa', 'm1', 'x', 5)], [message('m1', '0xa', 5)]);
    expect(row?.matchedMessageId).toBe('m1');
    expect(row?.contentVerified).toBeNull();
  });

  it('never matches a pointer to a message from another sender', () => {
    const [row] = matchDigestsToMessages([anchored(0, '0xa', 'm1', 'x', 5)], [message('m1', '0xb', 5)]);
    expect(row?.matchedMessageId).toBeNull();
  });

  it('keeps an exact pointer match from being taken by a nearer time match', () => {
    const rows = matchDigestsToMessages(
      [digest(0, '0xa', 1_000), anchored(1, '0xa', 'm-exact', 'z', 50_000)],
      [message('m-near-time', '0xa', 1_000), message('m-exact', '0xa', 1)],
    );
    expect(rows.find((r) => r.seq === 1)?.matchedMessageId).toBe('m-exact');
    expect(rows.find((r) => r.seq === 0)?.matchedMessageId).toBe('m-near-time');
  });

  it('carries the transaction id through', () => {
    const [row] = matchDigestsToMessages([anchored(0, '0xa', 'm1', 'x', 5)], [message('m1', '0xa', 5)]);
    expect(row?.transactionId).toBeTruthy();
  });

  it('reads the id back out of a pointer', () => {
    expect(messageIdFromAnchorUri('myso-chat+v2://room-1/abc-123')).toBe('abc-123');
    expect(messageIdFromAnchorUri('myso-chat://room-1/abc-123')).toBe('abc-123');
    expect(messageIdFromAnchorUri('https://elsewhere.dev/x')).toBeNull();
  });
});
