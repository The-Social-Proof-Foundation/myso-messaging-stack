import {describe, expect, it} from 'vitest';

import {
  AGENT_ROOM_KIND,
  DIGEST_MATCH_WINDOW_MS,
  matchDigestsToMessages,
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
