import {beforeEach, describe, expect, it} from 'vitest';
import {
  REVEAL_FRESH_MS,
  REVEAL_MAX_MS,
  REVEAL_MIN_MS,
  markRevealShown,
  resetRevealRegistry,
  revealDurationMs,
  revealedCount,
  shouldReveal,
} from './reveal';

beforeEach(resetRevealRegistry);

describe('revealDurationMs', () => {
  it('is quick for a short reply and never longer than the cap', () => {
    expect(revealDurationMs(0)).toBe(REVEAL_MIN_MS);
    expect(revealDurationMs(20)).toBe(REVEAL_MIN_MS);
    expect(revealDurationMs(450)).toBe(1000);
    expect(revealDurationMs(900)).toBe(2000);
    expect(revealDurationMs(50_000)).toBe(REVEAL_MAX_MS);
  });
});

describe('revealedCount', () => {
  it('moves from nothing to everything over the duration', () => {
    expect(revealedCount(100, 0, 1000)).toBe(0);
    expect(revealedCount(100, 500, 1000)).toBe(50);
    expect(revealedCount(100, 1000, 1000)).toBe(100);
    expect(revealedCount(100, 9999, 1000)).toBe(100);
  });
  it('is safe on empty or zero-length input', () => {
    expect(revealedCount(0, 100, 1000)).toBe(0);
    expect(revealedCount(100, 100, 0)).toBe(100);
    expect(revealedCount(100, -50, 1000)).toBe(0);
  });
});

describe('shouldReveal', () => {
  const now = 1_000_000;
  const base = {messageId: 'm1', createdAt: now - 500, now, reducedMotion: false};

  it('plays for a reply that just arrived', () => {
    expect(shouldReveal(base)).toBe(true);
  });
  it('never plays for history, however it is loaded', () => {
    expect(shouldReveal({...base, createdAt: now - REVEAL_FRESH_MS - 1})).toBe(false);
    expect(shouldReveal({...base, createdAt: undefined})).toBe(false);
    expect(shouldReveal({...base, createdAt: Number.NaN})).toBe(false);
  });
  it('does not replay once it has been shown', () => {
    markRevealShown('m1');
    expect(shouldReveal(base)).toBe(false);
    expect(shouldReveal({...base, messageId: 'm2'})).toBe(true);
  });
  it('respects reduced motion and edits', () => {
    expect(shouldReveal({...base, reducedMotion: true})).toBe(false);
    expect(shouldReveal({...base, edited: true})).toBe(false);
  });
  it('tolerates a little clock drift but not a message from the far future', () => {
    expect(shouldReveal({...base, createdAt: now + 30_000})).toBe(true);
    expect(shouldReveal({...base, createdAt: now + 60 * 60_000})).toBe(false);
  });
});
