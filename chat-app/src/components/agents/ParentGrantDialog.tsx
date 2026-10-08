import {useEffect, useMemo} from 'react';
import {X} from 'lucide-react';

import {
  CAPABILITY_LABELS,
  capabilityNames,
  hasCapability,
  type CapabilityName,
} from '../../lib/agents/capabilities';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {Button} from '../Button';
import {AgentOrb} from './AgentOrb';

interface ParentGrantDialogProps {
  open: boolean;
  parent: SubAgentRow;
  /** Every agent we know about, used to draw the chain above the parent. */
  agents: readonly SubAgentRow[];
  childLabel: string;
  childCapabilities: number;
  /** Capabilities the parent holds after the grant. */
  grant: {capabilities: number; delegatableCaps: number};
  onApprove: () => void;
  onCancel: () => void;
}

function ancestorsOf(parent: SubAgentRow, agents: readonly SubAgentRow[]): SubAgentRow[] {
  const byId = new Map(agents.map((agent) => [agent.agent_object_id, agent]));
  const chain: SubAgentRow[] = [];
  const seen = new Set<string>([parent.agent_object_id]);
  let next = parent.parent_object_id ? byId.get(parent.parent_object_id) : undefined;
  while (next && !seen.has(next.agent_object_id)) {
    chain.unshift(next);
    seen.add(next.agent_object_id);
    next = next.parent_object_id ? byId.get(next.parent_object_id) : undefined;
  }
  return chain;
}

function Chip({name, added}: Readonly<{name: CapabilityName; added?: boolean}>) {
  return (
    <span
      className={`rounded-[3px] px-1.5 py-0.5 text-[11px] leading-none ${
        added
          ? 'bg-[#D6F59A]/20 text-[#D6F59A] ring-1 ring-inset ring-[#D6F59A]/40'
          : 'bg-secondary-700/40 text-secondary-300 ring-1 ring-inset ring-white/10'
      }`}
    >
      {added ? '+ ' : ''}
      {CAPABILITY_LABELS[name]}
    </span>
  );
}

function Node({
  label,
  role,
  depth,
  highlight,
  orbKey,
  children,
}: Readonly<{
  label: string;
  orbKey?: string;
  role: string;
  depth: number;
  highlight?: boolean;
  children?: React.ReactNode;
}>) {
  return (
    <div style={{marginLeft: depth * 18}} className="relative">
      {depth > 0 ? (
        <span
          aria-hidden
          className="absolute -left-3 top-0 h-4 w-3 rounded-bl border-b border-l border-secondary-600"
        />
      ) : null}
      <div
        className={`rounded-md border px-3 py-2 ${
          highlight
            ? 'border-[#D6F59A]/50 bg-[#D6F59A]/5'
            : 'border-secondary-700 bg-secondary-900/40'
        }`}
      >
        <div className="flex items-center gap-2">
          {orbKey ? <AgentOrb agentKey={orbKey} size={22} label={label} /> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary-100">{label}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-secondary-400">
            {role}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Explains why creating a child can need the parent's permissions to grow: a child can only
 * receive authority its parent holds and may delegate, so the parent is updated first.
 */
export function ParentGrantDialog({
  open,
  parent,
  agents,
  childLabel,
  childCapabilities,
  grant,
  onApprove,
  onCancel,
}: Readonly<ParentGrantDialogProps>) {
  useEffect(() => {
    if (!open) return;
    // Capture so the surrounding New Agent dialog's own Escape handler never sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  const ancestors = useMemo(() => ancestorsOf(parent, agents), [parent, agents]);
  if (!open) return null;

  const added = capabilityNames(grant.capabilities).filter(
    (name) => !hasCapability(parent.capabilities, name),
  );
  const addedDelegation = capabilityNames(grant.delegatableCaps).filter(
    (name) => !hasCapability(parent.delegatable_caps, name),
  );
  const held = capabilityNames(parent.capabilities);
  const childDepth = ancestors.length + 1;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        event.stopPropagation();
        onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-grant-title"
        className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-secondary-800"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="min-h-0 space-y-4 overflow-y-auto p-6">
          <div className="relative flex flex-col items-center gap-3 pt-1 text-center">
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="absolute right-0 top-0 text-secondary-400 hover:text-secondary-200"
            >
              <X className="h-5 w-5" />
            </button>
            <AgentOrb agentKey={parent.derived_address} size={72} label={parent.label} />
            <div>
              <h2 id="parent-grant-title" className="text-lg font-semibold">
                {parent.label} needs your OK
              </h2>
              <p className="mt-1 text-sm text-secondary-500 dark:text-secondary-400">
                To create <strong>{childLabel}</strong>, {parent.label} must first be given
                {added.length ? ' a few extra permissions' : ' permission to pass these on'}. An
                agent can only hand a child permissions it holds itself.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {ancestors.map((agent, index) => (
              <Node
                key={agent.agent_object_id}
                orbKey={agent.derived_address}
                label={agent.label}
                role={index === 0 ? 'Root' : 'Ancestor'}
                depth={index}
              />
            ))}
            <Node
              orbKey={parent.derived_address}
              label={parent.label}
              role="Parent · gets update"
              depth={ancestors.length}
              highlight
            >
              <div className="mt-2 flex flex-wrap gap-1">
                {held.map((name) => (
                  <Chip key={name} name={name} />
                ))}
                {added.map((name) => (
                  <Chip key={name} name={name} added />
                ))}
              </div>
              {addedDelegation.length ? (
                <p className="mt-2 text-[11px] text-secondary-400">
                  Newly delegatable: {addedDelegation.map((n) => CAPABILITY_LABELS[n]).join(', ')}
                </p>
              ) : null}
            </Node>
            <Node label={childLabel} role="New agent" depth={childDepth}>
              <div className="mt-2 flex flex-wrap gap-1">
                {capabilityNames(childCapabilities).map((name) => (
                  <Chip key={name} name={name} />
                ))}
              </div>
            </Node>
          </div>

          <p className="text-xs text-secondary-500 dark:text-secondary-400">
            You'll approve this once. We update {parent.label} first, then create {childLabel} right away.
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onApprove}>Approve &amp; create agent</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
