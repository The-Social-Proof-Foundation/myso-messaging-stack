import {useCallback} from 'react';
import {Navigate, useSearchParams} from 'react-router-dom';

import {AutomationPanel} from '../components/agents/AutomationPanel';
import {CreditsPanel} from '../components/agents/CreditsPanel';
import {OrganizationsPanel} from '../components/agents/OrganizationsPanel';
import {chipClass, pageTitleClass} from '../components/agents/chrome';
import {useMySocialAuth} from '../contexts/MySocialAuthContext';

type AgentsTab = 'overview' | 'organizations';

const TABS: {id: AgentsTab; label: string}[] = [
  {id: 'overview', label: 'Overview'},
  {id: 'organizations', label: 'Organizations'},
];

function parseTab(value: string | null): AgentsTab {
  return value === 'organizations' || value === 'agents' ? 'organizations' : 'overview';
}

/**
 * Agent configuration workspace: credits and organizations.
 *
 * Agent chats live in the home sidebar. `?tab=agents` still opens Organizations, because
 * that chart replaced the old Agents tab.
 */
export function AgentsPage() {
  const {session, auth, configError} = useMySocialAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));

  const setTab = useCallback(
    (next: AgentsTab) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      setSearchParams(params, {replace: true});
    },
    [searchParams, setSearchParams],
  );

  if (configError) {
    return (
      <main className="flex flex-1 items-center justify-center px-8">
        <div className="max-w-md text-center text-sm text-danger-500 dark:text-danger-400">
          {configError}
        </div>
      </main>
    );
  }

  if (auth && !session) {
    return <Navigate to="/" replace />;
  }

  const organizationsTab = tab === 'organizations';

  return (
    <main
      className={
        organizationsTab
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-6'
          : 'flex-1 overflow-y-auto px-6 py-8'
      }
    >
      <div
        className={
          organizationsTab
            ? 'flex min-h-0 w-full flex-1 flex-col gap-4'
            : 'mx-auto max-w-5xl space-y-6'
        }
      >
        <div className="shrink-0">
          <h1 className={pageTitleClass}>Agents &amp; Organizations</h1>
          <p className="mt-1 text-sm text-secondary-500 dark:text-secondary-400">
            Fund AI credits and manage organizations. Chats live in the home conversation list.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={chipClass(tab === item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'overview' ? (
          <>
            <CreditsPanel />
            <AutomationPanel />
          </>
        ) : null}
        {organizationsTab ? <OrganizationsPanel /> : null}
      </div>
    </main>
  );
}
