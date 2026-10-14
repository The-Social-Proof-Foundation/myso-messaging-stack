/** iMessage-style jumbo emoji: at most this many emoji, and nothing else. */
export const MAX_JUMBO_EMOJI = 3;

const EMOJI_GRAPHEME_RE =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)$/u;

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** True when the message is 1–3 emoji (whitespace ignored) and no other characters. */
export function isEmojiOnlyMessage(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  const parts = graphemes(trimmed).filter((g) => g.trim() !== '');
  if (parts.length === 0 || parts.length > MAX_JUMBO_EMOJI) return false;
  return parts.every((g) => EMOJI_GRAPHEME_RE.test(g));
}
