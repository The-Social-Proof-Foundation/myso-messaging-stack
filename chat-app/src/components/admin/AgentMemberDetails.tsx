import {useMemo} from 'react';

import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import {CAPABILITY_LABELS, capabilityNames} from '../../lib/agents/capabilities';
import {AgentModelLabel} from '../agents/AgentModelLabel';

const sameAddress = (a: string, b: string) =>
  a.toLowerCase().replace(/^0x0*/, '') === b.toLowerCase().replace(/^0x0*/, '');

/**
 * What an agent member is: the model it answers with, then every permission its key was granted.
 * Shown at the top of the member's dropdown, above the group's send / read toggles.
 */
export function AgentMemberDetails({address}: Readonly<{address: string}>) {
  const agents = useAllSubAgents();
  const agent = useMemo(
    () => agents.items.find((row) => sameAddress(row.derived_address, address)) ?? null,
    [agents.items, address],
  );
  const permissions = useMemo(() => (agent ? capabilityNames(agent.capabilities) : []), [agent]);

  // An agent the signed-in owner does not manage has no readable record here.
  if (!agent) return null;

  return (
    <div className="space-y-2.5 border-t border-secondary-200 bg-secondary-50/50 px-3 pb-3 pt-2.5 dark:border-secondary-700 dark:bg-secondary-900/60">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-secondary-500 dark:text-secondary-400">Model</span>
        <AgentModelLabel
          agentId={agent.agent_object_id}
          fallback="Locked"
          className="min-w-0 truncate font-medium text-secondary-700 dark:text-secondary-200"
        />
      </div>

      <div>
        <p className="mb-1.5 text-xs text-secondary-500 dark:text-secondary-400">
          Permissions{permissions.length ? ` (${permissions.length})` : ''}
        </p>
        {permissions.length === 0 ? (
          <p className="text-xs text-secondary-400 dark:text-secondary-500">No permissions granted.</p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {permissions.map((name) => (
              <li
                key={name}
                className="rounded bg-secondary-200/70 px-2 py-0.5 text-[10.5px] font-medium text-secondary-700 dark:bg-secondary-700/60 dark:text-secondary-200"
              >
                {CAPABILITY_LABELS[name]}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
