/**
 * Content envelope v2 for the thread UI.
 *
 * Encrypted `event` rows (reactions, edits, deletes, pins, votes) live in the same list as messages so
 * paging cursors and read watermarks keep working. This module folds them into what the UI shows:
 * the visible timeline (events removed, edits and deletes applied) and reaction chips keyed by order.
 */

import { TimelineFold, type MessageEvent } from '@socialproof/myso-messaging-stack';

/** The subset of a thread message the fold needs. */
export interface FoldableMessage {
  messageId: string;
  order: number;
  senderAddress: string;
  senderVerified: boolean;
  text: string;
  isEdited: boolean;
  isDeleted: boolean;
  kind?: string;
  event?: MessageEvent;
}

export interface ReactionChip {
  chainSeq: number;
  emoji: string;
  count: number;
  reactors: string[];
}

export interface FoldedTimeline<T extends FoldableMessage> {
  /** Timeline rows: no events; v2 edits/deletes applied. */
  visible: T[];
  /** v2 reaction chips keyed by target `order`. */
  reactionsByOrder: Map<number, ReactionChip[]>;
  /** Target message ids currently pinned (v2). */
  pinned: string[];
}

export function foldTimeline<T extends FoldableMessage>(rows: readonly T[]): FoldedTimeline<T> {
  const fold = new TimelineFold();
  const timeline: T[] = [];
  for (const row of rows) {
    if (row.kind === 'event') {
      // Unverified events carry no `event` and are ignored by the fold.
      if (row.event) {
        fold.ingest({
          messageId: row.messageId,
          order: row.order,
          senderAddress: row.senderAddress,
          senderVerified: row.senderVerified,
          event: row.event,
        });
      }
      continue;
    }
    fold.ingest({
      messageId: row.messageId,
      order: row.order,
      senderAddress: row.senderAddress,
      senderVerified: row.senderVerified,
    });
    timeline.push(row);
  }

  const reactionsByOrder = new Map<number, ReactionChip[]>();
  const visible = timeline.map((row) => {
    const tallies = fold.reactionsFor(row.messageId);
    if (tallies.length > 0) {
      reactionsByOrder.set(
        row.order,
        tallies.map((t) => ({
          chainSeq: row.order,
          emoji: t.emoji,
          count: t.members.length,
          reactors: t.members,
        })),
      );
    }
    if (fold.isDeleted(row.messageId)) {
      return { ...row, isDeleted: true, text: '' };
    }
    const edit = fold.editFor(row.messageId);
    return edit ? { ...row, text: edit.text, isEdited: true } : row;
  });

  return { visible, reactionsByOrder, pinned: fold.pinnedTargets() };
}

/**
 * Combine legacy (relayer-plaintext) reaction chips with v2 folded chips. A group writes one format
 * at a time, but history may hold both, so chips for the same (order, emoji) are unioned.
 */
export function mergeReactionMaps(
  legacy: Map<number, ReactionChip[]>,
  v2: Map<number, ReactionChip[]>,
): Map<number, ReactionChip[]> {
  if (v2.size === 0) return legacy;
  const out = new Map(legacy);
  for (const [order, chips] of v2) {
    const byEmoji = new Map((out.get(order) ?? []).map((c) => [c.emoji, c]));
    for (const chip of chips) {
      const prev = byEmoji.get(chip.emoji);
      const reactors = prev
        ? [...new Set([...prev.reactors.map((r) => r.toLowerCase()), ...chip.reactors])]
        : chip.reactors;
      byEmoji.set(chip.emoji, { ...chip, reactors, count: reactors.length });
    }
    out.set(order, [...byEmoji.values()]);
  }
  return out;
}

/**
 * Apply my not-yet-echoed v2 reaction toggles (`order|emoji` → add?) on top of the folded chips, so
 * a tap feels instant before the encrypted event round-trips.
 */
export function applyPendingReactions(
  chips: Map<number, ReactionChip[]>,
  pending: ReadonlyMap<string, boolean>,
  me: string,
): Map<number, ReactionChip[]> {
  if (pending.size === 0) return chips;
  const self = me.toLowerCase();
  const out = new Map(chips);
  for (const [key, add] of pending) {
    const sep = key.indexOf('|');
    const order = Number(key.slice(0, sep));
    const emoji = key.slice(sep + 1);
    const list = [...(out.get(order) ?? [])];
    const idx = list.findIndex((c) => c.emoji === emoji);
    const prev = idx >= 0 ? list[idx]! : { chainSeq: order, emoji, count: 0, reactors: [] };
    const others = prev.reactors.filter((r) => r.toLowerCase() !== self);
    const reactors = add ? [...others, self] : others;
    const next = { ...prev, reactors, count: reactors.length };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    const kept = list.filter((c) => c.count > 0);
    if (kept.length > 0) out.set(order, kept);
    else out.delete(order);
  }
  return out;
}
