import {useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode} from 'react';

import {cn} from '@/lib/utils';
import {CHAT_SIDEBAR_MOTION} from '@/lib/chat-layout';
import {
  flattenAgentChart,
  type AgentChartNode,
  type AgentChartStatus,
} from '@/lib/agents/agent-chart';
import {AgentChartNodeCard} from './AgentChartNodeCard';
import {useNewKeys} from '@/hooks/useNewKeys';
import {useAgentStats, type AgentStats} from '@/hooks/agents/useAgentStats';
import {AgentProfileDrawer} from './AgentProfileDrawer';
import {AgentCreateCard} from '../agents/AgentCreateForm';
import {
  AgentChartToolbar,
  statusFilterLabel,
  type AgentChartFilter,
} from './AgentChartToolbar';

interface AgentOrgChartProps {
  title: string;
  roots: AgentChartNode[];
  className?: string;
  organizationId?: string | null;
  description?: string | null;
  active?: boolean;
  meta?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  onChat?: (agent: AgentChartNode) => void;
  /** Replaces the built-in empty state (the inline create card). */
  emptyState?: ReactNode;
  /** Called after the inline create card registers an agent. */
  onAgentCreated?: () => void;
}

/** Pixels the pointer must travel before a press becomes a drag, so a click still selects. */
const PAN_THRESHOLD_PX = 5;

function parentIds(nodes: AgentChartNode[]): string[] {
  return flattenAgentChart(nodes)
    .filter((node) => (node.children?.length ?? 0) > 0)
    .map((node) => node.id);
}

