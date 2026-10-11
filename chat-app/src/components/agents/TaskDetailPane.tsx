import {useEffect, useMemo, useState, type ReactNode} from 'react';

import {classifyTaskError} from '../../lib/agents/format-task-error';
import {formatMistAmount, truncateAddress} from '../../lib/agents/format';
import {
  TASK_STATUS,
  availableActions,
  feeBreakdown,
  formatTermsWindow,
  releaseAtMs,
  taskStatusLabel,
  type TaskAction,
  type TaskRole,
} from '../../lib/agents/tasks';
import {transactionDetailsUrl} from '../../lib/chat-payments';
import {
  useSubAgents,
  useTask,
  useTaskActions,
  useTaskConfig,
  useTaskViewer,
} from '../../hooks/agents';
import {viewerRole} from '../../lib/agents/tasks';
import {Button} from '../Button';
import {cardClass, sectionTitleClass} from './chrome';
import {ErrorNotice} from './ErrorNotice';
import {MysoAmount} from './MysoAmount';
import {ReputationBadge} from './ReputationBadge';
import {
  AcceptTaskDialog,
  DeliverTaskDialog,
  ReviewTaskDialog,
  SettleTaskDialog,
} from './TaskDialogs';

type OpenDialog = 'accept' | 'settle' | 'review' | 'deliver' | null;

function formatTime(ms: number | null): string {
  return ms == null ? '—' : new Date(ms).toLocaleString();
}

function Fact({label, children}: Readonly<{label: string; children: ReactNode}>) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="text-secondary-500 dark:text-secondary-400">{label}</dt>
      <dd className="text-right text-secondary-900 dark:text-secondary-100">{children}</dd>
    </div>
  );
}

function Stars({value}: Readonly<{value: number | null}>) {
  if (!value) return <span className="text-secondary-400">Not yet rated</span>;
  return (
    <span aria-label={`${value} out of 5 stars`}>
      {'★'.repeat(value)}
      <span className="text-secondary-300 dark:text-secondary-600">{'★'.repeat(5 - value)}</span>
    </span>
  );
}

interface TaskDetailPaneProps {
  taskId: string;
  onBack: () => void;
}

/**
 * One task, what happens next, and who can do it. The action bar only ever offers steps the
 * contract would accept right now for the viewer's role (see `availableActions`), and there is
 * deliberately no refund button for the buyer once work is delivered: that needs the seller's
 * agreement, or the buyer settles.
 */
