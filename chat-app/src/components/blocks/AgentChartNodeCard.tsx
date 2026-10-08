import {useState} from 'react';
import {Check, ChevronDown, ChevronRight, Copy} from 'lucide-react';

import {cn} from '@/lib/utils';
import {AgentOrb} from '@/components/agents/AgentOrb';
import {AgentModelLabel} from '@/components/agents/AgentModelLabel';
import {Button} from '@/components/ui/button';
import {AgentStatusDot} from '@/components/blocks/AgentStatusMark';
import {type AgentChartNode} from '@/lib/agents/agent-chart';
import {formatMistAmount} from '@/lib/agents/format';
import type {AgentStats} from '@/hooks/agents/useAgentStats';

const LEVEL_STRIP = [
  'bg-sky-400/80',
  'bg-teal-400/75',
  'bg-amber-400/80',
  'bg-rose-400/70',
] as const;

interface AgentChartNodeCardProps {
  node: AgentChartNode;
  isSelected: boolean;
  isHighlighted: boolean;
  isDimmed: boolean;
  isExpanded?: boolean;
  /** Just created: plays the enter animation once. */
  isNew?: boolean;
  stats?: AgentStats;
  onSelect: (node: AgentChartNode) => void;
  onToggleExpand?: (id: string) => void;
}

export function AgentChartNodeCard({
  node,
  isSelected,
  isHighlighted,
  isDimmed,
  isExpanded = false,
  isNew = false,
  stats,
  onSelect,
  onToggleExpand,
}: Readonly<AgentChartNodeCardProps>) {
  const [copied, setCopied] = useState(false);
  const childCount = node.children?.length ?? 0;

  function copyAddress() {
    void navigator.clipboard.writeText(node.fullAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div
      className={cn(
        'relative w-64 cursor-pointer overflow-hidden rounded-xl border border-border bg-muted text-left shadow-xs transition-colors duration-200 hover:border-foreground/20 dark:bg-secondary-800',
        isSelected && 'border-foreground/35',
        isHighlighted && 'border-foreground/45',
        isDimmed && 'opacity-40',
        isNew && 'created-in',
      )}
      tabIndex={0}
      role="button"
      aria-label={`Select ${node.name}`}
      onClick={() => onSelect(node)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node);
        }
      }}
    >
      <div
        className={cn(
          'mx-0.5 mt-px h-1 rounded-full',
          LEVEL_STRIP[node.depth % LEVEL_STRIP.length],
        )}
      />

      <div className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative size-10 shrink-0">
            <AgentOrb
              agentKey={node.fullAddress}
              size={40}
              label={node.name}
              className="border border-border"
            />
            <AgentStatusDot status={node.status} className="ring-muted dark:ring-secondary-800" />
          </div>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-semibold text-foreground">{node.name}</h4>
            <div className="mt-0.5 flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  copyAddress();
                }}
                aria-label={copied ? 'Copied address' : 'Copy address'}
                className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <Check className="size-2.5" strokeWidth={2} aria-hidden />
                ) : (
                  <Copy className="size-2.5" strokeWidth={2} aria-hidden />
                )}
              </button>
              <p className="truncate font-mono text-[10px] leading-none text-muted-foreground">
                {node.address}
              </p>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <AgentModelLabel agentId={node.id} fallback={node.role} />
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-1.5">
          <CardStat label="Balance" value={stats?.balanceMist} />
          <CardStat label="AI spent" value={stats?.spentMist} />
        </dl>

        {childCount > 0 && onToggleExpand ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-between text-xs font-medium text-muted-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(node.id);
            }}
          >
            <span className="flex items-center gap-1.5">
              {isExpanded ? (
                <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden />
              )}
              {isExpanded ? 'Collapse branch' : `Expand (${childCount})`}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">{childCount}</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CardStat({
  label,
  value,
  count,
}: Readonly<{label: string; value?: bigint | null; count?: number | null}>) {
  const text =
    count !== undefined
      ? count == null
        ? '—'
        : count.toLocaleString()
      : value == null
        ? '—'
        : formatMistAmount(value);
  return (
    <div className="min-w-0 rounded-lg bg-muted/60 px-2 py-1.5">
      <dt className="truncate text-[10px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs font-medium tabular-nums text-foreground">{text}</dd>
    </div>
  );
}
