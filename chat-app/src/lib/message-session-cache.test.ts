import {afterEach, describe, expect, it} from 'vitest';
import {
  clearMessageCache,
  getCachedThread,
  setCachedThread,
} from './message-session-cache';
import {ledgerFromMessages} from './message-page-ledger';
import type {CachedMessage} from './message-session-cache';

function msg(order: number): CachedMessage {
  return {
    messageId: `m-${order}`,
    groupId: 'g',
    order,
    text: String(order),
    senderAddress: '0x1',
    createdAt: order,
    updatedAt: order,
    isEdited: false,
    isDeleted: false,
    attachments: [],
    senderVerified: true,
  };
}

describe('message-session-cache pagination', () => {
  afterEach(() => {
    clearMessageCache();
  });

  it('persists page ledger and restores hasMoreOlder on read', () => {
    const messages = [msg(1), msg(2), msg(3)];
    const pageLedger = ledgerFromMessages(
      messages.map((m) => m.order),
      true,
    );
    setCachedThread('u1', {
      messages,
      pageLedger,
      reactions: new Map(),
    });
    const cached = getCachedThread('u1');
    expect(cached?.pageLedger.hasMoreOlder).toBe(true);
    expect(cached?.hasMore).toBe(true);
    expect(cached?.pageLedger.minOrder).toBe(1);
    expect(cached?.pageLedger.maxOrder).toBe(3);
  });

  it('coerces legacy entries without pageLedger from hasMore + messages', () => {
    setCachedThread('legacy', {
      messages: [msg(5), msg(6)],
      hasMore: true,
      reactions: new Map(),
    });
    const cached = getCachedThread('legacy');
    expect(cached?.pageLedger.minOrder).toBe(5);
    expect(cached?.pageLedger.maxOrder).toBe(6);
    expect(cached?.pageLedger.hasMoreOlder).toBe(true);
  });
});
