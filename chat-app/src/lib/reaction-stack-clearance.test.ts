import {describe, expect, it} from 'vitest';
import {
  estimatedChipClusterWidth,
  estimatedBubbleWidth,
  isLargeEmojiMessage,
  needsClearance,
  visibleReactionCount,
} from './reaction-stack-clearance';

describe('estimatedChipClusterWidth', () => {
  it('returns 0 for empty', () => {
    expect(estimatedChipClusterWidth(0)).toBe(0);
  });

  it('matches iOS: count*32 + (count-1)*4 + 10', () => {
    expect(estimatedChipClusterWidth(1)).toBe(32 + 10);
    expect(estimatedChipClusterWidth(2)).toBe(32 * 2 + 4 + 10);
    expect(estimatedChipClusterWidth(4)).toBe(32 * 4 + 4 * 3 + 10);
  });
});

describe('needsClearance', () => {
  it('is false when not same-sender or no reactions', () => {
    expect(
      needsClearance({
        olderSameSender: false,
        prevWidth: 300,
        currWidth: 80,
        reactionCount: 1,
      }),
    ).toBe(false);
    expect(
      needsClearance({
        olderSameSender: true,
        prevWidth: 300,
        currWidth: 80,
        reactionCount: 0,
      }),
    ).toBe(false);
  });

  it('tucks when previous bubble is narrow (no clearance)', () => {
    // prev 80, curr 120, cluster 42 → 80 > 120-42+6 (=84)? no
    expect(
      needsClearance({
        olderSameSender: true,
        prevWidth: 80,
        currWidth: 120,
        reactionCount: 1,
      }),
    ).toBe(false);
  });

  it('pushes when previous bubble is wide (needs clearance)', () => {
    // prev 280, curr 100, cluster ~42 → 280 > 100-42+6 (=64)? yes
    expect(
      needsClearance({
        olderSameSender: true,
        prevWidth: 280,
        currWidth: 100,
        reactionCount: 1,
      }),
    ).toBe(true);
  });
});

describe('estimatedBubbleWidth', () => {
  it('caps deleted and empty image bubbles', () => {
    expect(
      estimatedBubbleWidth({
        text: '',
        isDeleted: true,
        hasImage: false,
        maxWidth: 400,
      }),
    ).toBe(140);
    expect(
      estimatedBubbleWidth({
        text: '',
        isDeleted: false,
        hasImage: true,
        maxWidth: 400,
      }),
    ).toBe(160);
  });

  it('short text is narrower than a long line under the same max', () => {
    const short = estimatedBubbleWidth({
      text: 'hi',
      isDeleted: false,
      hasImage: false,
      maxWidth: 400,
    });
    const long = estimatedBubbleWidth({
      text: 'a'.repeat(80),
      isDeleted: false,
      hasImage: false,
      maxWidth: 400,
    });
    expect(short).toBeLessThan(long);
    expect(long).toBeLessThanOrEqual(400);
  });
});

describe('isLargeEmojiMessage', () => {
  it('accepts up to 3 emoji-only graphemes', () => {
    expect(isLargeEmojiMessage('🔥')).toBe(true);
    expect(isLargeEmojiMessage('🔥🔥')).toBe(true);
  });

  it('rejects words and long emoji runs', () => {
    expect(isLargeEmojiMessage('hi')).toBe(false);
    expect(isLargeEmojiMessage('🔥🔥🔥🔥')).toBe(false);
  });
});

describe('visibleReactionCount', () => {
  it('counts only entries with count > 0', () => {
    expect(visibleReactionCount(undefined)).toBe(0);
    expect(
      visibleReactionCount([
        {count: 2},
        {count: 0},
        {count: 1},
      ]),
    ).toBe(2);
  });
});
