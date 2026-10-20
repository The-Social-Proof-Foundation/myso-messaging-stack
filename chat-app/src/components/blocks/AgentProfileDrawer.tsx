import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {Check, ChevronDown, ChevronLeft, ChevronRight, Copy, ScrollText, X, Zap} from 'lucide-react';

import {IosPushStack} from '@/components/IosPushStack';
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
import {useAgentActions, useAgentChatsForAgent, useMemoryAccount, useOrganization, useOrgAuditLogs} from '@/hooks/agents';
import {useAuthenticatedAddress} from '@/contexts/MySocialAuthContext';
import {useMessagingMemberAddress} from '@/contexts/MessagingClientContext';
import {ConversationAvatar} from '@/components/ConversationAvatar';
import {useSidebarGroupMembers} from '@/hooks/useSidebarGroupMembers';
import {useSidebarMessagePreviews} from '@/hooks/useSidebarMessagePreviews';
import {useWalletAvatarMap} from '@/hooks/useWalletAvatarMap';
import {useOwnWalletProfile} from '@/hooks/useOwnWalletProfile';
import {useAgentNamesByAddress} from '@/hooks/agents/useSubAgents';
import {conversationPeerLabel, isKnownAgentAddress, knownAgentAddressSet} from '@/lib/agents/agent-display-name';
import {
  conversationDisplayTitle,
  dmPeerAddress,
  selfGroupNameLabelsForIdentities,
} from '@/lib/wallet-profile';
import type {StoredGroup} from '@/lib/group-store';
import {MultiBubbleIcon} from '@/components/icons/MultiBubbleIcon';
import {auditRowMentionsAgent} from '@/lib/agents/audit';
import {ReputationBadge} from '@/components/agents/ReputationBadge';
import {useAgentStats} from '@/hooks/agents/useAgentStats';
import {useAgentPnl} from '@/hooks/agents/useAgentPnl';
import {formatSignedMist} from '@/lib/agents/pnl';
import {useDerivedAgentKey} from '@/hooks/agents/useDerivedAgentKey';
import {useAllSubAgents} from '@/hooks/agents/useSubAgents';
import type {AgentChartNode, AgentChartAutomation} from '@/lib/agents/agent-chart';
import {AGENT_CHART_STATUS_LABEL} from '@/lib/agents/agent-chart';
import {
  CAP,
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  capabilityNames,
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
  /** Opens one of this agent's existing chats. */
  onOpenChat?: (groupUuid: string) => void;
  /** Opens another agent's details, used by the Reports to row. */
  onOpenAgent?: (agentId: string) => void;
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
  onOpenChat,
  onOpenAgent,
}: Readonly<AgentProfileDrawerProps>) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<'details' | 'audit' | 'automation'>('details');
  const [automationId, setAutomationId] = useState<string | null>(null);
  const chat = useAgentChatProgress(agent.id);
  const statsAgents = useMemo(() => [{id: agent.id, fullAddress: agent.fullAddress}], [agent.id, agent.fullAddress]);
  const stats = useAgentStats(organizationId, statsAgents).get(agent.id);
  const pnl = useAgentPnl(agent.id, stats?.spentMist);
  const audit = useOrgAuditLogs(organizationId);
  const agents = useAllSubAgents();
  const account = useMemoryAccount();
  const actions = useAgentActions();
  const row = useMemo(
    () => agents.items.find((item) => sameId(item.agent_object_id, agent.id)) ?? null,
    [agents.items, agent.id],
  );
  const agentChats = useAgentChatsForAgent(row, []);
  const chats = useMemo(
    () => [...agentChats.refs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [agentChats.refs],
  );
  const chatGroups = useMemo<StoredGroup[]>(
    () =>
      chats
        .filter((item) => item.uuid)
        .map((item) => ({
          uuid: item.uuid,
          name: item.name?.trim() || 'Untitled chat',
          groupId: item.groupId,
          createdAt: item.createdAt ?? 0,
        })),
    [chats],
  );
  const chatGroupIds = useMemo(() => chatGroups.map((group) => group.groupId), [chatGroups]);
  const membersByGroup = useSidebarGroupMembers(chatGroupIds);
  const previews = useSidebarMessagePreviews(chatGroups, {});
  const viewerAddress = useAuthenticatedAddress();
  const messagingAddress = useMessagingMemberAddress();
  const selfAddresses = useMemo(() => [messagingAddress, viewerAddress], [messagingAddress, viewerAddress]);
  const {profile: ownProfile} = useOwnWalletProfile();
  const selfLabels = useMemo(
    () => selfGroupNameLabelsForIdentities(selfAddresses, ownProfile),
    [selfAddresses, ownProfile],
  );
  const profileAddresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const members of membersByGroup.values()) {
      for (const member of members) {
        if (selfAddresses.some((self) => self && member.toLowerCase() === self.toLowerCase())) continue;
        addrs.add(member);
      }
    }
    return [...addrs];
  }, [membersByGroup, selfAddresses]);
  const profiles = useWalletAvatarMap(profileAddresses);
  const agentNames = useAgentNamesByAddress();
  const knownAgents = useMemo(
    () => knownAgentAddressSet([...agentNames.keys()], []),
    [agentNames],
  );
  const isAgentAddress = (member: string) => isKnownAgentAddress(member, knownAgents);
  const accountId = account.data?.account_id ?? null;
  const canPickModel = ownsAgent(accountId, row);
  const auditRows = useMemo(
    () => audit.items.filter((row) => auditRowMentionsAgent(row, [agent.id, agent.fullAddress])),
    [audit.items, agent.id, agent.fullAddress],
  );
  const selectedAutomation = useMemo(
    () => agent.automations?.find((item) => item.id === automationId) ?? null,
    [agent.automations, automationId],
  );
  const automationDelegate = useMemo(
    () =>
      automationId
        ? agents.items.find((item) => sameId(item.agent_object_id, automationId)) ?? null
        : null,
    [agents.items, automationId],
  );

  useEffect(() => {
    setView('details');
    setAutomationId(null);
  }, [agent.id]);

  function copyAddress() {
    void navigator.clipboard.writeText(agent.fullAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        {view === 'automation' ? (
          <button
            type="button"
            onClick={() => setView('details')}
            aria-label="Back to agent details"
            className="flex min-w-0 items-center gap-1 rounded text-foreground hover:text-foreground/80"
          >
            <ChevronLeft className="size-4 shrink-0" strokeWidth={2} aria-hidden />
            <span className="truncate font-chakra text-sm font-medium tracking-wide">
              {selectedAutomation?.name ?? 'Automation'}
            </span>
          </button>
        ) : view === 'audit' ? (
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {view === 'audit' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <AuditLogList audit={audit} rows={auditRows} organizationId={organizationId} />
          </div>
        ) : (
          <IosPushStack
            view={view === 'automation' ? 'automation' : 'details'}
            level={view === 'automation' ? 1 : 0}
            render={(screen) =>
              screen === 'automation' ? (
                <div className="h-full overflow-y-auto bg-card">
                  <AutomationDetail
                    item={selectedAutomation}
                    delegate={automationDelegate}
                    parentName={agent.name}
                  />
                </div>
              ) : (
                <div className="h-full overflow-y-auto bg-card">
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
                <MultiBubbleIcon data-icon="inline-start" strokeWidth={2} aria-hidden />
              )}
              New Chat
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
            <StatTile
              label="Available"
              value={
                <span
                  title={
                    stats?.budgetEnabled && stats.budgetMist != null
                      ? 'What this agent can still spend: the smaller of its balance and the budget it has left.'
                      : 'MySo this agent holds.'
                  }
                >
                  {drawerAmount(availableMist(stats))}
                </span>
              }
            />
            <StatTile label="Spent" value={drawerAmount(stats?.spentMist)} />
            <StatTile
              label="PnL"
              value={
                pnl ? (
                  <span
                    className={
                      pnl.pnlMist > 0n
                        ? 'text-emerald-500 dark:text-emerald-400'
                        : pnl.pnlMist < 0n
                          ? 'text-red-500 dark:text-red-400'
                          : undefined
                    }
                    title={`Earned ${formatMistAmount(pnl.revenueMist)} as seller, paid ${formatMistAmount(pnl.taskSpendMist)} as buyer, Spent ${formatMistAmount(pnl.aiSpentMist)}`}
                  >
                    <MysoAmount amount={formatSignedMist(pnl.pnlMist)} unitClassName={mysoUnitClass} />
                  </span>
                ) : (
                  '—'
                )
              }
            />
            <StatTile
              label="Memory"
              value={memoryStatLabel(stats?.memoryEntries)}
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

        {agent.parentId && agent.parentName ? (
          <>
            <div className="p-4">
              <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Reports to
              </p>
              <ul className="mt-2 overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
                <li>
                  <button
                    type="button"
                    disabled={!onOpenAgent}
                    onClick={() => {
                      if (agent.parentId) onOpenAgent?.(agent.parentId);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-secondary-800 transition-colors hover:bg-secondary-200/80 disabled:cursor-default disabled:hover:bg-transparent dark:text-secondary-100 dark:hover:bg-secondary-700 dark:disabled:hover:bg-transparent"
                  >
                    {agent.parentAddress ? (
                      <AgentOrb
                        agentKey={agent.parentAddress}
                        size={24}
                        label={agent.parentName}
                        className="shrink-0"
                      />
                    ) : (
                      <span className="size-6 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{agent.parentName}</span>
                    {agent.parentRole ? (
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-secondary-400 dark:text-secondary-500">
                        {agent.parentRole}
                      </span>
                    ) : null}
                    <ChevronRight className="h-4 w-4 shrink-0 text-secondary-400" strokeWidth={2} aria-hidden />
                  </button>
                </li>
              </ul>
            </div>
            <Separator />
          </>
        ) : null}

        {chats.length > 0 ? (
          <>
        <div className="p-4">
          <h4 className="font-chakra mb-2 text-sm font-medium capitalize tracking-wide text-secondary-500 dark:text-secondary-400">
            Chats ({chats.length})
          </h4>
          <ul className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
              {chatGroups.map((group) => {
                const members = membersByGroup.get(group.groupId) ?? [];
                const peer = dmPeerAddress(members, selfAddresses);
                const peerHandle = peer ? profiles.handleFor(peer) : null;
                const title = conversationDisplayTitle({
                  officialName: group.name,
                  selfLabels,
                  memberAddresses: members,
                  selfAddress: selfAddresses,
                  peerLabel: conversationPeerLabel(
                    peer,
                    agentNames,
                    peer ? profiles.headerTitleFor(peer) : null,
                  ),
                });
                const preview = previews.get(group.groupId) ?? '';
                return (
                  <li key={group.groupId} className="border-b border-secondary-200 last:border-b-0 dark:border-secondary-700">
                    <button
                      type="button"
                      disabled={!onOpenChat}
                      onClick={() => onOpenChat?.(group.uuid)}
                      className="w-full py-3 pl-[13px] pr-2 text-left text-secondary-700 transition-colors hover:bg-secondary-50 disabled:cursor-default disabled:hover:bg-transparent dark:text-secondary-300 dark:hover:bg-secondary-700/50 dark:disabled:hover:bg-transparent"
                    >
                      <div className="flex items-center gap-2.5">
                        <ConversationAvatar
                          memberAddresses={members}
                          selfAddress={selfAddresses}
                          profiles={profiles}
                          isAgentAddress={isAgentAddress}
                        />
                        <div className="min-w-0 flex-1 pt-px">
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <p className="min-w-0 translate-y-px truncate text-sm font-medium leading-tight">
                              {title}
                            </p>
                            {peer && isAgentAddress(peer) ? (
                              <span className="shrink-0 self-center rounded-[3px] bg-primary-500/10 px-1.5 py-[3px] text-[9px] font-semibold uppercase leading-none tracking-[0.08em] text-primary-600 ring-1 ring-inset ring-primary-500/25 dark:bg-white/[0.06] dark:text-secondary-200 dark:ring-white/15">
                                Agent
                              </span>
                            ) : null}
                            {peerHandle ? (
                              <span className="shrink-0 text-xs font-medium leading-tight tracking-tight text-secondary-500 dark:text-secondary-400">
                                {peerHandle}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug tracking-tight text-secondary-400 dark:text-secondary-500">
                            {preview || 'No messages yet'}
                          </p>
                        </div>
                        <ChevronRight
                          className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                          strokeWidth={2}
                          aria-hidden
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
        </div>
            <Separator />
          </>
        ) : null}

        {agent.automations?.length ? (
          <>
            <div className="p-4">
              <h4 className="font-chakra mb-2 text-sm font-medium capitalize tracking-wide text-secondary-500 dark:text-secondary-400">
                Automations ({agent.automations.length})
              </h4>
              <ul className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
                {agent.automations.map((item) => (
                  <li
                    key={item.id}
                    className="border-b border-secondary-200 last:border-b-0 dark:border-secondary-700"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAutomationId(item.id);
                        setView('automation');
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-secondary-800 transition-colors hover:bg-secondary-200/80 dark:text-secondary-100 dark:hover:bg-secondary-700"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                        <Zap className="h-4 w-4 text-amber-500" strokeWidth={2} aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-secondary-400 dark:text-secondary-500">
                        {AGENT_CHART_STATUS_LABEL[item.status]}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-secondary-400" strokeWidth={2} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <Separator />
          </>
        ) : null}

        <div className="p-4">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Reputation
          </p>
          <ReputationBadge agentObjectId={agent.id} variant="detailed" className="mt-2" />
        </div>

        <Separator />

        <div className="flex flex-col gap-4 p-4">
        <CollapsibleSection title="Permissions" count={agent.capabilities.length}>
          <CapabilityControls
            labels={agent.capabilities}
            row={row}
            accountId={account.data?.account_id ?? null}
            organizationId={organizationId}
            onSave={actions.updateAgent}
          />
        </CollapsibleSection>
        </div>
          </div>
              )
            }
          />
        )}
      </div>
    </aside>
  );
}

function memoryStatLabel(count: number | null | undefined): ReactNode {
  if (count == null) return '—';
  return (
    <span className="inline-flex items-baseline gap-1">
      <span>{count.toLocaleString()}</span>
      <span className={`${mysoUnitClass} text-secondary-400 dark:text-secondary-500`}>
        {count === 1 ? 'entry' : 'entries'}
      </span>
    </span>
  );
}

function drawerAmount(mist: bigint | null | undefined) {
  if (mist == null) return '—';
  return <MysoAmount amount={formatMistAmount(mist < 0n ? 0n : mist)} unitClassName={mysoUnitClass} />;
}

/** Spendable MySo: the balance, or the budget still left when that cap is lower. */
function availableMist(stats: {balanceMist: bigint | null; spentMist: bigint | null; budgetMist: bigint | null; budgetEnabled: boolean} | undefined): bigint | null {
  if (!stats || stats.balanceMist == null) return stats?.balanceMist ?? null;
  if (!stats.budgetEnabled || stats.budgetMist == null) return stats.balanceMist;
  const left = stats.budgetMist - (stats.spentMist ?? 0n);
  const room = left > 0n ? left : 0n;
  return stats.balanceMist < room ? stats.balanceMist : room;
}

function AutomationDetail({
  item,
  delegate,
  parentName,
}: Readonly<{
  item: AgentChartAutomation | null;
  delegate: SubAgentRow | null;
  parentName: string;
}>) {
  if (!item) {
    return <p className="p-4 text-sm text-muted-foreground">This automation is no longer on the agent.</p>;
  }
  const capabilities = delegate ? capabilityNames(delegate.capabilities).map((name) => CAPABILITY_LABELS[name]) : [];
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className="truncate text-sm font-semibold text-foreground">{item.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{AGENT_CHART_STATUS_LABEL[item.status]}</p>
      </div>
      <dl className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 text-xs dark:border-secondary-700 dark:bg-secondary-800">
        <DetailRow label="Runs for" value={parentName} />
        {delegate ? <DetailRow label="Address" value={delegate.derived_address} mono /> : null}
        {capabilities.length > 0 ? <DetailRow label="Capabilities" value={capabilities.join(', ')} /> : null}
      </dl>
      <p className="text-xs text-secondary-500 dark:text-secondary-400">
        Scheduled jobs run through this automation. Manage them under Automation.
      </p>
    </div>
  );
}

function DetailRow({label, value, mono = false}: Readonly<{label: string; value: string; mono?: boolean}>) {
  return (
    <div className="border-b border-secondary-200 px-3 py-2 last:border-b-0 dark:border-secondary-700">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-secondary-400 dark:text-secondary-500">
        {label}
      </dt>
      <dd className={`mt-0.5 break-all text-secondary-800 dark:text-secondary-100 ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </dd>
    </div>
  );
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
  'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-sm text-foreground outline-none data-[highlighted]:bg-secondary-200/80 dark:data-[highlighted]:bg-secondary-700';

function formatModelRate(value: number): string {
  const digits = value >= 1 ? 2 : 3;
  const text = value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return `$${text}`;
}

/** Input / output USD per 1M tokens, or null when the catalog has no price. */
function modelPriceLabel(option: LlmModelOption): string | null {
  const input = option.input_usd_per_1m;
  const output = option.output_usd_per_1m;
  if (input == null && output == null) return null;
  if (input != null && output != null) return `${formatModelRate(input)} / ${formatModelRate(output)}`;
  return formatModelRate((input ?? output) as number);
}

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
  const selectedItemRef = useRef<HTMLDivElement>(null);

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
      <DropdownMenu.Root
        onOpenChange={(open) => {
          if (!open) return;
          requestAnimationFrame(() => {
            selectedItemRef.current?.scrollIntoView({block: 'center'});
          });
        }}
      >
        <DropdownMenu.Trigger asChild disabled={saving}>
          <button
            type="button"
            className="mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-secondary-200 bg-secondary-100 px-2.5 py-1.5 text-left text-sm text-foreground disabled:opacity-60 dark:border-secondary-700 dark:bg-secondary-800"
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
            align="end"
            sideOffset={6}
            className="z-50 max-h-96 w-[calc(var(--radix-dropdown-menu-trigger-width)+2.75rem)] overflow-y-auto rounded-md border border-secondary-200 bg-secondary-100 p-1 shadow-md dark:border-secondary-700 dark:bg-secondary-800"
          >
            {options.map((option) => {
              const price = modelPriceLabel(option);
              const isSelected = option.id === selected;
              return (
              <DropdownMenu.Item
                key={option.id}
                ref={isSelected ? selectedItemRef : undefined}
                className={`${modelMenuItemClass} ${
                  isSelected ? 'bg-emerald-500/15 data-[highlighted]:bg-emerald-500/25' : ''
                }`}
                onSelect={() => void choose(option)}
              >
                <span className="min-w-0 flex-1 whitespace-normal leading-snug line-clamp-2">
                  {option.display_name}
                </span>
                <span
                  className="ml-auto shrink-0 self-center text-right tabular-nums text-xs text-secondary-500 dark:text-secondary-400"
                  title={price ? 'Input / output USD per 1M tokens' : undefined}
                >
                  {price}
                </span>
                {isSelected ? (
                  <Check className="size-3.5 shrink-0 self-center text-emerald-500" strokeWidth={2} aria-hidden />
                ) : null}
              </DropdownMenu.Item>
              );
            })}
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
  const [pendingAll, setPendingAll] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    if (pending && hasCapability(row.capabilities, pending.name) === pending.on) setPending(null);
    if (pendingAll != null) {
      const every = CAPABILITY_NAMES.every((name) => hasCapability(row.capabilities, name));
      const none = CAPABILITY_NAMES.every((name) => !hasCapability(row.capabilities, name));
      if ((pendingAll && every) || (!pendingAll && none)) setPendingAll(null);
    }
  }, [pending, pendingAll, row]);

  if (!canEdit || !row || !accountId) {
    if (labels.length === 0) {
      return <p className="mt-2 text-xs text-muted-foreground">No capabilities.</p>;
    }
    return (
      <ul className="mt-2 overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
        {labels.map((capability) => (
          <li
            key={capability}
            className="border-b border-secondary-200 px-3 py-1.5 text-xs font-medium text-secondary-800 last:border-b-0 dark:border-secondary-700 dark:text-secondary-100"
          >
            {capability}
          </li>
        ))}
      </ul>
    );
  }

  const anyOn =
    pendingAll ??
    CAPABILITY_NAMES.some((name) => hasCapability(row.capabilities, name));

  async function change(name: CapabilityName, next: boolean) {
    if (!row || !accountId || saving) return;
    const bit = CAP[name];
    setPendingAll(null);
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

  async function changeAll(next: boolean) {
    if (!row || !accountId || saving) return;
    const mask = next ? CAPABILITY_NAMES.reduce((bits, name) => bits | CAP[name], 0) : 0;
    setPending(null);
    setPendingAll(next);
    setSaving(true);
    setError(null);
    try {
      await onSave({
        accountId,
        agentObjectId: row.agent_object_id,
        organizationId: row.organization_id ?? organizationId,
        capabilities: mask,
        delegatableCaps: mask,
        expiresAtMs: row.expires_at_ms,
      });
    } catch (err) {
      setPendingAll(null);
      setError(err instanceof Error ? err.message : 'Could not update these capabilities.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <ul className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
        {CAPABILITY_NAMES.map((name) => {
          const checked =
            pendingAll ??
            (pending?.name === name ? pending.on : hasCapability(row.capabilities, name));
          return (
            <li
              key={name}
              className="flex items-center gap-2 border-b border-secondary-200 px-3 py-1.5 last:border-b-0 dark:border-secondary-700"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-800 dark:text-secondary-100">
                {CAPABILITY_LABELS[name]}
                {saving && pending?.name === name ? (
                  <span className="ml-1.5 font-normal text-secondary-400">Saving…</span>
                ) : null}
              </span>
              <IosToggle
                checked={checked}
                disabled={saving}
                onChange={(next) => void change(name, next)}
                aria-label={CAPABILITY_LABELS[name]}
              />
            </li>
          );
        })}
      </ul>
      <ul className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
        <li className="flex items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-800 dark:text-secondary-100">
            {anyOn ? 'Turn All Off' : 'Turn All On'}
            {saving && pendingAll != null ? (
              <span className="ml-1.5 font-normal text-secondary-400">Saving…</span>
            ) : null}
          </span>
          <IosToggle
            checked={anyOn}
            disabled={saving}
            onChange={(next) => void changeAll(next)}
            aria-label={anyOn ? 'Turn all permissions off' : 'Turn all permissions on'}
          />
        </li>
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The social server never grants Auditor implicitly, not even to the organization owner. This lets
 * the owner grant it to themselves in place, with one signature, instead of hunting for a screen.
 */
function GrantAuditAccess({organizationId}: Readonly<{organizationId: string | null}>) {
  const account = useMemoryAccount();
  const org = useOrganization(organizationId);
  const owner = useAuthenticatedAddress() ?? '';
  const actions = useAgentActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupId = org.data?.org_memory_group_id;
  const accountId = account.data?.account_id;

  if (!organizationId) return null;

  async function grant() {
    if (!groupId || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      await actions.grantOwnerOrgPermissions({
        accountId,
        organizationId: organizationId!,
        orgMemoryGroupId: groupId,
        ownerAddress: owner,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Audit logs need the Auditor permission. It is not granted automatically, even to the
        organization owner. Grant it to your wallet once to see every agent&apos;s log.
      </p>
      <Button size="sm" disabled={busy || !groupId || !accountId} onClick={() => void grant()}>
        {busy ? 'Granting…' : 'Grant audit access'}
      </Button>
      {!groupId && org.data ? (
        <p className="text-xs text-muted-foreground">
          Enable shared memory for this organization first (Organizations tab).
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function AuditLogList({
  audit,
  rows,
  organizationId,
}: Readonly<{
  audit: ReturnType<typeof useOrgAuditLogs>;
  rows: ReturnType<typeof useOrgAuditLogs>['items'];
  organizationId: string | null;
}>) {
  if (audit.isInitialLoading) {
    return <p className="text-xs text-muted-foreground">Loading audit log…</p>;
  }
  if (audit.isError && isForbidden(audit.error)) {
    return <GrantAuditAccess organizationId={organizationId} />;
  }
  if (audit.isError) {
    return <p className="text-xs text-destructive">Could not load the audit log.</p>;
  }
  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No audit entries for this agent{audit.hasNextPage ? ' in the entries loaded so far.' : '.'}
        </p>
      ) : null}
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
