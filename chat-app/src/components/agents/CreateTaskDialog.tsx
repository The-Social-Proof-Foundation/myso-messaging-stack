import {useMemo, useState} from 'react';
import {sha256} from '@noble/hashes/sha2.js';

import {classifyTaskError} from '../../lib/agents/format-task-error';
import {formatMistAmount, parseMysoToMist, truncateAddress} from '../../lib/agents/format';
import {feeBreakdown} from '../../lib/agents/tasks';
import type {AgentRoomInfo, TaskConfigInfo} from '../../lib/agents/social-api';
import {useAgentRooms, useTaskActions, useTaskConfig} from '../../hooks/agents';
import {useAllSubAgents} from '../../hooks/agents/useSubAgents';
import {Button} from '../Button';
import {isAutomationDelegateLabel} from '../../lib/agents/automation-delegate';
import {Dialog, DialogSelect, dialogFieldClass} from '../Dialog';
import {ErrorNotice} from './ErrorNotice';
import {ReputationBadge} from './ReputationBadge';
import {MysoAmount} from './MysoAmount';

const HOUR_MS = 3_600_000;

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
  /** Pre-selects a room to bind, e.g. when opened from a room. */
  defaultRoom?: AgentRoomInfo | null;
}

/** Hours as the dialog shows them, clamped into the market's allowed window. */
function clampHours(hours: number, minMs: number, maxMs: number): number {
  return Math.min(Math.max(hours * HOUR_MS, minMs), maxMs) / HOUR_MS;
}

function windowHint(min: number, max: number): string {
  const fmt = (ms: number) => (ms >= 86_400_000 ? `${+(ms / 86_400_000).toFixed(1)}d` : `${+(ms / HOUR_MS).toFixed(1)}h`);
  return `${fmt(min)} to ${fmt(max)}`;
}

/**
 * Makes an escrowed offer to a named seller agent. The seller must accept the exact terms
 * before any work starts; until then the offer can be cancelled, and if it goes unanswered it
 * expires and the escrow comes back.
 */
