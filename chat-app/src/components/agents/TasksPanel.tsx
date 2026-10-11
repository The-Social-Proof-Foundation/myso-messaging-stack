import {useMemo, useState} from 'react';

import {formatMistAmount, truncateAddress} from '../../lib/agents/format';
import type {AgentTaskInfo} from '../../lib/agents/social-api';
import {TASK_STATUS, taskStatusLabel, viewerRole, type TaskRole} from '../../lib/agents/tasks';
import {useMyTasks, useTaskConfig, useTaskViewer} from '../../hooks/agents';
import {Button} from '../Button';
import {chipClass, cardClass, sectionTitleClass} from './chrome';
import {CreateTaskDialog} from './CreateTaskDialog';
import {ListError, LoadMoreRow} from './ListStates';
import {MysoAmount} from './MysoAmount';
import {ReputationBadge} from './ReputationBadge';
import {TaskDetailPane} from './TaskDetailPane';

type TaskTab = 'offers' | 'active' | 'done';

const TABS: {id: TaskTab; label: string}[] = [
  {id: 'offers', label: 'Offers'},
  {id: 'active', label: 'In progress'},
  {id: 'done', label: 'Done'},
];

function tabOf(task: AgentTaskInfo): TaskTab {
  if (task.status === TASK_STATUS.OFFERED) return 'offers';
  if (task.status === TASK_STATUS.ACCEPTED || task.status === TASK_STATUS.DELIVERED) return 'active';
  return 'done';
}

function TaskRow({task, role, onOpen}: Readonly<{task: AgentTaskInfo; role: TaskRole; onOpen: () => void}>) {
  // Show the counterparty's reputation: the seller's for a buyer, the buyer agent's for a seller.
  const counterpartyAgent = role === 'seller' ? task.buyerAgentId : task.sellerAgentId;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 border-b border-secondary-100 px-4 py-3 text-left transition-colors hover:bg-secondary-50 dark:border-secondary-800 dark:hover:bg-secondary-800/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
            {task.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-secondary-500 dark:text-secondary-400">
            <span>{role === 'observer' ? 'Watching' : role === 'buyer' ? 'You are buying' : 'You are selling'}</span>
            <span aria-hidden>·</span>
            <span>{taskStatusLabel(task)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{truncateAddress(counterpartyAgent ?? task.buyerPrincipal)}</span>
          </span>
          {counterpartyAgent ? <ReputationBadge agentObjectId={counterpartyAgent} className="mt-1" /> : null}
        </span>
        <MysoAmount amount={formatMistAmount(task.amountMist)} className="shrink-0 text-sm font-medium" />
      </button>
    </li>
  );
}

/** Task market: offers waiting on a seller, work in progress, and finished tasks with ratings. */
export function TasksPanel() {
  const tasks = useMyTasks();
  const viewer = useTaskViewer();
  const config = useTaskConfig();
  const [tab, setTab] = useState<TaskTab>('offers');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => tasks.tasks.filter((t) => tabOf(t) === tab), [tasks.tasks, tab]);
  const counts = useMemo(() => {
    const out: Record<TaskTab, number> = {offers: 0, active: 0, done: 0};
    for (const t of tasks.tasks) out[tabOf(t)] += 1;
    return out;
  }, [tasks.tasks]);

  if (openId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TaskDetailPane taskId={openId} onBack={() => setOpenId(null)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {TABS.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={chipClass(tab === item.id)}>
            {item.label}
            {counts[item.id] > 0 ? <span className="ml-1.5 text-xs text-secondary-400">{counts[item.id]}</span> : null}
          </button>
        ))}
        <span className="min-w-0 flex-1" />
        {config.data && !config.data.active ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">Market paused: no new offers</span>
        ) : null}
        <Button size="sm" onClick={() => setCreating(true)} disabled={config.data?.active === false}>
          New offer
        </Button>
      </div>

      <div className={`${cardClass} mt-4 min-h-0 flex-1 overflow-y-auto`}>
        <h2 className={`${sectionTitleClass} px-4 pt-3`}>{TABS.find((t) => t.id === tab)?.label}</h2>
        {tasks.isInitialLoading ? <p className="px-4 py-3 text-xs text-secondary-500">Loading…</p> : null}
        {tasks.isError ? <ListError error={tasks.error} onRetry={tasks.refetch} /> : null}
        {!tasks.isInitialLoading && !tasks.isError && visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-secondary-500 dark:text-secondary-400">
            {tab === 'offers'
              ? 'No open offers. Send one to an agent, or wait for an offer to arrive.'
              : tab === 'active'
                ? 'Nothing in progress.'
                : 'No finished tasks yet.'}
          </p>
        ) : null}
        <ul>
          {visible.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              role={viewer ? viewerRole(task, viewer) : 'observer'}
              onOpen={() => setOpenId(task.taskId)}
            />
          ))}
        </ul>
        {tasks.hasNextPage ? (
          <div className="p-3 text-center">
            <Button variant="secondary" size="sm" onClick={tasks.fetchNextPage} disabled={tasks.isFetchingNextPage}>
              {tasks.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </div>

      <CreateTaskDialog open={creating} onClose={() => setCreating(false)} onCreated={tasks.refetch} />
    </div>
  );
}
