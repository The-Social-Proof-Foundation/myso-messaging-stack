import {useMemo, useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {ChevronLeft, Ellipsis} from 'lucide-react';

import {AgentOrgChart} from '../blocks/AgentOrgChart';
import {Button} from '../Button';
import {ListError} from './ListStates';
import {agentForestToChart} from '../../lib/agents/agent-chart';
import {buildAgentTree} from '../../lib/agents/agent-tree';
import {
  formatByteSize,
  formatCount,
  formatMysoAmount,
  graphqlNumber,
  type ProfileOrganization,
} from '../../lib/agents/profile-graphql';
import {ORGANIZATION_CATEGORIES} from '../../lib/agents/org-types';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {useAgentActions, useMemoryAccount, useOrganization} from '../../hooks/agents';
import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import {useProfileOverview} from '../../hooks/agents/useProfileOverview';
import {MysoAmount} from './MysoAmount';
import {formatMistAmount} from '../../lib/agents/format';
import {StatTile, mysoUnitClass} from './StatTile';

interface OrganizationChartPaneProps {
  organizationId: string;
  onCreateAgent: () => void;
  onChat: (agent: SubAgentRow) => void;
  onMobileBack?: () => void;
}

function sameId(left: string, right: string): boolean {
  return left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();
}

function categoryLabel(orgType: string | number | null | undefined): string | null {
  if (orgType == null || orgType === '') return null;
  if (typeof orgType === 'number') {
    return ORGANIZATION_CATEGORIES.find((category) => category.value === orgType)?.displayName ?? null;
  }
  const slug = orgType.trim().toLowerCase().replace(/_/g, '-');
  return ORGANIZATION_CATEGORIES.find((category) => category.slug === slug)?.displayName ?? orgType;
}

const moreItemClass =
  'flex w-full cursor-pointer select-none items-center rounded-md px-3 py-2 text-left text-sm text-secondary-800 outline-none hover:bg-secondary-50 focus:bg-secondary-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:text-secondary-100 dark:hover:bg-secondary-800 dark:focus:bg-secondary-800';

export function OrganizationChartPane({
  organizationId,
  onCreateAgent,
  onChat,
  onMobileBack,
}: Readonly<OrganizationChartPaneProps>) {
  const overview = useProfileOverview();
  const social = useOrganization(organizationId);
  const account = useMemoryAccount();
  const actions = useAgentActions();
  const owner = useAuthenticatedAddress() ?? '';
  const agents = useAllSubAgents();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const graphqlOrg: ProfileOrganization | undefined = overview.data?.organizations.find((org) =>
    sameId(org.organizationId, organizationId),
  );
  const row = social.data;
  const name = graphqlOrg?.name?.trim() || row?.name?.trim() || 'Untitled';
  const description = graphqlOrg?.description ?? row?.description ?? null;
  const active = graphqlOrg?.active ?? row?.active ?? true;
  const orgType = graphqlOrg?.orgType ?? row?.org_type ?? null;
  const groupId = row?.org_memory_group_id;
  const stats = graphqlOrg?.statistics;

  const orgAgents = useMemo(
    () => agents.items.filter((agent) => agent.organization_id && sameId(agent.organization_id, organizationId)),
    [agents.items, organizationId],
  );
  const chartRoots = useMemo(() => agentForestToChart(buildAgentTree(orgAgents)), [orgAgents]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-secondary-50 dark:bg-secondary-950">
      {onMobileBack ? (
        <button
          type="button"
          onClick={onMobileBack}
          className="flex items-center gap-1 px-4 py-2 text-sm text-secondary-600 md:hidden dark:text-secondary-300"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Organizations
        </button>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {agents.isLoading ? (
          <p className="p-4 text-sm text-secondary-500">Loading agents…</p>
        ) : agents.isError ? (
          <ListError error={agents.error} onRetry={() => void agents.refetch()} className="p-4" />
        ) : (
          <AgentOrgChart
            className="min-h-0 flex-1"
            title={name}
            description={description ?? ''}
            active={active}
            meta={categoryLabel(orgType)}
            actions={
              <>
                <Button size="sm" variant="secondary" onClick={onCreateAgent} disabled={!account.data}>
                  New agent
                </Button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button variant="secondary" size="sm" aria-label="More" className="px-2">
                      <Ellipsis className="h-4 w-4" strokeWidth={2} aria-hidden />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={6}
                      className="z-50 min-w-52 overflow-hidden rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
                    >
                      <DropdownMenu.Item
                        disabled={Boolean(busy) || Boolean(groupId) || !account.data}
                        className={moreItemClass}
                        onSelect={() => {
                          void run('memory', async () => {
                            await actions.ensureOrgMemory({
                              accountId: account.data!.account_id,
                              organizationId,
                              ownerAddress: owner,
                            });
                          });
                        }}
                      >
                        {groupId
                          ? 'Shared memory enabled'
                          : busy === 'memory'
                            ? 'Enabling…'
                            : 'Enable shared memory'}
                      </DropdownMenu.Item>
                      {active && account.data ? (
                        <DropdownMenu.Item
                          disabled={Boolean(busy)}
                          className={`${moreItemClass} text-danger-600 focus:text-danger-600 dark:text-danger-400 dark:focus:text-danger-400`}
                          onSelect={() => {
                            void run('deact', () =>
                              actions.deactivateOrganization({
                                accountId: account.data!.account_id,
                                organizationId,
                              }),
                            );
                          }}
                        >
                          {busy === 'deact' ? 'Deactivating…' : 'Deactivate'}
                        </DropdownMenu.Item>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </>
            }
            details={
              stats || error ? (
                <div>
                  {stats ? (
                    <dl className="flex flex-wrap gap-2 pb-2">
                      <StatTile
                        label="Revenue"
                        value={
                          <MysoAmount
                            amount={formatMysoAmount(stats.totalRevenueMyso)}
                            unitClassName={mysoUnitClass}
                          />
                        }
                      />
                      <StatTile
                        label="Loss"
                        value={
                          <MysoAmount
                            amount={formatMysoAmount(stats.totalOutboundSpendMyso)}
                            unitClassName={mysoUnitClass}
                          />
                        }
                      />
                      <StatTile
                        label="Net"
                        value={
                          <MysoAmount
                            amount={formatMysoAmount(stats.netCashFlowMyso)}
                            unitClassName={mysoUnitClass}
                          />
                        }
                      />
                      <StatTile label="Actions" value={formatCount(stats.totalActionsExecuted)} />
                      <StatTile label="AI events" value={formatCount(stats.aiCreditUsageEvents)} />
                      <StatTile
                        label="AI spent"
                        value={
                          <MysoAmount
                            amount={formatMistAmount(graphqlNumber(stats.aiCreditSpentMist))}
                            unitClassName={mysoUnitClass}
                          />
                        }
                      />
                      <StatTile label="Engagement" value={formatCount(stats.totalEngagement)} />
                      <StatTile
                        label="Memory"
                        value={`${formatCount(stats.memoryEntries)} · ${formatByteSize(stats.memoryBytes)}`}
                      />
                    </dl>
                  ) : null}
                  {error ? <p className="mt-2 text-sm text-danger-500">{error}</p> : null}
                </div>
              ) : null
            }
            roots={chartRoots}
            organizationId={organizationId}
            onAgentCreated={() => void agents.refetch()}
            onChat={(node) => {
              const match = orgAgents.find((agent) => sameId(agent.agent_object_id, node.id));
              if (match) onChat(match);
            }}
          />
        )}
      </div>
    </div>
  );
}
