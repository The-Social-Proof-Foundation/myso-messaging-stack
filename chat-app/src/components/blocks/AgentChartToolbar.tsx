import type {ReactNode} from 'react';
import {Minus, Plus, RotateCcw, Search} from 'lucide-react';

import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {AGENT_CHART_STATUS_LABEL, type AgentChartStatus} from '@/lib/agents/agent-chart';

export type AgentChartFilter = 'all' | AgentChartStatus;

export interface AgentChartFilterCount {
  label: string;
  value: AgentChartFilter;
  count: number;
}

interface AgentChartToolbarProps {
  title: string;
  description?: string | null;
  /** When set, a status dot sits to the right of the category label. */
  active?: boolean;
  meta?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  searchQuery: string;
  filters: AgentChartFilterCount[];
  selectedFilter: AgentChartFilter;
  matchingCount: number;
  zoomLevel: number;
  onSearchChange: (value: string) => void;
  onFilterSelect: (filter: AgentChartFilter) => void;
  onAdjustZoom: (delta: number) => void;
  onResetZoom: () => void;
}

export function AgentChartToolbar({
  title,
  description,
  active,
  meta,
  actions,
  details,
  searchQuery,
  filters,
  selectedFilter,
  matchingCount,
  zoomLevel,
  onSearchChange,
  onFilterSelect,
  onAdjustZoom,
  onResetZoom,
}: Readonly<AgentChartToolbarProps>) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate font-chakra text-xl font-medium leading-tight tracking-wide text-foreground">
            {title}
          </h3>
          {meta != null || active != null ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground">
              {meta ? <span className="truncate">{meta}</span> : null}
              {active == null ? null : (
                <span
                  role="img"
                  aria-label={active ? 'Active' : 'Inactive'}
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    active ? 'bg-emerald-500' : 'bg-red-500',
                  )}
                />
              )}
            </p>
          ) : null}
          {description != null ? (
            <p className="truncate text-xs leading-tight text-muted-foreground">
              {description.trim() || 'No description'}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <div className="w-56 min-w-0">
            <Input
              size="small"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search name, address, capability"
              prefixIcon={<Search className="size-3.5" strokeWidth={2} aria-hidden />}
              allowClear
              aria-label="Search agents"
              className="border-secondary-300 bg-white shadow-none focus-within:border-secondary-400 focus-within:ring-0 dark:border-secondary-600 dark:bg-secondary-800 dark:focus-within:border-secondary-500"
            />
          </div>
          {actions}
        </div>
      </div>

      {details}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Status</span>
          {filters.map((filter) => {
            const selected = selectedFilter === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors',
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-background text-muted-foreground hover:bg-muted',
                )}
                onClick={() => onFilterSelect(filter.value)}
              >
                {filter.label}
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[11px]',
                    selected ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {filter.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          {searchQuery.trim() ? (
            <span className="mr-2 text-xs text-muted-foreground">
              {matchingCount} match{matchingCount === 1 ? '' : 'es'}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={zoomLevel <= 70}
            aria-label="Zoom out"
            onClick={() => onAdjustZoom(-10)}
          >
            <Minus strokeWidth={2} aria-hidden />
          </Button>
          <span className="w-10 text-center text-xs text-muted-foreground">{zoomLevel}%</span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={zoomLevel >= 130}
            aria-label="Zoom in"
            onClick={() => onAdjustZoom(10)}
          >
            <Plus strokeWidth={2} aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Reset zoom" onClick={onResetZoom}>
            <RotateCcw strokeWidth={2} aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function statusFilterLabel(filter: AgentChartFilter): string {
  return filter === 'all' ? 'All' : AGENT_CHART_STATUS_LABEL[filter];
}