export function TaskDetailPane({taskId, onBack}: Readonly<TaskDetailPaneProps>) {
  const query = useTask(taskId);
  const config = useTaskConfig();
  const viewer = useTaskViewer();
  const actions = useTaskActions();
  const ownAgents = useSubAgents(false);

  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [busyAction, setBusyAction] = useState<TaskAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Deadlines decide which buttons exist, so keep the clock current while the pane is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const task = query.data ?? null;
  const role: TaskRole = task && viewer ? viewerRole(task, viewer) : 'observer';
  const available = useMemo(
    () =>
      task && config.data
        ? availableActions(task, role, now, {releaseGraceMs: config.data.releaseGraceMs})
        : [],
    [task, role, now, config.data],
  );
  const sellerAgent = useMemo(
    () => ownAgents.agents.find((a) => a.agent_object_id === task?.sellerAgentId) ?? null,
    [ownAgents.agents, task?.sellerAgentId],
  );

  if (query.isLoading) {
    return <p className="p-6 text-sm text-secondary-500">Loading task…</p>;
  }
  if (!task) {
    return (
      <div className="p-6">
        <ErrorNotice>This task could not be found. It may not be indexed yet.</ErrorNotice>
        <Button variant="secondary" className="mt-3" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }

  const fees = feeBreakdown(task.amountMist, task.platformFeeBps, task.ecosystemFeeBps, task.platformId != null);
  const txUrl = transactionDetailsUrl(task.transactionId);
  const releaseAt = config.data ? releaseAtMs(task, config.data) : null;
  const reviewSide = role === 'buyer' ? 'buyer' : 'seller';

  async function run(action: TaskAction, work: () => Promise<unknown>) {
    setBusyAction(action);
    setError(null);
    try {
      await work();
      await query.refetch();
    } catch (err) {
      setError(classifyTaskError(err).message);
    } finally {
      setBusyAction(null);
    }
  }

  const ACTION_BUTTONS: Record<TaskAction, {label: string; variant?: 'primary' | 'secondary' | 'danger'; onClick: () => void}> = {
    accept: {label: 'Review offer', onClick: () => setDialog('accept')},
    decline: {label: 'Decline', variant: 'danger', onClick: () => setDialog('accept')},
    cancel_offer: {label: 'Cancel offer', variant: 'danger', onClick: () => void run('cancel_offer', () => actions.cancelOffer(task))},
    expire_offer: {label: 'Return escrow (expired)', variant: 'secondary', onClick: () => void run('expire_offer', () => actions.expireOffer(task))},
    deliver: {label: 'Deliver work', onClick: () => setDialog('deliver')},
    refund_missed_delivery: {label: 'Refund (delivery missed)', variant: 'secondary', onClick: () => void run('refund_missed_delivery', () => actions.refundMissedDelivery(task))},
    settle: {label: 'Pay seller', onClick: () => setDialog('settle')},
    release: {label: 'Release payment to seller', variant: 'secondary', onClick: () => void run('release', () => actions.releaseTask(task))},
    propose_refund: {label: 'Propose refund', variant: 'secondary', onClick: () => void run('propose_refund', () => actions.proposeRefund(task))},
    accept_refund: {label: 'Accept refund', onClick: () => void run('accept_refund', () => actions.acceptRefund(task))},
    reject_refund: {label: 'Reject refund', variant: 'danger', onClick: () => void run('reject_refund', () => actions.rejectRefund(task))},
    withdraw_refund: {label: 'Withdraw proposal', variant: 'secondary', onClick: () => void run('withdraw_refund', () => actions.withdrawRefund(task))},
    review: {label: role === 'buyer' ? 'Rate seller' : 'Rate buyer', variant: 'secondary', onClick: () => setDialog('review')},
  };

  const proposer = task.refundProposer === 1 ? 'buyer' : task.refundProposer === 2 ? 'seller' : null;
  const reviews = task.reviews ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 pb-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Tasks
        </Button>
        <span className="rounded-full bg-secondary-100 px-2 py-0.5 text-xs text-secondary-700 dark:bg-secondary-800 dark:text-secondary-200">
          {taskStatusLabel(task)}
        </span>
        <span className="text-xs text-secondary-400">
          You are {role === 'observer' ? 'watching' : `the ${role}`}
        </span>
      </div>

      <div className={`${cardClass} p-4`}>
        <h2 className={sectionTitleClass}>{task.title}</h2>
        <dl className="mt-2 divide-y divide-secondary-100 dark:divide-secondary-700">
          <Fact label="Payment">
            <MysoAmount amount={formatMistAmount(task.amountMist)} />
          </Fact>
          <Fact label="Seller receives">
            <MysoAmount amount={formatMistAmount(task.netAmountMist ?? fees.netMist)} />
          </Fact>
          <Fact label="Seller agent">
            <span className="inline-flex flex-col items-end gap-0.5">
              <span className="font-mono text-xs">{truncateAddress(task.sellerAgentId)}</span>
              <ReputationBadge agentObjectId={task.sellerAgentId} />
            </span>
          </Fact>
          <Fact label="Buyer">
            <span className="inline-flex flex-col items-end gap-0.5">
              <span className="font-mono text-xs">
                {truncateAddress(task.buyerAgentId ?? task.buyerPrincipal)}
              </span>
              {task.buyerAgentId ? <ReputationBadge agentObjectId={task.buyerAgentId} /> : null}
            </span>
          </Fact>
          <Fact label="Deliver within">{formatTermsWindow(task.deliveryWindowMs)} of accepting</Fact>
          <Fact label="Settle within">{formatTermsWindow(task.settleWindowMs)} of delivery</Fact>
          <Fact label="Offer expires">{formatTime(task.acceptDeadlineMs)}</Fact>
          {task.deliveryDeadlineMs != null ? <Fact label="Delivery due">{formatTime(task.deliveryDeadlineMs)}</Fact> : null}
          {task.settleDeadlineMs != null ? <Fact label="Settle by">{formatTime(task.settleDeadlineMs)}</Fact> : null}
          {task.status === TASK_STATUS.DELIVERED && releaseAt != null ? (
            <Fact label="Auto-release to seller">{formatTime(releaseAt)}</Fact>
          ) : null}
          {task.deliverableUri ? (
            <Fact label="Deliverable">
              <span className="break-all text-xs">{task.deliverableUri}</span>
            </Fact>
          ) : null}
          {task.deliverableDigest ? (
            <Fact label="Deliverable hash">
              <span className="font-mono text-xs" title={task.deliverableDigest}>
                {task.deliverableDigest.slice(0, 16)}…
              </span>
            </Fact>
          ) : null}
          {txUrl ? (
            <Fact label="Offer transaction">
              <a href={txUrl} target="_blank" rel="noopener noreferrer" className="text-primary-600 underline dark:text-primary-400">
                View
              </a>
            </Fact>
          ) : null}
        </dl>
      </div>

      {proposer && task.status === TASK_STATUS.DELIVERED ? (
        <div className={`${cardClass} mt-3 border-amber-300 p-4 text-sm dark:border-amber-700`}>
          The {proposer} proposed a full refund. The {proposer === 'buyer' ? 'seller' : 'buyer'} must
          accept it; it does not delay the seller’s automatic payment.
        </div>
      ) : null}

      {task.status === TASK_STATUS.SETTLED ? (
        <div className={`${cardClass} mt-3 p-4`}>
          <h3 className={sectionTitleClass}>Ratings</h3>
          <dl className="mt-1 divide-y divide-secondary-100 dark:divide-secondary-700">
            <Fact label="Buyer rated seller">
              <Stars value={task.buyerReviewStars} />
            </Fact>
            <Fact label="Seller rated buyer">
              <Stars value={task.sellerReviewStars} />
            </Fact>
          </dl>
          {reviews.length > 0 ? (
            <p className="mt-2 text-xs text-secondary-500">
              Ratings are weighted by task value and the rater’s track record, so the same pair rating each
              other repeatedly counts for less each time.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {available.length === 0 ? (
          <p className="text-sm text-secondary-500 dark:text-secondary-400">
            {role === 'observer' ? 'You are not a party to this task.' : 'Nothing for you to do right now.'}
          </p>
        ) : null}
        {available.map((action) => {
          const spec = ACTION_BUTTONS[action];
          return (
            <Button
              key={action}
              variant={spec.variant ?? 'primary'}
              disabled={busyAction !== null}
              onClick={spec.onClick}
            >
              {busyAction === action ? 'Working…' : spec.label}
            </Button>
          );
        })}
      </div>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}

      <AcceptTaskDialog
        open={dialog === 'accept'}
        task={task}
        config={config.data}
        onClose={() => setDialog(null)}
        onDone={() => void query.refetch()}
      />
      <SettleTaskDialog
        open={dialog === 'settle'}
        task={task}
        onClose={() => setDialog(null)}
        onDone={() => void query.refetch()}
      />
      <ReviewTaskDialog
        open={dialog === 'review'}
        task={task}
        side={reviewSide}
        onClose={() => setDialog(null)}
        onDone={() => void query.refetch()}
      />
      <DeliverTaskDialog
        open={dialog === 'deliver'}
        task={task}
        agent={sellerAgent}
        maxUriBytes={config.data?.maxUriBytes ?? 2048}
        onClose={() => setDialog(null)}
        onDone={() => void query.refetch()}
      />
    </div>
  );
}
