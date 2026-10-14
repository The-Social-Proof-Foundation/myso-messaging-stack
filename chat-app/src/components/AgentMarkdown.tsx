import {Fragment, memo, useMemo, type ReactNode} from 'react';

import {parseMarkdown, type Block, type Inline} from '../lib/markdown-lite';

const LINK_CLASS =
  'break-all text-bubble-sent underline decoration-bubble-sent/50 underline-offset-2 hover:decoration-bubble-sent dark:text-bubble-sent-dark dark:decoration-bubble-sent-dark/60';

function renderInline(nodes: readonly Inline[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.t) {
      case 'text':
        return <Fragment key={key}>{node.v}</Fragment>;
      case 'br':
        return <br key={key} />;
      case 'strong':
        return <strong key={key} className="font-semibold">{renderInline(node.c, `${key}.`)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.c, `${key}.`)}</em>;
      case 'del':
        return <del key={key} className="opacity-70">{renderInline(node.c, `${key}.`)}</del>;
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-secondary-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-secondary-700/70"
          >
            {node.v}
          </code>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
            onClick={(event) => event.stopPropagation()}
          >
            {renderInline(node.c, `${key}.`)}
          </a>
        );
    }
  });
}

const HEADING_CLASS = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-[15px] font-semibold',
} as const;

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.t) {
    case 'p':
      return <p key={index}>{renderInline(block.c)}</p>;
    case 'h': {
      const Tag = `h${block.level + 2}` as 'h3' | 'h4' | 'h5';
      return <Tag key={index} className={HEADING_CLASS[block.level]}>{renderInline(block.c)}</Tag>;
    }
    case 'ul':
      return (
        <ul key={index} className="list-disc space-y-1 pl-5">
          {block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ol>
      );
    case 'quote':
      return (
        <blockquote
          key={index}
          className="border-l-2 border-secondary-300 pl-3 text-secondary-600 dark:border-secondary-600 dark:text-secondary-300"
        >
          {renderInline(block.c)}
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={index}
          className="overflow-x-auto rounded-lg bg-secondary-100 p-3 font-mono text-[13px] leading-snug dark:bg-secondary-800"
        >
          <code>{block.v}</code>
        </pre>
      );
    case 'hr':
      return <hr key={index} className="border-secondary-200 dark:border-secondary-700" />;
  }
}

/** An agent reply as formatted text: bold, italic, links, lists, code and line breaks. */
export const AgentMarkdown = memo(function AgentMarkdown({text}: Readonly<{text: string}>) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="min-w-0 space-y-2 break-words text-[15px] leading-relaxed text-secondary-900 dark:text-secondary-100">
      {blocks.map(renderBlock)}
    </div>
  );
});
