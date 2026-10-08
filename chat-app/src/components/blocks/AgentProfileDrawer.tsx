import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {Check, ChevronDown, ChevronLeft, Copy, MessageSquare, ScrollText, X} from 'lucide-react';

import {Badge} from '@/components/ui/badge';
import {LegacyAgentBackup} from '@/components/agents/LegacyAgentBackup';
import {Button} from '@/components/ui/button';
import {Separator} from '@/components/ui/separator';
import {IosToggle} from '@/components/IosToggle';
import {MysoAmount} from '@/components/agents/MysoAmount';
import {StatTile, mysoUnitClass} from '@/components/agents/StatTile';
import {AgentStatusDot} from '@/components/blocks/AgentStatusMark';
import {AgentOrb} from '@/components/agents/AgentOrb';
import {AgentModelLabel} from '@/components/agents/AgentModelLabel';
import {ErrorNotice} from '@/components/agents/ErrorNotice';
import {useAgentChatProgress} from '@/lib/agents/chat-progress';
import {useAgentActions, useMemoryAccount, useOrgAuditLogs} from '@/hooks/agents';
import {useAgentStats} from '@/hooks/agents/useAgentStats';
import {useDerivedAgentKey} from '@/hooks/agents/useDerivedAgentKey';
import {useAllSubAgents} from '@/hooks/agents/useSubAgents';
import type {AgentChartNode} from '@/lib/agents/agent-chart';
import {
  CAP,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  hasCapability,
  type CapabilityName,
} from '@/lib/agents/capabilities';
import {formatMistAmount} from '@/lib/agents/format';
import {formatTimestamp, humanizeKey} from '@/lib/agents/org-display';
import {
  createAgentMemoryClient,
  getAgentLlmModel,
  listLlmModels,
  setAgentLlmModel,
  type AgentLlmModel,
  type LlmModelOption,
} from '@/lib/agents/memory-client';
import {SocialServerError, type SubAgentRow} from '@/lib/agents/social-api';

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
  const chat = useAgentChatProgress(agent.id);
  const statsAgents = useMemo(() => [{id: agent.id, fullAddress: agent.fullAddress}], [agent.id, agent.fullAddress]);
  const stats = useAgentStats(organizationId, statsAgents).get(agent.id);
  const audit = useOrgAuditLogs(organizationId);
  const agents = useAllSubAgents();
  const account = useMemoryAccount();
  const actions = useAgentActions();
  const row = useMemo(
    () => agents.items.find((item) => sameId(item.agent_object_id, agent.id)) ?? null,
    [agents.items, agent.id],
  );
  const accountId = account.data?.account_id ?? null;
  const canPickModel = ownsAgent(accountId, row);
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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view === 'audit' ? (
          <div className="p-4">
            <AuditLogList audit={audit} rows={auditRows} />
          </div>
        ) : (
          <>
        <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <AgentOrb
              agentKey={agent.fullAddress}
              size={48}
              label={agent.name}
              className="border border-border"
            />
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
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <AgentModelLabel agentId={agent.id} fallback={agent.role} />
            </p>
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
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 text-xs"
              onClick={onChat}
              disabled={chat.busy}
              aria-busy={chat.busy}
            >
              {chat.busy ? (
                <span
                  aria-hidden
                  className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
                />
              ) : (
                <MessageSquare data-icon="inline-start" strokeWidth={2} aria-hidden />
              )}
              Chat
            </Button>
          ) : null}
        </div>
        {chat.busy ? (
          <p role="status" className="text-xs text-muted-foreground">
            {chat.message}
          </p>
        ) : null}
        {chat.error ? <ErrorNotice>{chat.error}</ErrorNotice> : null}
        </div>

        <Separator />

        <div className="p-4">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Stats
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <StatTile label="Balance" value={drawerAmount(stats?.balanceMist)} />
            <StatTile label="AI spent" value={drawerAmount(stats?.spentMist)} />
            <StatTile
              label="Budget left"
              value={
                stats?.budgetEnabled && stats.budgetMist != null
                  ? drawerAmount(stats.budgetMist - (stats.spentMist ?? 0n))
                  : stats
                    ? 'No budget'
                    : '—'
              }
            />
            <StatTile
              label="Memory"
              value={stats?.memoryEntries == null ? '—' : stats.memoryEntries.toLocaleString()}
            />
          </div>
        </div>

        <Separator />

        {canPickModel && row && accountId ? (
          <>
            <div className="p-4">
              <ModelControls
                row={row}
                accountId={accountId}
                maxIndex={Math.max(agents.totalCount ?? 0, 32)}
              />
            </div>
            <Separator />
          </>
        ) : null}

        <div className="flex flex-col gap-4 p-4">
        <CollapsibleSection title="Capabilities" count={agent.capabilities.length}>
          <CapabilityControls
            labels={agent.capabilities}
            row={row}
            accountId={account.data?.account_id ?? null}
            organizationId={organizationId}
            onSave={actions.updateAgent}
          />
        </CollapsibleSection>

        {agent.parentName ? (
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Reports to
            </p>
            <p className="mt-1 text-sm text-foreground">{agent.parentName}</p>
            <p className="text-xs text-muted-foreground">{agent.parentRole}</p>
          </div>
        ) : null}
        </div>
          </>
        )}
      </div>
    </aside>
  );
}

