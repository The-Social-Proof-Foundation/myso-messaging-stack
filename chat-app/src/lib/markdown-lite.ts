/**
 * A small, safe markdown subset for agent replies: the formatting models actually return.
 * It produces a tree and never HTML, so nothing here can inject markup. Unclosed markers stay
 * literal text, which keeps half-written replies readable.
 */
export type Inline =
  | {t: 'text'; v: string}
  | {t: 'br'}
  | {t: 'strong' | 'em' | 'del'; c: Inline[]}
  | {t: 'code'; v: string}
  | {t: 'link'; href: string; c: Inline[]};

export type Block =
  | {t: 'p'; c: Inline[]}
  | {t: 'h'; level: 1 | 2 | 3; c: Inline[]}
  | {t: 'ul' | 'ol'; items: Inline[][]; start?: number}
  | {t: 'quote'; c: Inline[]}
  | {t: 'code'; v: string; lang: string}
  | {t: 'hr'};

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /^https?:\/\/[^\s<>"'`)\]]+/i;
const TRAILING_PUNCT = /[.,;:!?]+$/;

export function isSafeUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

/** Index of the closing `marker` for an opener at `from`, or -1. The span must be non-empty and not start with a space. */
function findClose(text: string, marker: string, from: number): number {
  if (text[from] === ' ' || text[from] === '\n') return -1;
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(marker, i) && text[i - 1] !== ' ' && i > from) return i;
    i++;
  }
  return -1;
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

const EMPHASIS = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
  ['_', 'em'],
] as const;

/** An emphasis span opening at `i`, or null when the markers are unclosed, spaced or inside a word. */
function matchEmphasis(text: string, i: number): {node: Inline; next: number} | null {
  for (const [marker, kind] of EMPHASIS) {
    if (!text.startsWith(marker, i)) continue;
    // `_` inside a word (snake_case) is not emphasis.
    if (marker[0] === '_' && isWordChar(text[i - 1])) continue;
    let close = findClose(text, marker, i + marker.length);
    if (close === -1) continue;
    // A longer closing run (`***`) closes the outer span on its last characters.
    if (marker.length === 2 && marker[0] !== '~') {
      while (text[close + marker.length] === marker[0]) close++;
    }
    if (marker[0] === '_' && isWordChar(text[close + marker.length])) continue;
    return {
      node: {t: kind, c: parseInline(text.slice(i + marker.length, close))},
      next: close + marker.length,
    };
  }
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({t: 'text', v: buf});
      buf = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~>|]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({t: 'br'});
      i++;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({t: 'code', v: text.slice(i + 1, end)});
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m && isSafeUrl(m[2]!)) {
        flush();
        out.push({t: 'link', href: m[2]!, c: parseInline(m[1]!)});
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && (i === 0 || !isWordChar(text[i - 1]))) {
      const m = BARE_URL.exec(text.slice(i));
      if (m) {
        const trailing = TRAILING_PUNCT.exec(m[0])?.[0] ?? '';
        const href = trailing ? m[0].slice(0, -trailing.length) : m[0];
        flush();
        out.push({t: 'link', href, c: [{t: 'text', v: href}]});
        i += href.length;
        continue;
      }
    }
    const span = matchEmphasis(text, i);
    if (span) {
      flush();
      out.push(span.node);
      i = span.next;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const LIST_BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const LIST_ORDER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}```\s*([\w+-]*)\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  const startsBlock = (line: string) =>
    FENCE.test(line) || HEADING.test(line) || LIST_BULLET.test(line) || LIST_ORDER.test(line) || QUOTE.test(line) || HR.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of a reply still streaming)
      blocks.push({t: 'code', v: body.join('\n'), lang: fence[1] ?? ''});
      continue;
    }
    if (HR.test(line)) {
      blocks.push({t: 'hr'});
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({t: 'h', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, c: parseInline(heading[2]!)});
      i++;
      continue;
    }
    if (LIST_BULLET.test(line) || LIST_ORDER.test(line)) {
      const ordered = LIST_ORDER.test(line);
      const items: Inline[][] = [];
      const start = ordered ? Number(LIST_ORDER.exec(line)![1]) : undefined;
      while (i < lines.length) {
        const m = ordered ? LIST_ORDER.exec(lines[i]!) : LIST_BULLET.exec(lines[i]!);
        if (!m) break;
        let item = ordered ? m[2]! : m[1]!;
        i++;
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !LIST_BULLET.test(lines[i]!) && !LIST_ORDER.test(lines[i]!)) {
          item += `\n${lines[i]!.trim()}`;
          i++;
        }
        items.push(parseInline(item));
        // A single blank line between items keeps the same list.
        if (i < lines.length && !lines[i]!.trim() && i + 1 < lines.length) {
          const next = lines[i + 1]!;
          if (ordered ? LIST_ORDER.test(next) : LIST_BULLET.test(next)) i++;
        }
      }
      blocks.push({t: ordered ? 'ol' : 'ul', items, ...(ordered && start && start !== 1 ? {start} : {})});
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({t: 'quote', c: parseInline(body.join('\n'))});
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length > 0 && startsBlock(lines[i]!))) {
      para.push(lines[i++]!.replace(/\s+$/, ''));
    }
    blocks.push({t: 'p', c: parseInline(para.join('\n'))});
  }
  return blocks;
}
