import { describe, expect, it } from 'vitest';

import {
  buildReportFields,
  threadSafetyActions,
} from './report-conversation';

const CONTENT_KEYS = [
  'message',
  'messages',
  'text',
  'body',
  'ciphertext',
  'encrypted_text',
  'plaintext',
  'content',
];

describe('buildReportFields', () => {
  it('sends the peer, chat, and reason for a 1:1 report', () => {
    const fields = buildReportFields({
      groupId: '0xABC',
      reportedWallet: '0xPEER',
      reason: 'harassment',
      note: 'should not send',
    });
    expect(fields).toEqual({
      group_id: '0xabc',
      reported_wallet: '0xpeer',
      reason: 'harassment',
    });
    const json = JSON.stringify(fields);
    for (const key of CONTENT_KEYS) {
      expect(json.includes(`"${key}"`)).toBe(false);
    }
  });

  it('omits the peer on a group report and keeps a short other-note', () => {
    const fields = buildReportFields({
      groupId: '0xGroup',
      reportedWallet: null,
      reason: 'other',
      note: '  kept  ',
    });
    expect(fields).toEqual({
      group_id: '0xgroup',
      reason: 'other',
      note: 'kept',
    });
    expect(JSON.stringify(fields).includes('"message"')).toBe(false);
  });

  it('caps an other-note at 200 characters', () => {
    const fields = buildReportFields({
      groupId: '0x1',
      reportedWallet: null,
      reason: 'other',
      note: 'a'.repeat(500),
    });
    expect(String(fields.note)).toHaveLength(200);
  });
});

describe('threadSafetyActions', () => {
  it('offers report and block on a 1:1 thread', () => {
    expect(threadSafetyActions('0xpeer')).toEqual({
      report: true,
      block: true,
      leave: false,
    });
  });

  it('offers report and leave on a group', () => {
    expect(threadSafetyActions(null)).toEqual({
      report: true,
      block: false,
      leave: true,
    });
  });
});