function drawerAmount(mist: bigint | null | undefined) {
  if (mist == null) return '—';
  return <MysoAmount amount={formatMistAmount(mist < 0n ? 0n : mist)} unitClassName={mysoUnitClass} />;
}

/** Header button that folds its content away with a short height animation. Closed by default. */
function CollapsibleSection({
  title,
  count,
  children,
}: Readonly<{title: string; count?: number; children: ReactNode}>) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
          {count != null ? <span className="ml-1.5 normal-case tracking-normal">({count})</span> : null}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      <div
        aria-hidden={!open}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

const modelMenuItemClass =
  'flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-muted';

function ModelControls({
  row,
  accountId,
  maxIndex,
}: Readonly<{
  row: SubAgentRow;
  accountId: string;
  maxIndex: number;
}>) {
  const queryClient = useQueryClient();
  const derived = useDerivedAgentKey(row, maxIndex);
  const memory = useMemo(
    () => (derived.data ? createAgentMemoryClient(derived.data, accountId) : null),
    [accountId, derived.data],
  );
  useEffect(()=>()=>memory?.destroy(),[memory]);
  const models = useQuery({
    queryKey: ['agents', 'llm-models', row.agent_object_id],
    enabled: Boolean(memory),
    queryFn: () => listLlmModels(memory!),
  });
  const current = useQuery({
    queryKey: ['agents', 'llm-model', row.agent_object_id],
    enabled: Boolean(memory),
    queryFn: () => getAgentLlmModel(memory!),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = models.data?.models ?? [];
  const selected = current.data?.model_id ?? '';
  const selectedIsDefault = current.data?.source !== 'saved';
  const selectedLabel =
    options.find((option) => option.id === selected)?.display_name || selected || 'Model';

  async function choose(option: LlmModelOption) {
    if (!memory || saving || option.id === selected) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await setAgentLlmModel(memory, option.id);
      queryClient.setQueryData<AgentLlmModel>(['agents', 'llm-model', row.agent_object_id], saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this model.');
    } finally {
      setSaving(false);
    }
  }

  let body: ReactNode;
  if (derived.isPending || derived.isLoading) {
    body = <p className="mt-2 text-xs text-muted-foreground">Loading model…</p>;
  } else if (!derived.data) {
    body = <><p className="mt-2 text-xs text-destructive">{derived.error?.message ?? 'Unlock agent keys to access this agent.'}</p><LegacyAgentBackup agent={row}/></>;
  } else if (models.isPending || current.isPending) {
    body = <p className="mt-2 text-xs text-muted-foreground">Loading model…</p>;
  } else if (models.isError || current.isError) {
    body = <p className="mt-2 text-xs text-destructive">Could not load models.</p>;
  } else if (options.length === 0) {
    body = <p className="mt-2 text-xs text-muted-foreground">No models are available.</p>;
  } else {
    body = (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild disabled={saving}>
          <button
            type="button"
            className="mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-sm text-foreground disabled:opacity-60"
            aria-label="Model"
            disabled={saving}
          >
            <span className="truncate">
              {selectedLabel}
              {saving ? <span className="ml-1.5 text-xs text-muted-foreground">Saving…</span> : null}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            className="z-50 max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-md border border-border bg-card p-1 shadow-md"
          >
            {options.map((option) => (
              <DropdownMenu.Item
                key={option.id}
                className={modelMenuItemClass}
                onSelect={() => void choose(option)}
              >
                <span className="truncate">{option.display_name}</span>
                {option.id === selected ? (
                  <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Model</p>
      {body}
      {derived.data && !models.isPending && !current.isPending && !current.isError ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {selectedIsDefault
            ? 'No model chosen yet — the server default is answering. Pick one to fix it for this agent.'
            : 'Saved for this agent.'}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ownsAgent(accountId: string | null, row: SubAgentRow | null): boolean {
  if (!accountId || !row || !row.active || row.revoked_at_ms) return false;
  return sameId(accountId, row.account_id);
}

function withBit(mask: number, bit: number, on: boolean): number {
  return on ? mask | bit : mask & ~bit;
}

function CapabilityControls({
  labels,
  row,
  accountId,
  organizationId,
  onSave,
}: Readonly<{
  labels: string[];
  row: SubAgentRow | null;
  accountId: string | null;
  organizationId: string | null;
  onSave: (args: {
    accountId: string;
    agentObjectId: string;
    organizationId?: string | null;
    capabilities: number;
    delegatableCaps: number;
    expiresAtMs?: number | null;
  }) => Promise<void>;
}>) {
  const canEdit = ownsAgent(accountId, row);
  const [pending, setPending] = useState<{name: CapabilityName; on: boolean} | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pending || !row) return;
    if (hasCapability(row.capabilities, pending.name) === pending.on) setPending(null);
  }, [pending, row]);

  if (!canEdit || !row || !accountId) {
    if (labels.length === 0) {
      return <p className="mt-2 text-xs text-muted-foreground">No capabilities.</p>;
    }
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {labels.map((capability) => (
          <Badge key={capability} variant="secondary">
            {capability}
          </Badge>
        ))}
      </div>
    );
  }

  async function change(name: CapabilityName, next: boolean) {
    if (!row || !accountId || saving) return;
    const bit = CAP[name];
    setPending({name, on: next});
    setSaving(true);
    setError(null);
    try {
      await onSave({
        accountId,
        agentObjectId: row.agent_object_id,
        organizationId: row.organization_id ?? organizationId,
        capabilities: withBit(row.capabilities, bit, next),
        delegatableCaps: withBit(row.delegatable_caps, bit, next),
        expiresAtMs: row.expires_at_ms,
      });
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : 'Could not update this capability.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {CAPABILITY_NAMES.map((name) => {
        const checked = pending?.name === name ? pending.on : hasCapability(row.capabilities, name);
        return (
          <div key={name} className="flex items-center justify-between gap-3">
            <span className="min-w-0 text-sm text-foreground">
              {CAPABILITY_LABELS[name]}
              {saving && pending?.name === name ? (
                <span className="ml-1.5 text-xs text-muted-foreground">Saving…</span>
              ) : null}
            </span>
            <IosToggle
              checked={checked}
              disabled={saving}
              onChange={(next) => void change(name, next)}
              aria-label={CAPABILITY_LABELS[name]}
            />
          </div>
        );
      })}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
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
