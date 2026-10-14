import {describe, expect, it} from 'vitest';
import {isSafeUrl, parseInline, parseMarkdown, type Inline} from './markdown-lite';

const text = (v: string): Inline => ({t: 'text', v});

describe('parseInline', () => {
  it('handles bold, italic, strike and code', () => {
    expect(parseInline('a **b** c')).toEqual([text('a '), {t: 'strong', c: [text('b')]}, text(' c')]);
    expect(parseInline('*it* and _it2_')).toEqual([{t: 'em', c: [text('it')]}, text(' and '), {t: 'em', c: [text('it2')]}]);
    expect(parseInline('~~gone~~')).toEqual([{t: 'del', c: [text('gone')]}]);
    expect(parseInline('run `npm i` now')).toEqual([text('run '), {t: 'code', v: 'npm i'}, text(' now')]);
  });
  it('nests emphasis', () => {
    expect(parseInline('**bold *and italic***')).toEqual([{t: 'strong', c: [text('bold '), {t: 'em', c: [text('and italic')]}]}]);
  });
  it('leaves unclosed or spaced markers literal', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(parseInline('half **open')).toEqual([text('half **open')]);
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')]);
  });
  it('does not format inside code spans', () => {
    expect(parseInline('`**x**`')).toEqual([{t: 'code', v: '**x**'}]);
  });
  it('turns single newlines into line breaks', () => {
    expect(parseInline('one\ntwo')).toEqual([text('one'), {t: 'br'}, text('two')]);
  });
  it('links markdown and bare urls, trimming trailing punctuation', () => {
    expect(parseInline('[docs](https://x.dev/a)')).toEqual([{t: 'link', href: 'https://x.dev/a', c: [text('docs')]}]);
    expect(parseInline('see https://x.dev/a.')).toEqual([text('see '), {t: 'link', href: 'https://x.dev/a', c: [text('https://x.dev/a')]}, text('.')]);
  });
  it('refuses unsafe link targets', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([text('[x](javascript:alert(1))')]);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,hi')).toBe(false);
    expect(isSafeUrl('https://ok.dev')).toBe(true);
    expect(isSafeUrl('mailto:a@b.co')).toBe(true);
  });
  it('honours escapes', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([text('*not italic*')]);
  });
  it('never emits raw html', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([text('<img src=x onerror=alert(1)>')]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps line breaks inside', () => {
    const blocks = parseMarkdown('First line\nsecond line\n\nNext paragraph');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({t: 'p', c: [text('First line'), {t: 'br'}, text('second line')]});
  });
  it('parses headings, capped at level 3', () => {
    expect(parseMarkdown('## Title')[0]).toEqual({t: 'h', level: 2, c: [text('Title')]});
    expect(parseMarkdown('###### Deep')[0]).toMatchObject({t: 'h', level: 3});
  });
  it('parses bullet and numbered lists with inline formatting', () => {
    expect(parseMarkdown('- **a**\n- b')[0]).toEqual({t: 'ul', items: [[{t: 'strong', c: [text('a')]}], [text('b')]]});
    const ol = parseMarkdown('1. one\n2. two')[0]!;
    expect(ol).toMatchObject({t: 'ol'});
    expect((ol as {items: unknown[]}).items).toHaveLength(2);
    expect(parseMarkdown('3. c\n4. d')[0]).toMatchObject({t: 'ol', start: 3});
  });
  it('keeps one list across a single blank line', () => {
    const blocks = parseMarkdown('- a\n\n- b');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as {items: unknown[]}).items).toHaveLength(2);
  });
  it('parses fenced code, including an unclosed fence from a streaming reply', () => {
    expect(parseMarkdown('```ts\nconst a = **1**;\n```')[0]).toEqual({t: 'code', v: 'const a = **1**;', lang: 'ts'});
    expect(parseMarkdown('```\nopen')[0]).toEqual({t: 'code', v: 'open', lang: ''});
  });
  it('parses quotes and rules', () => {
    expect(parseMarkdown('> quoted\n> more')[0]).toEqual({t: 'quote', c: [text('quoted'), {t: 'br'}, text('more')]});
    expect(parseMarkdown('---')[0]).toEqual({t: 'hr'});
  });
  it('a list directly after a paragraph starts its own block', () => {
    const blocks = parseMarkdown('Intro:\n- a\n- b');
    expect(blocks.map((b) => b.t)).toEqual(['p', 'ul']);
  });
  it('returns nothing for empty input', () => {
    expect(parseMarkdown('  \n\n')).toEqual([]);
  });
});

