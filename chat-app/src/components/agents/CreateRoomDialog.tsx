import {useMemo, useState} from 'react';

import {AGENT_ROOM_KIND} from '../../lib/agents/rooms';
import {AGENT_CHAT_STAGE_LABEL, type AgentChatStage} from '../../hooks/agents/useAgentChatActions';
import {hasCapability} from '../../lib/agents/capabilities';
import type {AgentChatErrorInfo} from '../../lib/agents/format-agent-chat-error';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {useSubAgents} from '../../hooks/agents';
import {Button} from '../Button';
import {Dialog, dialogFieldClass} from '../Dialog';
import {ErrorNotice} from './ErrorNotice';

const OBJECT_ID = /^0x[0-9a-fA-F]{1,64}$/;

export interface CreateRoomRequest {
  agent: SubAgentRow;
  name: string;
  /** Opaque task object id; omitted for a free-standing room. */
  taskId?: string;
}

interface CreateRoomDialogProps {
  open: boolean;
  onClose: () => void;
  /** Runs the create flow (platform join, agent signature, permissions). Resolves when ready. */
  onCreate: (request: CreateRoomRequest) => Promise<void>;
  stage: AgentChatStage | null;
  error: AgentChatErrorInfo | null;
  /** Pre-fills the task binding, e.g. when opened from a task. */
  defaultTaskId?: string;
}

/** Modal form for creating an agent room: an agent group tagged and optionally bound to a task. */
export function CreateRoomDialog({
  open,
  onClose,
  onCreate,
  stage,
  error,
  defaultTaskId,
}: Readonly<CreateRoomDialogProps>) {
  const agents = useSubAgents(false);
  const eligible = useMemo(
    () =>
      agents.agents.filter(
        (agent) =>
          agent.active &&
          !agent.revoked_at_ms &&
          hasCapability(agent.capabilities, 'MESSAGE_SEND') &&
          hasCapability(agent.capabilities, 'MESSAGE_READ'),
      ),
    [agents.agents],
  );

  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [taskId, setTaskId] = useState(defaultTaskId ?? '');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedAgentId = agentId || eligible[0]?.agent_object_id || '';
  const trimmedTask = taskId.trim();
  const taskInvalid = trimmedTask.length > 0 && !OBJECT_ID.test(trimmedTask);

  function close() {
    if (busy) return;
    setLocalError(null);
    onClose();
  }

  async function submit() {
    const agent = eligible.find((row) => row.agent_object_id === selectedAgentId);
    if (!agent) {
      setLocalError('Pick an agent that can send and read messages.');
      return;
    }
    if (!name.trim()) {
      setLocalError('Give the room a name.');
      return;
    }
    if (taskInvalid) {
      setLocalError('The task id must be an object id such as 0x1234….');
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onCreate({
        agent,
        name: name.trim(),
        taskId: trimmedTask || undefined,
      });
      setName('');
      setTaskId(defaultTaskId ?? '');
      onClose();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const shownError = error?.message ?? localError;

  return (
    <Dialog
      open={open}
      title="New Room"
      onClose={close}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || eligible.length === 0}>
            {busy ? (stage ? AGENT_CHAT_STAGE_LABEL[stage] : 'Creating…') : 'Create'}
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
        <p className="text-xs text-secondary-500 dark:text-secondary-400">
          A room is an encrypted agent group (kind {AGENT_ROOM_KIND}). You stay the room curator and
          can rename it.
        </p>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Agent
          <select
            value={selectedAgentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={busy || eligible.length === 0}
            className={`mt-1 ${dialogFieldClass}`}
          >
            {eligible.length === 0 ? <option value="">No agent can message yet</option> : null}
            {eligible.map((agent) => (
              <option key={agent.agent_object_id} value={agent.agent_object_id}>
                {agent.label.trim() || 'Agent'}
              </option>
            ))}
          </select>
        </label>
        {eligible.length === 0 && !agents.isInitialLoading ? (
          <p className="text-xs text-secondary-500 dark:text-secondary-400">
            Enable &quot;Send messages&quot; and &quot;Read messages&quot; on an agent first.
          </p>
        ) : null}

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Launch coordination"
            disabled={busy}
            autoFocus
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Task id <span className="font-normal text-secondary-400">(optional)</span>
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            placeholder="0x…"
            disabled={busy}
            aria-invalid={taskInvalid}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        {shownError ? <ErrorNotice>{shownError}</ErrorNotice> : null}
      </form>
    </Dialog>
  );
}
