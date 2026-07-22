/**
 * Width-aware reaction clearance for same-sender stacks (iOS ReactionStackClearance parity).
 *
 * Chips hang off the inner corner over the bubble. When the previous same-sender
 * bubble is wide enough to collide with the chip cluster, the current row gets
 * extra top pad; otherwise chips tuck into the gutter with normal stack gap.
 */

export const REACTION_CHIP_CLEARANCE_PX = 18;

const CHIP_ESTIMATE = 32;
const CHIP_SPACING = 4;
const CHIP_OVERHANG = 10;
const COLLISION_FUDGE = 6;
const IMAGE_TILE = 160;
const BUBBLE_PAD_H = 14;
const BODY_FONT_PX = 17;
const LARGE_EMOJI_FONT_PX = 66;
const EMPTY_BUBBLE_WIDTH = 72;

/** Stack gaps matching MessageBubble `mt-2.5` / `mt-0.5`. */
export const STACK_GAP_FIRST_PX = 10;
export const STACK_GAP_CONTINUE_PX = 2;

export function estimatedChipClusterWidth(reactionCount: number): number {
  if (reactionCount <= 0) return 0;
  const chips = reactionCount * CHIP_ESTIMATE;
  const gaps = Math.max(reactionCount - 1, 0) * CHIP_SPACING;
  return chips + gaps + CHIP_OVERHANG;
}

/**
 * Whether chips on `curr` would collide with the older same-sender bubble above.
 * Formula: prevWidth > currWidth - cluster + fudge
 */
export function needsClearance(args: {
  olderSameSender: boolean;
  prevWidth: number;
  currWidth: number;
  reactionCount: number;
}): boolean {
  const {olderSameSender, prevWidth, currWidth, reactionCount} = args;
  if (!olderSameSender || reactionCount <= 0) return false;
  const cluster = estimatedChipClusterWidth(reactionCount);
  return prevWidth > currWidth - cluster + COLLISION_FUDGE;
}

/** iMessage-style large emoji: emoji-only, ≤3 grapheme clusters. */
export function isLargeEmojiMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const graphemes = [...trimmed];
  if (graphemes.length === 0 || graphemes.length > 3) return false;
  // Reject if any grapheme has a letter/digit (keeps pure emoji / ZWJ sequences).
  for (const g of graphemes) {
    if (/\p{L}|\p{N}/u.test(g)) return false;
    if (!/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u200D]/u.test(g)) {
      return false;
    }
  }
  return true;
}

function measureTextWidth(text: string, fontPx: number): number {
  if (typeof document !== 'undefined') {
    const canvas = measureTextWidth.canvas ?? document.createElement('canvas');
    measureTextWidth.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = `${fontPx}px system-ui, -apple-system, sans-serif`;
      return ctx.measureText(text).width;
    }
  }
  // Vitest / SSR fallback — close enough for estimates.
  return text.length * (fontPx > 40 ? 40 : 9);
}
measureTextWidth.canvas = undefined as HTMLCanvasElement | undefined;

export function estimatedBubbleWidth(args: {
  text: string;
  isDeleted: boolean;
  hasImage: boolean;
  maxWidth: number;
}): number {
  const {text, isDeleted, hasImage, maxWidth} = args;
  const cap = Math.max(maxWidth, 80);
  if (isDeleted) {
    return Math.min(cap, 140);
  }
  if (!text && hasImage) {
    return Math.min(cap, IMAGE_TILE);
  }
  if (!text) {
    return Math.min(cap, EMPTY_BUBBLE_WIDTH);
  }
  const largeEmoji = isLargeEmojiMessage(text) && !hasImage;
  const fontPx = largeEmoji ? LARGE_EMOJI_FONT_PX : BODY_FONT_PX;
  const constraint = Math.max(cap - BUBBLE_PAD_H * 2, 40);
  // Single-line measure; multi-line wraps to constraint width.
  const raw = measureTextWidth(text, fontPx);
  const textW = Math.min(raw, constraint);
  let content = Math.ceil(textW) + BUBBLE_PAD_H * 2;
  if (hasImage) {
    content = Math.max(content, IMAGE_TILE);
  }
  return Math.min(cap, Math.max(content, EMPTY_BUBBLE_WIDTH));
}

/** Visible reaction entries (count > 0), same as iOS chip host. */
export function visibleReactionCount(
  reactions: ReadonlyArray<{count: number}> | undefined,
): number {
  if (!reactions?.length) return 0;
  return reactions.filter((r) => r.count > 0).length;
}
