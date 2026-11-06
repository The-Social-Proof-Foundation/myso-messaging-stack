import { describe, expect, it } from 'vitest';

import { applyPendingReactions, foldTimeline, mergeReactionMaps, type FoldableMessage } from './timeline-fold';

const alice = '0x' + 'aa'.repeat(32);
const bob = '0x' + 'bb'.repeat(32);

function row(order: number, sender: string, extra: Partial<FoldableMessage> = {}): FoldableMessage {
  return {
    messageId: `m${order}`,
    order,
    senderAddress: sender,
    senderVerified: true,
    text: `text ${order}`,
    isEdited: false,
    isDeleted: false,
    kind: 'text',
    ...extra,
  };
}

describe('foldTimeline', () => {
  it('hides events and applies reactions, edits and deletes', () => {
    const { visible, reactionsByOrder } = foldTimeline([
      row(1, alice),
      row(2, bob),
      row(3, bob, { kind: 'event', event: { type: 'reaction', target: 'm1', emoji: '👍', add: true } }),
      row(4, alice, { kind: 'event', event: { type: 'edit', target: 'm1', text: 'edited' } }),
      row(5, bob, { kind: 'event', event: { type: 'delete', target: 'm2' } }),
    ]);
    expect(visible.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    expect(visible[0]).toMatchObject({ text: 'edited', isEdited: true });
    expect(visible[1]).toMatchObject({ isDeleted: true, text: '' });
    expect(reactionsByOrder.get(1)).toEqual([{ chainSeq: 1, emoji: '👍', count: 1, reactors: [bob] }]);
  });

  it('ignores unverified event rows', () => {
    const { visible, reactionsByOrder } = foldTimeline([
      row(1, alice),
      row(2, bob, { kind: 'event' }),
    ]);
    expect(visible).toHaveLength(1);
    expect(reactionsByOrder.size).toBe(0);
  });
});

describe('reaction merging', () => {
  it('unions legacy and v2 reactors for the same emoji', () => {
    const merged = mergeReactionMaps(
      new Map([[1, [{ chainSeq: 1, emoji: '👍', count: 1, reactors: [alice] }]]]),
      new Map([[1, [{ chainSeq: 1, emoji: '👍', count: 2, reactors: [alice, bob] }]]]),
    );
    expect(merged.get(1)?.[0]).toMatchObject({ count: 2 });
  });

  it('applies my pending toggles optimistically', () => {
    const chips = new Map([[1, [{ chainSeq: 1, emoji: '👍', count: 1, reactors: [alice] }]]]);
    expect(applyPendingReactions(chips, new Map([['1|👍', false]]), alice).get(1)).toBeUndefined();
    expect(applyPendingReactions(chips, new Map([['1|❤️', true]]), bob).get(1)).toHaveLength(2);
  });
});