function nodeMatches(node: AgentChartNode, query: string): boolean {
  const haystack = [node.name, node.role, node.address, node.fullAddress, ...node.capabilities]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function branchMatches(
  node: AgentChartNode,
  predicate: (node: AgentChartNode) => boolean,
): boolean {
  if (predicate(node)) return true;
  return (node.children ?? []).some((child) => branchMatches(child, predicate));
}

export function AgentOrgChart({
  title,
  roots,
  className,
  organizationId = null,
  description,
  active,
  meta,
  actions,
  details,
  onChat,
  emptyState,
  onAgentCreated,
}: Readonly<AgentOrgChartProps>) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const agents = useMemo(() => flattenAgentChart(roots), [roots]);
  const agentStats = useAgentStats(organizationId, agents);
  const freshAgentIds = useNewKeys(
    agents.map((agent) => agent.id),
    organizationId ?? title,
  );
  const [selectedId, setSelectedId] = useState<string | null>(roots[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<AgentChartFilter>('all');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(parentIds(roots)));

  // The chart is scaled with a CSS transform, which leaves its layout size unscaled. Measure it
  // and size a wrapper to the scaled result, so the scroll area covers all of it (nothing is
  // stranded off the left edge when zoomed in) and the chart stays centered when it is small.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentSize, setContentSize] = useState<{width: number; height: number} | null>(null);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentSize({width: el.offsetWidth, height: el.offsetHeight});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [roots.length]);

  // Click and drag to move the chart around.
  const panRef = useRef<{x: number; y: number; left: number; top: number; moved: boolean; id: number} | null>(null);
  const suppressClickRef = useRef(false);
  const [panning, setPanning] = useState(false);

  function startPan(event: PointerEvent<HTMLDivElement>) {
    // Touch already scrolls natively; only the mouse and pen need help.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const el = canvasRef.current;
    if (!el) return;
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      moved: false,
      id: event.pointerId,
    };
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    const el = canvasRef.current;
    if (!pan || !el) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      pan.moved = true;
      el.setPointerCapture(pan.id);
      setPanning(true);
    }
    el.scrollLeft = pan.left - dx;
    el.scrollTop = pan.top - dy;
  }

  function endPan() {
    const pan = panRef.current;
    panRef.current = null;
    if (!pan?.moved) return;
    setPanning(false);
    try {
      canvasRef.current?.releasePointerCapture(pan.id);
    } catch {
      /* the capture is already gone */
    }
    // The release ends in a click; swallow it so a drag never selects the card it ended on.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [roots]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    setExpandedIds(new Set(parentIds(roots)));
  }, [searchQuery, roots]);

  const filters = useMemo(() => {
    const count = (status: AgentChartStatus) => agents.filter((agent) => agent.status === status).length;
    return [
      {label: statusFilterLabel('all'), value: 'all' as const, count: agents.length},
      {label: statusFilterLabel('active'), value: 'active' as const, count: count('active')},
      {label: statusFilterLabel('inactive'), value: 'inactive' as const, count: count('inactive')},
      {label: statusFilterLabel('revoked'), value: 'revoked' as const, count: count('revoked')},
    ];
  }, [agents]);

  const matchingIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return new Set<string>();
    return new Set(agents.filter((agent) => nodeMatches(agent, query)).map((agent) => agent.id));
  }, [agents, searchQuery]);

  const selected =
    agents.find((agent) => agent.id === selectedId) ?? roots[0] ?? null;

  function selectAgent(agent: AgentChartNode) {
    setSelectedId(agent.id);
    setDrawerOpen(true);
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function isDimmed(node: AgentChartNode): boolean {
    if (filter !== 'all') {
      const statusHit = (candidate: AgentChartNode) => candidate.status === filter;
      if (!branchMatches(node, statusHit)) return true;
    }
    if (searchQuery.trim()) {
      const searchHit = (candidate: AgentChartNode) => matchingIds.has(candidate.id);
      if (!branchMatches(node, searchHit)) return true;
    }
    return false;
  }

  return (
    <div
      data-slot="agent-org-chart"
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden bg-background',
        className,
      )}
    >
      <AgentChartToolbar
        title={title}
        description={description}
        active={active}
        meta={meta}
        actions={actions}
        details={details}
        searchQuery={searchQuery}
        filters={filters}
        selectedFilter={filter}
        matchingCount={matchingIds.size}
        zoomLevel={zoomLevel}
        onSearchChange={setSearchQuery}
        onFilterSelect={setFilter}
        onAdjustZoom={(delta) => setZoomLevel((level) => Math.min(130, Math.max(70, level + delta)))}
        onResetZoom={() => setZoomLevel(100)}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={canvasRef}
          className={cn(
            'bg-chart-plus min-h-0 min-w-0 flex-1 overflow-auto',
            roots.length > 0 && (panning ? 'cursor-grabbing select-none' : 'cursor-grab'),
          )}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClickCapture={(event) => {
            if (!suppressClickRef.current) return;
            event.stopPropagation();
            event.preventDefault();
          }}
        >
          {roots.length === 0 ? (
            emptyState ?? (
              organizationId ? (
                <AgentCreateCard organizationId={organizationId} onCreated={onAgentCreated} />
              ) : (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No agents in this organization yet.
                </p>
              )
            )
          ) : (
            <div
              className="mx-auto"
              style={
                contentSize
                  ? {
                      width: contentSize.width * (zoomLevel / 100),
                      height: contentSize.height * (zoomLevel / 100),
                    }
                  : undefined
              }
            >
              <div
                ref={contentRef}
                className="w-max px-6 py-8 transition-transform duration-200"
                style={{transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left'}}
              >
              <div className="flex items-start gap-8">
                {roots.map((root) => (
                  <AgentChartBranch
                    key={root.id}
                    node={root}
                    selectedId={selectedId}
                    expandedIds={expandedIds}
                    matchingIds={matchingIds}
                    searchQuery={searchQuery}
                    isDimmed={isDimmed}
                    freshIds={freshAgentIds}
                    statsById={agentStats}
                    onSelect={selectAgent}
                    onToggleExpand={toggleExpand}
                  />
                ))}
              </div>
              </div>
            </div>
          )}
        </div>

        {selected ? (
          <div
            className={cn(
              'min-h-0 shrink-0 overflow-hidden border-border bg-card',
              drawerOpen ? 'flex w-full flex-col border-t' : 'max-lg:hidden',
              'lg:flex lg:flex-col lg:border-t-0',
              CHAT_SIDEBAR_MOTION,
              drawerOpen ? 'lg:w-80 lg:border-l' : 'lg:w-0 lg:border-l-0',
            )}
            aria-hidden={!drawerOpen}
          >
            <div className="flex h-full min-h-0 w-full flex-col lg:w-80">
              <AgentProfileDrawer
                key={selected.id}
                agent={selected}
                organizationId={organizationId}
                onClose={() => setDrawerOpen(false)}
                onChat={onChat ? () => onChat(selected) : undefined}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentChartBranch({
  node,
  selectedId,
  expandedIds,
  matchingIds,
  searchQuery,
  isDimmed,
  freshIds,
  statsById,
  onSelect,
  onToggleExpand,
}: Readonly<{
  node: AgentChartNode;
  selectedId: string | null;
  expandedIds: Set<string>;
  matchingIds: Set<string>;
  searchQuery: string;
  isDimmed: (node: AgentChartNode) => boolean;
  freshIds: ReadonlySet<string>;
  statsById: ReadonlyMap<string, AgentStats>;
  onSelect: (node: AgentChartNode) => void;
  onToggleExpand: (id: string) => void;
}>) {
  const children = node.children ?? [];
  const expanded = expandedIds.has(node.id) && children.length > 0;

  return (
    <div className="flex flex-col items-center">
      <AgentChartNodeCard
        node={node}
        isSelected={selectedId === node.id}
        isHighlighted={searchQuery.trim().length > 0 && matchingIds.has(node.id)}
        isDimmed={isDimmed(node)}
        isExpanded={expanded}
        isNew={freshIds.has(node.id)}
        stats={statsById.get(node.id)}
        onSelect={onSelect}
        onToggleExpand={children.length > 0 ? onToggleExpand : undefined}
      />

      {expanded ? (
        <div className="flex flex-col items-center">
          <div className="h-6 w-px bg-border" />
          <div className="flex items-start">
            {children.map((child, index) => (
              <div key={child.id} className="relative flex flex-col items-center px-3">
                {children.length > 1 ? (
                  <div
                    className={cn(
                      'absolute top-0 h-px bg-border',
                      index === 0 && 'right-0 left-1/2',
                      index === children.length - 1 && 'right-1/2 left-0',
                      index > 0 && index < children.length - 1 && 'inset-x-0',
                    )}
                  />
                ) : null}
                <div className="h-6 w-px bg-border" />
                <AgentChartBranch
                  node={child}
                  selectedId={selectedId}
                  expandedIds={expandedIds}
                  matchingIds={matchingIds}
                  searchQuery={searchQuery}
                  isDimmed={isDimmed}
                  freshIds={freshIds}
                  statsById={statsById}
                  onSelect={onSelect}
                  onToggleExpand={onToggleExpand}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
