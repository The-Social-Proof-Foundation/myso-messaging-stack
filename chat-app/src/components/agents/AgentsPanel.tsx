import {useState} from 'react';
import {MessageSquare, Pencil, Plus} from 'lucide-react';

import {CapabilityEditor} from './CapabilityEditor';
import {CreateAgentDialog} from './CreateAgentDialog';
import {ListError, LoadMoreRow} from './ListStates';
import {buttonClass, cardClass, sectionTitleClass} from './chrome';
import {capabilityNames} from '../../lib/agents/capabilities';
import type {AgentTreeNode} from '../../lib/agents/agent-tree';
import {truncateAddress} from '../../lib/agents/format';
import {writeSelectedAgent} from '../../lib/agents/selected-agent-store';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {useAgentActions, useMemoryAccount, useSubAgents} from '../../hooks/agents';
import {Button} from '../Button';

interface AgentsPanelProps {
  onChat: (agent: SubAgentRow) => void;
}

/** The agent tree with per-agent actions. Creation lives in a dialog, not an inline form. */
export function AgentsPanel({onChat}: Readonly<AgentsPanelProps>) {
  const account = useMemoryAccount();
  const agents = useSubAgents(false);
  const actions = useAgentActions();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <section className={`${cardClass} p-4`}>
      <div className="flex items-center gap-2">
        <h2 className={`min-w-0 flex-1 ${sectionTitleClass}`}>Agents</h2>
        <Button size="sm" disabled={!account.data} onClick={() => setShowNewAgent(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          New
        </Button>
      </div>

      {agents.isInitialLoading ? (
        <p className="mt-3 text-sm text-secondary-500">Loading…</p>
      ) : agents.isError ? (
        <ListError error={agents.error} onRetry={agents.refetch} className="mt-3 px-0" />
      ) : agents.tree.length === 0 ? (
        <div className="mt-6 text-center">
          <p className="text-sm text-secondary-500 dark:text-secondary-400">No agents yet.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={!account.data}
            onClick={() => setShowNewAgent(true)}
          >
            Create your first agent
          </Button>
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-3">
            {agents.tree.map((node) => (
              <AgentRow
                key={node.agent.agent_object_id}
                node={node}
                depth={0}
                accountId={account.data?.account_id}
                busy={busy}
                onRun={run}
                onChat={onChat}
                actions={actions}
              />
            ))}
          </ul>
          <LoadMoreRow list={agents} className="mt-2 px-0" />
        </>
      )}

      {error ? <p className="mt-3 text-sm text-danger-500">{error}</p> : null}

      <CreateAgentDialog
        open={showNewAgent}
        onClose={() => setShowNewAgent(false)}
        onCreated={() => void agents.refetch()}
      />
    </section>
  );
}

function AgentRow({
  node,
  depth,
  accountId,
  busy,
  onRun,
  onChat,
  actions,
}: {
  node: AgentTreeNode;
  depth: number;
  accountId: string | undefined;
  busy: string | null;
  onRun: (label: string, fn: () => Promise<void>) => Promise<void>;
  onChat: (agent: SubAgentRow) => void;
  actions: ReturnType<typeof useAgentActions>;
}) {
  const [editing, setEditing] = useState(false);
  const [mask, setMask] = useState(node.agent.capabilities);
  const [label, setLabel] = useState(node.agent.label);
  const agent = node.agent;

  return (
    <li style={{paddingLeft: depth * 16}}>
      <div className="rounded-lg border border-secondary-200 p-3 dark:border-secondary-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
              {agent.label}
            </p>
            <p className="truncate text-xs text-secondary-400">
              {truncateAddress(agent.derived_address)}
              {agent.active ? '' : ' · inactive'}
              {agent.revoked_at_ms ? ' · revoked' : ''}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-secondary-400">
              {capabilityNames(agent.capabilities).join(', ')}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (accountId) {
                  writeSelectedAgent({
                    agentObjectId: agent.agent_object_id,
                    derivedAddress: agent.derived_address,
                    memoryAccountId: accountId,
                    label: agent.label,
                    organizationId: agent.organization_id,
                  });
                }
                onChat(agent);
              }}
              className={buttonClass}
            >
              <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />
              Chat
            </button>
            <button type="button" onClick={() => setEditing((v) => !v)} className={buttonClass}>
              <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
              {editing ? 'Close' : 'Edit'}
            </button>
            {accountId && agent.active ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void onRun(`deact-${agent.agent_object_id}`, () =>
                    actions.deactivateAgent({
                      accountId,
                      agentObjectId: agent.agent_object_id,
                      organizationId: agent.organization_id,
                    }),
                  )
                }
                className={buttonClass}
              >
                Deactivate
              </button>
            ) : null}
            {accountId && !agent.revoked_at_ms ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void onRun(`revoke-${agent.agent_object_id}`, () =>
                    actions.revokeAgent({
                      accountId,
                      agentObjectId: agent.agent_object_id,
                      organizationId: agent.organization_id,
                    }),
                  )
                }
                className="rounded-md border border-danger-300 px-3 py-1.5 text-xs font-medium text-danger-600 transition-colors hover:bg-danger-50 dark:border-danger-700 dark:text-danger-400 dark:hover:bg-danger-950/40"
              >
                Revoke
              </button>
            ) : null}
          </div>
        </div>
        {editing && accountId ? (
          <div className="mt-3 space-y-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-md border border-secondary-300 bg-white px-2 py-1.5 text-sm text-secondary-800 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-100"
            />
            <CapabilityEditor mask={mask} onChange={setMask} />
            <Button
              size="sm"
              disabled={Boolean(busy)}
              onClick={() =>
                void onRun(`edit-${agent.agent_object_id}`, async () => {
                  await actions.updateAgent({
                    accountId,
                    agentObjectId: agent.agent_object_id,
                    organizationId: agent.organization_id,
                    capabilities: mask,
                    label,
                  });
                  setEditing(false);
                })
              }
            >
              Save
            </Button>
          </div>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {node.children.map((child) => (
            <AgentRow
              key={child.agent.agent_object_id}
              node={child}
              depth={depth + 1}
              accountId={accountId}
              busy={busy}
              onRun={onRun}
              onChat={onChat}
              actions={actions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
