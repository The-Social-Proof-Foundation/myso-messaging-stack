import {useMemo, useState} from 'react';
import {Check, ChevronLeft, Copy, MessageSquare, ScrollText, X} from 'lucide-react';

import {Avatar, AvatarFallback} from '@/components/ui/avatar';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Separator} from '@/components/ui/separator';
import {MysoAmount} from '@/components/agents/MysoAmount';
import {AgentStatusDot} from '@/components/blocks/AgentStatusMark';
import type {AgentChartNode} from '@/lib/agents/agent-chart';
import {formatMistAmount} from '@/lib/agents/format';
import {formatTimestamp, humanizeKey} from '@/lib/agents/org-display';
import {SocialServerError} from '@/lib/agents/social-api';
import {useOrgAuditLogs, useOrgSpendBreakdown} from '@/hooks/agents';

interface AgentProfileDrawerProps {
  agent: AgentChartNode;
  organizationId?: string | null;
  onClose: () => void;
  onChat?: () => void;
}

function sameId(left: string, right: string): boolean {
  return left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();
}

function isForbidden(error: unknown): boolean {
  return error instanceof SocialServerError && (error.status === 403 || error.status === 401);
}

export function AgentProfileDrawer({
  agent,
  organizationId = null,
  onClose,
  onChat,
}: Readonly<AgentProfileDrawerProps>) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<'details' | 'audit'>('details');
  const spend = useOrgSpendBreakdown(organizationId);
  const audit = useOrgAuditLogs(organizationId);
  const spendRow = useMemo(
    () => spend.items.find((row) => sameId(row.agent_object_id, agent.id)) ?? null,
    [spend.items, agent.id],
  );
  const auditRows = useMemo(
    () => audit.items.filter((row) => sameId(row.target_id, agent.id)),
    [audit.items, agent.id],
  );

  function copyAddress() {
    void navigator.clipboard.writeText(agent.fullAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        {view === 'audit' ? (
          <button
            type="button"
            onClick={() => setView('details')}
            aria-label="Back to agent details"
            className="flex min-w-0 items-center gap-1 rounded text-foreground hover:text-foreground/80"
          >
            <ChevronLeft className="size-4 shrink-0" strokeWidth={2} aria-hidden />
            <span className="truncate font-chakra text-sm font-medium tracking-wide">Audit log</span>
          </button>
        ) : (
          <h3 className="font-chakra text-sm font-medium tracking-wide text-foreground">
            Agent details
          </h3>
        )}
        <Button variant="ghost" size="icon-xs" aria-label="Close agent details" onClick={onClose}>
          <X strokeWidth={2} aria-hidden />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {view === 'audit' ? (
          <AuditLogList audit={audit} rows={auditRows} />
        ) : (
          <>
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <Avatar className="size-12 border border-border">
              <AvatarFallback>{agent.initials}</AvatarFallback>
            </Avatar>
            <AgentStatusDot status={agent.status} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{agent.name}</p>
            <div className="mt-0.5 flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={copyAddress}
                aria-label={copied ? 'Copied address' : 'Copy address'}
                className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <Check className="size-2.5" strokeWidth={2} aria-hidden />
                ) : (
                  <Copy className="size-2.5" strokeWidth={2} aria-hidden />
                )}
              </button>
              <p className="truncate font-mono text-[10px] leading-none text-muted-foreground">{agent.address}</p>
            </div>
            {agent.parentName ? null : (
              <p className="mt-0.5 text-xs text-muted-foreground">Root agent in this organization.</p>
            )}
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{agent.role}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-1 text-xs"
            onClick={() => setView('audit')}
          >
            <ScrollText data-icon="inline-start" strokeWidth={2} aria-hidden />
            Audit logs
          </Button>
          {onChat ? (
            <Button variant="outline" size="sm" className="h-8 flex-1 text-xs" onClick={onChat}>
              <MessageSquare data-icon="inline-start" strokeWidth={2} aria-hidden />
              Chat
            </Button>
          ) : null}
        </div>

        <Separator />

        <div>
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Stats
          </p>
          {spend.isInitialLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">Loading spend…</p>
          ) : spend.isError && isForbidden(spend.error) ? (
            <p className="mt-2 text-xs text-muted-foreground">Spend needs dashboard access.</p>
          ) : spend.isError ? (
            <p className="mt-2 text-xs text-destructive">Could not load spend.</p>
          ) : (
            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <dt className="text-[11px] text-muted-foreground">Spend</dt>
                <dd className="text-sm text-foreground">
                  {spendRow ? <MysoAmount amount={formatMistAmount(spendRow.spent_mist)} /> : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted-foreground">Calls</dt>
                <dd className="text-sm text-foreground">
                  {spendRow ? String(spendRow.usage_events) : '—'}
                </dd>
              </div>
            </dl>
          )}
        </div>

        <Separator />

        <div>
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Capabilities
          </p>
          {agent.capabilities.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No capabilities.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {agent.capabilities.map((capability) => (
                <Badge key={capability} variant="secondary">
                  {capability}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {agent.parentName ? (
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Reports to
            </p>
            <p className="mt-1 text-sm text-foreground">{agent.parentName}</p>
            <p className="text-xs text-muted-foreground">{agent.parentRole}</p>
          </div>
        ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function AuditLogList({
  audit,
  rows,
}: Readonly<{
  audit: ReturnType<typeof useOrgAuditLogs>;
  rows: ReturnType<typeof useOrgAuditLogs>['items'];
}>) {
  if (audit.isInitialLoading) {
    return <p className="text-xs text-muted-foreground">Loading audit log…</p>;
  }
  if (audit.isError && isForbidden(audit.error)) {
    return <p className="text-xs text-muted-foreground">Audit logs need auditor access.</p>;
  }
  if (audit.isError) {
    return <p className="text-xs text-destructive">Could not load the audit log.</p>;
  }
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No audit entries for this agent.</p>;
  }
  return (
    <div>
      <ul className="flex flex-col gap-3">
        {rows.map((entry) => (
          <li key={entry.id}>
            <p className="text-sm text-foreground">{humanizeKey(entry.action)}</p>
            <p className="text-xs text-muted-foreground">{formatTimestamp(entry.time)}</p>
          </li>
        ))}
      </ul>
      {audit.hasNextPage ? (
        <button
          type="button"
          className="mt-3 text-xs text-muted-foreground underline"
          onClick={audit.fetchNextPage}
        >
          {audit.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
