import {afterEach, describe, expect, it} from 'vitest';

import {mergePendingDigests, rememberAnchoredDigest, resetPendingDigests} from './pending-digests';
import type {GroupDigestInfo} from './social-api';

const digest = (seq: number, uri: string): GroupDigestInfo => ({
  groupId: 'group-1',
  seq,
  sender: '0xsender',
  recipient: '0xreader',
  contentDigest: `hash-${seq}`,
  contentUri: uri,
  createdAtMs: 1_000,
  transactionId: `tx-${seq}`,
});

afterEach(() => {
  resetPendingDigests();
});

describe('mergePendingDigests', () => {
  it('shows a just-anchored message before the indexer lists it', () => {
    rememberAnchoredDigest(digest(0, 'myso-chat+v2://room/message-1'));
    const rows = mergePendingDigests('group-1', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentUri).toBe('myso-chat+v2://room/message-1');
    expect(rows[0]?.seq).toBe(0);
  });

  it('appends after digests the indexer already has, and ignores a repeat', () => {
    rememberAnchoredDigest({...digest(99, 'myso-chat+v2://room/message-2'), seq: 99});
    rememberAnchoredDigest(digest(0, 'myso-chat+v2://room/message-2'));
    const rows = mergePendingDigests('group-1', [digest(0, 'myso-chat+v2://room/message-1')]);
    expect(rows.map((row) => row.contentUri)).toEqual([
      'myso-chat+v2://room/message-1',
      'myso-chat+v2://room/message-2',
    ]);
    expect(rows[1]?.seq).toBe(1);
  });

  it('drops the temporary row once the indexer returns the same pointer', () => {
    rememberAnchoredDigest(digest(0, 'myso-chat+v2://room/message-1'));
    const indexed = digest(4, 'myso-chat+v2://room/message-1');
    const rows = mergePendingDigests('group-1', [indexed]);
    expect(rows).toEqual([indexed]);
  });
});
