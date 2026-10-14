import {describe, expect, it} from 'vitest';
import {isEmojiOnlyMessage} from './emoji-only';

describe('isEmojiOnlyMessage', () => {
  it('accepts one to three emoji', () => {
    expect(isEmojiOnlyMessage('👀')).toBe(true);
    expect(isEmojiOnlyMessage('😂😂')).toBe(true);
    expect(isEmojiOnlyMessage(' 🔥 🔥 🔥 ')).toBe(true);
  });
  it('accepts sequences as one emoji', () => {
    expect(isEmojiOnlyMessage('👍🏽')).toBe(true);
    expect(isEmojiOnlyMessage('👨‍👩‍👧‍👦')).toBe(true);
    expect(isEmojiOnlyMessage('🇺🇸')).toBe(true);
    expect(isEmojiOnlyMessage('❤️')).toBe(true);
  });
  it('rejects four or more, text, digits and empty', () => {
    expect(isEmojiOnlyMessage('😂😂😂😂')).toBe(false);
    expect(isEmojiOnlyMessage('hi 😂')).toBe(false);
    expect(isEmojiOnlyMessage('1')).toBe(false);
    expect(isEmojiOnlyMessage('')).toBe(false);
    expect(isEmojiOnlyMessage(null)).toBe(false);
  });
});