describe('emphasis runs', () => {
  it('handles a triple-star close and a triple-star open', () => {
    expect(parseInline('***both***')).toEqual([{t: 'strong', c: [{t: 'em', c: [text('both')]}]}]);
    expect(parseInline('**a** and **b**')).toEqual([
      {t: 'strong', c: [text('a')]},
      text(' and '),
      {t: 'strong', c: [text('b')]},
    ]);
  });
});

import {truncateBlocks, visibleLength} from './markdown-lite';

describe('progressive reveal', () => {
  const doc = parseMarkdown('Hello **bold** world\n\n- one\n- two\n\n```\ncode\n```');

  it('counts only what a reader sees', () => {
    // "Hello bold world" 16 + "one" 3 + "two" 3 + "code" 4
    expect(visibleLength(doc)).toBe(26);
    expect(visibleLength(parseMarkdown('a\nb'))).toBe(3);
    expect(visibleLength(parseMarkdown('---'))).toBe(1);
    expect(visibleLength([])).toBe(0);
  });

  it('cuts inside a paragraph without ever showing a half-written marker', () => {
    const cut = truncateBlocks(doc, 9);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toEqual({t: 'p', c: [text('Hello '), {t: 'strong', c: [text('bol')]}]});
  });

  it('shows nothing past the cut, and everything at or beyond the full length', () => {
    expect(truncateBlocks(doc, 0)).toEqual([]);
    expect(truncateBlocks(doc, -5)).toEqual([]);
    expect(truncateBlocks(doc, 26)).toEqual(doc);
    expect(truncateBlocks(doc, 9999)).toEqual(doc);
  });

  it('does not open a container it has no room to fill', () => {
    const bold = parseMarkdown('ab **cd**');
    expect(truncateBlocks(bold, 3)).toEqual([{t: 'p', c: [text('ab ')]}]);
    expect(truncateBlocks(bold, 4)).toEqual([{t: 'p', c: [text('ab '), {t: 'strong', c: [text('c')]}]}]);
  });

  it('reveals a list item by item, and a code block as it is typed', () => {
    const list = truncateBlocks(doc, 16 + 3 + 1);
    expect(list.map((b) => b.t)).toEqual(['p', 'ul']);
    expect((list[1] as {items: unknown[]}).items).toHaveLength(2);
    const code = truncateBlocks(doc, 16 + 3 + 3 + 2);
    expect(code[2]).toEqual({t: 'code', v: 'co', lang: ''});
  });

  it('counts a line break as one character', () => {
    const two = parseMarkdown('ab\ncd');
    expect(truncateBlocks(two, 3)).toEqual([{t: 'p', c: [text('ab'), {t: 'br'}]}]);
    expect(truncateBlocks(two, 4)).toEqual([{t: 'p', c: [text('ab'), {t: 'br'}, text('c')]}]);
  });

  it('never splits an emoji', () => {
    const cut = truncateBlocks(parseMarkdown('a😀b'), 2);
    expect(cut).toEqual([{t: 'p', c: [text('a😀')]}]);
  });

  it('keeps links and inline code intact while cutting their text', () => {
    const cut = truncateBlocks(parseMarkdown('see [docs here](https://x.dev) and `npm i`'), 8);
    expect(cut[0]).toEqual({t: 'p', c: [text('see '), {t: 'link', href: 'https://x.dev', c: [text('docs')]}]});
  });

  it('grows monotonically: each step only adds', () => {
    const total = visibleLength(doc);
    let last = 0;
    for (let n = 0; n <= total; n += 1) {
      const now = visibleLength(truncateBlocks(doc, n));
      expect(now).toBeGreaterThanOrEqual(last);
      expect(now).toBeLessThanOrEqual(n);
      last = now;
    }
    expect(last).toBe(total);
  });
});
