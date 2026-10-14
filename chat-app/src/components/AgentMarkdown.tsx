import {Fragment, memo, useMemo, type ReactNode} from 'react';

import {useTypewriter} from '../hooks/useTypewriter';
import {parseMarkdown, truncateBlocks, visibleLength, type Block, type Inline} from '../lib/markdown-lite';

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

/** The blinking bar at the end of text that is still being typed. */
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse rounded-sm bg-secondary-400 dark:bg-secondary-300"
    />
  );
}

function renderBlock(block: Block, index: number, caret = false): ReactNode {
  switch (block.t) {
    case 'p':
      return (
        <p key={index}>
          {renderInline(block.c)}
          {caret ? <Caret /> : null}
        </p>
      );
    case 'h': {
      const Tag = `h${block.level + 2}` as 'h3' | 'h4' | 'h5';
      return (
        <Tag key={index} className={HEADING_CLASS[block.level]}>
          {renderInline(block.c)}
          {caret ? <Caret /> : null}
        </Tag>
      );
    }
    case 'ul':
      return (
        <ul key={index} className="list-disc space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              {renderInline(item)}
              {caret && i === block.items.length - 1 ? <Caret /> : null}
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              {renderInline(item)}
              {caret && i === block.items.length - 1 ? <Caret /> : null}
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote
          key={index}
          className="border-l-2 border-secondary-300 pl-3 text-secondary-600 dark:border-secondary-600 dark:text-secondary-300"
        >
          {renderInline(block.c)}
          {caret ? <Caret /> : null}
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={index}
          className="overflow-x-auto rounded-lg bg-secondary-100 p-3 font-mono text-[13px] leading-snug dark:bg-secondary-800"
        >
          <code>
            {block.v}
            {caret ? <Caret /> : null}
          </code>
        </pre>
      );
    case 'hr':
      return <hr key={index} className="border-secondary-200 dark:border-secondary-700" />;
  }
}

const BODY_CLASS =
  'min-w-0 space-y-2 break-words text-[15px] leading-relaxed text-secondary-900 dark:text-secondary-100';

interface AgentMarkdownProps {
  text: string;
  /** Type the reply out as it first appears. It plays once, then the text stays as it is. */
  animate?: boolean;
  /** Called as the reveal grows, so the thread can stay scrolled to the bottom. */
  onRevealProgress?: () => void;
}

/** An agent reply as formatted text: bold, italic, links, lists, code and line breaks. */
export const AgentMarkdown = memo(function AgentMarkdown({text, animate = false, onRevealProgress}: Readonly<AgentMarkdownProps>) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const total = useMemo(() => visibleLength(blocks), [blocks]);
  const {count, done} = useTypewriter({total, active: animate, onProgress: onRevealProgress});
  const typing = animate && !done;
  const shown = useMemo(() => (typing ? truncateBlocks(blocks, count) : blocks), [typing, blocks, count]);

  if (!typing) {
    return <div className={BODY_CLASS}>{blocks.map((block, index) => renderBlock(block, index))}</div>;
  }
  return (
    <>
      {/* Assistive tech reads the finished reply, not a stream of fragments. */}
      <span className="sr-only">{text}</span>
      <div className={BODY_CLASS} aria-hidden>
        {shown.length === 0 ? (
          <p>
            <Caret />
          </p>
        ) : (
          shown.map((block, index) => renderBlock(block, index, index === shown.length - 1))
        )}
      </div>
    </>
  );
});