export function CreateTaskDialog({open, onClose, onCreated, defaultRoom = null}: Readonly<CreateTaskDialogProps>) {
  const config = useTaskConfig();
  const rooms = useAgentRooms();
  const actions = useTaskActions();
  const agents = useAllSubAgents({enabled: open});
  const sellers = useMemo(
    () =>
      agents.items
        .filter((agent) => agent.active && !agent.revoked_at_ms && !isAutomationDelegateLabel(agent.label))
        .sort((a, b) => (a.label || a.agent_object_id).localeCompare(b.label || b.agent_object_id)),
    [agents.items],
  );

  const [sellerAgentId, setSellerAgentId] = useState('');
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [amount, setAmount] = useState('');
  const [acceptHours, setAcceptHours] = useState(24);
  const [deliveryHours, setDeliveryHours] = useState(72);
  const [settleHours, setSettleHours] = useState(72);
  const [roomId, setRoomId] = useState(defaultRoom?.groupId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c: TaskConfigInfo | null | undefined = config.data;
  const amountMist = useMemo(() => parseMysoToMist(amount), [amount]);

  const fees =
    amountMist && c
      ? feeBreakdown(Number(amountMist), c.platformFeeBps, c.ecosystemFeeBps, false)
      : null;

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  async function submit() {
    if (!c) {
      setError('The task market configuration is not available yet.');
      return;
    }
    if (!c.active) {
      setError('The task market is paused and is not taking new offers.');
      return;
    }
    if (!title.trim()) return setError('Give the task a title.');
    if (!scope.trim()) return setError('Describe what the seller must deliver.');
    if (!amountMist || amountMist < BigInt(c.minEscrowMist)) {
      return setError(`Escrow at least ${formatMistAmount(c.minEscrowMist)} MySo.`);
    }
    setBusy(true);
    setError(null);
    const selectedSellerId = sellerAgentId || sellers[0]?.agent_object_id || '';
    try {
      const target = sellers.find((agent) => agent.agent_object_id === selectedSellerId);
      if (!target) throw new Error('Pick an active agent to send this offer to.');
      await actions.createTask({
        sellerAccountId: target.account_id,
        sellerAgentId: target.agent_object_id,
        amountMist,
        // The scope text itself is shared off-chain; only its sha256 is committed on-chain.
        scopeDigest: sha256(new TextEncoder().encode(scope.trim())),
        title: title.trim(),
        acceptWindowMs: Math.round(clampHours(acceptHours, c.acceptWindowMinMs, c.acceptWindowMaxMs) * HOUR_MS),
        deliveryWindowMs: Math.round(clampHours(deliveryHours, c.deliveryWindowMinMs, c.deliveryWindowMaxMs) * HOUR_MS),
        settleWindowMs: Math.round(clampHours(settleHours, c.settleWindowMinMs, c.settleWindowMaxMs) * HOUR_MS),
        roomGroupId: roomId || null,
        platformId: null,
      });
      setTitle('');
      setScope('');
      setAmount('');
      setSellerAgentId('');
      onCreated?.();
      onClose();
    } catch (err) {
      setError(classifyTaskError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="New Task Offer"
      onClose={close}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !c?.active || sellers.length === 0}>
            {busy ? 'Escrowing…' : 'Send offer'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Seller agent
          <DialogSelect
            value={sellerAgentId || sellers[0]?.agent_object_id || ''}
            onChange={(event) => setSellerAgentId(event.target.value)}
            disabled={busy || sellers.length === 0}
          >
            {sellers.length === 0 ? (
              <option value="">{agents.isLoading ? 'Loading agents…' : 'No active agents'}</option>
            ) : null}
            {sellers.map((agent) => (
              <option key={agent.agent_object_id} value={agent.agent_object_id}>
                {(agent.label.trim() || 'Agent') + ' · ' + truncateAddress(agent.derived_address)}
              </option>
            ))}
          </DialogSelect>
          <ReputationBadge
            agentObjectId={sellerAgentId || sellers[0]?.agent_object_id || null}
            variant="detailed"
            className="mt-1"
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={c?.maxTitleBytes ?? 128}
            placeholder="Write the launch report"
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Scope
          <textarea
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            rows={3}
            placeholder="What exactly must be delivered. Only its hash goes on-chain."
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Payment (MySo)
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="10"
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>
        {fees && amountMist ? (
          <p className="text-xs text-secondary-500 dark:text-secondary-400">
            Seller receives <MysoAmount amount={formatMistAmount(fees.netMist)} /> after{' '}
            {(((c?.platformFeeBps ?? 0) + (c?.ecosystemFeeBps ?? 0)) / 100).toFixed(2)}% fees.
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          {[
            ['Accept within (h)', acceptHours, setAcceptHours, c && windowHint(c.acceptWindowMinMs, c.acceptWindowMaxMs)],
            ['Deliver within (h)', deliveryHours, setDeliveryHours, c && windowHint(c.deliveryWindowMinMs, c.deliveryWindowMaxMs)],
            ['Settle within (h)', settleHours, setSettleHours, c && windowHint(c.settleWindowMinMs, c.settleWindowMaxMs)],
          ].map(([label, value, setter, hint]) => (
            <label key={label as string} className="block text-xs font-medium text-secondary-700 dark:text-secondary-300">
              {label as string}
              <input
                type="number"
                min={1}
                value={value as number}
                onChange={(event) => (setter as (n: number) => void)(Number(event.target.value))}
                disabled={busy}
                className={`mt-1 ${dialogFieldClass}`}
              />
              <span className="mt-0.5 block text-[11px] font-normal text-secondary-400">{(hint as string) ?? ''}</span>
            </label>
          ))}
        </div>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Room <span className="font-normal text-secondary-400">(optional)</span>
          <DialogSelect
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={busy}
          >
            <option value="">No room</option>
            {rooms.rooms.map((room) => (
              <option key={room.groupId} value={room.groupId}>
                {room.groupName ?? room.groupId}
              </option>
            ))}
          </DialogSelect>
        </label>

        <p className="text-xs text-secondary-500 dark:text-secondary-400">
          Funds are escrowed now and returned if the seller declines, does not answer in time, or you
          cancel before they accept. After delivery you pay by settling; a refund then needs both of
          you to agree.
        </p>

        {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      </form>
    </Dialog>
  );
}
