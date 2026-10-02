import {useMemo} from 'react';
import {ChevronLeft, ChevronRight, Plus} from 'lucide-react';

import {agentCountLabel, graphqlNumber, type ProfileOrganization} from '../../lib/agents/profile-graphql';
import {useProfileOverview} from '../../hooks/agents/useProfileOverview';
import {Button} from '../Button';
import {sidebarShellClass} from '../SidebarShell';
import {ListError} from './ListStates';

interface AgentListViewProps {
  selectedOrganizationId: string | null;
  onBack: () => void;
  onSelectOrganization: (organizationId: string) => void;
  onNewOrganization: () => void;
}

function agentTotal(org: ProfileOrganization): number {
  return graphqlNumber(org.statistics?.totalAgents) ?? 0;
}

/** Most agents first. Equal counts put active organizations ahead of inactive ones. */
function compareOrganizations(a: ProfileOrganization, b: ProfileOrganization): number {
  const byCount = agentTotal(b) - agentTotal(a);
  if (byCount !== 0) return byCount;
  if (a.active === b.active) return 0;
  return a.active ? -1 : 1;
}

/**
 * Organizations sidebar: one tappable row per organization. Agents live on the chart
 * in the main pane, not nested under the row.
 */
export function AgentListView({
  selectedOrganizationId,
  onBack,
  onSelectOrganization,
  onNewOrganization,
}: Readonly<AgentListViewProps>) {
  const overview = useProfileOverview();
  const organizations = useMemo(
    () => [...(overview.data?.organizations ?? [])].sort(compareOrganizations),
    [overview.data?.organizations],
  );

  return (
    <aside className={sidebarShellClass}>
      <div className="flex shrink-0 items-center gap-1 border-b border-secondary-200 px-2 py-2 dark:border-secondary-700">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-secondary-600 transition-colors hover:bg-secondary-100 dark:text-secondary-300 dark:hover:bg-secondary-700"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
          Chats
        </button>
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewOrganization}
          title="New organization"
          aria-label="New organization"
          className="shrink-0 gap-1"
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          New
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {overview.isPending ? (
          <p className="px-4 py-3 text-xs text-secondary-500 dark:text-secondary-400">Loading…</p>
        ) : null}
        {overview.isError ? (
          <ListError error={overview.error} onRetry={() => void overview.refetch()} />
        ) : null}
        {!overview.isPending && !overview.isError && organizations.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-secondary-500 dark:text-secondary-400">
              No organizations yet.
            </p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onNewOrganization}>
              Create an organization
            </Button>
          </div>
        ) : null}
        <ul>
          {organizations.map((org) => {
            const selected =
              selectedOrganizationId?.toLowerCase() === org.organizationId.toLowerCase();
            return (
              <li
                key={org.organizationId}
                className="border-b border-secondary-200 dark:border-secondary-700"
              >
                <button
                  type="button"
                  onClick={() => onSelectOrganization(org.organizationId)}
                  className={`flex w-full items-center gap-2 px-4 py-3 text-left transition-colors ${
                    selected
                      ? 'bg-secondary-100 dark:bg-secondary-800'
                      : 'hover:bg-secondary-50 dark:hover:bg-secondary-700/50'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
                      {org.name?.trim() || 'Untitled'}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-secondary-500 dark:text-secondary-400">
                      {agentCountLabel(org.statistics?.totalAgents, org.statistics?.totalAgents)}
                    </span>
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                    strokeWidth={2}
                    aria-hidden
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
