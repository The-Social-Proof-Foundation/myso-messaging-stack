import {useEffect, useMemo, useState, type ReactNode} from 'react';

import {classifyTaskError} from '../../lib/agents/format-task-error';
import {formatMistAmount, truncateAddress} from '../../lib/agents/format';
import {
  DISPUTE_OUTCOME_LABEL,
  JURY_CASE_STATE,
  JURY_CASE_STATE_LABEL,
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
  useTaskDispute,
  useTaskViewer,
} from '../../hooks/agents';
import type {TaskDetailInfo, TaskDisputeDetailInfo} from '../../lib/agents/social-api';
import {viewerRole} from '../../lib/agents/tasks';
import {useJuryRationales} from '../../hooks/agents/useJury';
import {Button} from '../Button';
import {cardClass, sectionTitleClass} from './chrome';
import {ErrorNotice} from './ErrorNotice';
import {MysoAmount} from './MysoAmount';
import {ReputationBadge} from './ReputationBadge';
import {
  AcceptTaskDialog,
  AppealDisputeDialog,
  DeliverTaskDialog,
  DisputeEvidenceDialog,
  DisputeSettlementDialog,
  OpenDisputeDialog,
  ReviewTaskDialog,
  SettleTaskDialog,
} from './TaskDialogs';

type OpenDialog =
  | 'accept'
  | 'settle'
  | 'review'
  | 'deliver'
  | 'dispute'
  | 'evidence'
  | 'appeal'
  | 'settlement'
  | null;

const DISPUTE_SOURCE_LABEL: Record<number, string> = {
  1: 'jury verdict',
  2: 'agreement',
  3: 'automatic split after the jury could not decide',
};

function DisputeCard({
  task,
  detail,
  now,
}: Readonly<{task: TaskDetailInfo; detail: TaskDisputeDetailInfo | null; now: number}>) {
  const jury = detail?.case ?? null;
  // Jurors reveal once voting has started, so there is nothing to read before then.
  const rationales = useJuryRationales(jury?.caseId ?? null, (jury?.state ?? 0) >= JURY_CASE_STATE.VOTING);
  const d = task.dispute;
  if (!d) return null;
  const round = jury?.rounds.at(-1) ?? null;
  const seats = jury ? jury.roundSizes[jury.currentRound] : undefined;
  const confirmed = jury
    ? jury.jurors.filter((j) => j.round === jury.currentRound && j.status >= 2 && j.status <= 4).length
    : 0;
  const proposer = d.agreementProposer === 1 ? 'buyer' : d.agreementProposer === 2 ? 'seller' : null;
  const status =
    d.state === 2
      ? 'Withdrawn before a jury was drawn'
      : d.state === 3 && d.resolvedOutcome != null
        ? `${DISPUTE_OUTCOME_LABEL[d.resolvedOutcome] ?? 'Resolved'} (${DISPUTE_SOURCE_LABEL[d.resolvedSource ?? 0] ?? 'resolved'})`
        : jury
          ? (JURY_CASE_STATE_LABEL[jury.state] ?? 'In progress')
          : 'Opening…';

  return (
    <div className={`${cardClass} mt-3 border-amber-300 p-4 dark:border-amber-700`}>
      <h3 className={sectionTitleClass}>Dispute</h3>
      <dl className="mt-1 divide-y divide-secondary-100 dark:divide-secondary-700">
        <Fact label="Status">{status}</Fact>
        <Fact label="Opened by">{d.openedByRole === 1 ? 'The buyer' : 'The seller'}</Fact>
        <Fact label="Case fee">
          <MysoAmount amount={formatMistAmount(d.feeEachMist)} /> each
        </Fact>
        <Fact label="Fee paid so far">
          Buyer <MysoAmount amount={formatMistAmount(d.buyerPaidMist)} />, seller{' '}
          <MysoAmount amount={formatMistAmount(d.sellerPaidMist)} />
        </Fact>
        {jury && seats != null && jury.state >= JURY_CASE_STATE.SELECTING ? (
          <Fact label="Jurors confirmed">
            {confirmed} of {seats}
            {jury.currentRound > 0 ? ' (appeal round)' : ''}
          </Fact>
        ) : null}
        {round?.tally ? (
          <Fact label="Votes">
            {round.tally.map((n, i) => `${DISPUTE_OUTCOME_LABEL[i] ?? `Option ${i}`}: ${n}`).join(' · ')}
          </Fact>
        ) : null}
        {jury?.state === JURY_CASE_STATE.TALLIED && round?.appealDeadlineMs != null ? (
          <Fact label={now > round.appealDeadlineMs ? 'Appeal window closed' : 'Appeal until'}>
            {formatTime(round.appealDeadlineMs)}
          </Fact>
        ) : null}
        {d.neutralWindowEndsMs != null && d.state === 1 ? (
          <Fact label="Settlement window ends">{formatTime(d.neutralWindowEndsMs)}</Fact>
        ) : null}
        {proposer && d.agreementOutcome != null ? (
          <Fact label="Settlement proposed">
            By the {proposer}: {DISPUTE_OUTCOME_LABEL[d.agreementOutcome]}
          </Fact>
        ) : null}
      </dl>
      {jury && jury.evidence.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-secondary-700 dark:text-secondary-300">Evidence</p>
          <ul className="mt-1 space-y-1 text-xs text-secondary-600 dark:text-secondary-300">
            {jury.evidence.map((item) => (
              <li key={item.index} className="break-all">
                <span className="font-mono">{truncateAddress(item.submitter)}</span>: {item.uri}{' '}
                <span className="font-mono text-secondary-400" title={item.digest}>
                  {item.digest.slice(0, 12)}…
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {rationales.data && rationales.data.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-secondary-700 dark:text-secondary-300">Jurors' reasons</p>
          <ul className="mt-1 space-y-2 text-xs text-secondary-600 dark:text-secondary-300">
            {rationales.data.map((r) => (
              <li key={`${r.round}-${r.agentId}`}>
                <p>
                  <span className="font-mono">{truncateAddress(r.agentId)}</span>
                  {' voted '}
                  <strong>
                    {r.outcome == null ? 'to abstain' : (DISPUTE_OUTCOME_LABEL[r.outcome] ?? `option ${r.outcome}`)}
                  </strong>
                  {r.round > 0 ? ' (appeal round)' : ''}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">
                  {r.rationale ?? 'The juror has not published a written reason yet.'}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.status === TASK_STATUS.DISPUTED && d.neutralWindowEndsMs != null ? (
        <p className="mt-3 text-xs text-secondary-500 dark:text-secondary-400">
          The jury could not decide, so neither side wins by default. You can agree a settlement
          until the window ends; after that the escrow is split 50/50.
        </p>
      ) : null}
    </div>
  );
}

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
  const disputeQuery = useTaskDispute(taskId, query.data?.dispute != null);

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
  const dispute = disputeQuery.data ?? null;
  const available = useMemo(
    () =>
      task && config.data
        ? availableActions(task, role, now, {releaseGraceMs: config.data.releaseGraceMs}, dispute)
        : [],
    [task, role, now, config.data, dispute],
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

  function withDispute(work: (d: NonNullable<typeof dispute>) => Promise<unknown>): Promise<unknown> {
    return dispute ? work(dispute) : Promise.reject(new Error('The dispute is still loading. Try again in a moment.'));
  }

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
    open_dispute: {label: 'Take to a jury', variant: 'secondary', onClick: () => setDialog('dispute')},
    respond_dispute: {label: 'Match the case fee', onClick: () => void run('respond_dispute', () => withDispute((d) => actions.respondDispute(task, d)))},
    dispute_evidence: {label: 'Add evidence', variant: 'secondary', onClick: () => setDialog('evidence')},
    cancel_dispute: {label: 'Withdraw dispute', variant: 'secondary', onClick: () => void run('cancel_dispute', () => withDispute((d) => actions.cancelDispute(task, d)))},
    appeal: {label: 'Appeal verdict', variant: 'danger', onClick: () => setDialog('appeal')},
    execute_verdict: {label: 'Apply the verdict', onClick: () => void run('execute_verdict', () => withDispute((d) => actions.executeVerdict(task, d)))},
    start_neutral: {label: 'Open settlement window', variant: 'secondary', onClick: () => void run('start_neutral', () => withDispute((d) => actions.startNeutralResolution(task, d)))},
    execute_neutral: {label: 'Split the escrow 50/50', onClick: () => void run('execute_neutral', () => actions.executeNeutralResolution(task))},
    propose_settlement: {label: 'Propose a settlement', variant: 'secondary', onClick: () => setDialog('settlement')},
    accept_settlement: {label: 'Accept proposed settlement', onClick: () => void run('accept_settlement', () => actions.acceptDisputeSettlement(task))},
    clear_settlement: {label: (dispute?.agreementProposer === 1 ? 'buyer' : 'seller') === role ? 'Withdraw proposal' : 'Reject proposal', variant: 'secondary', onClick: () => void run('clear_settlement', () => actions.clearDisputeSettlement(task))},
    settle_fees: {label: 'Return case fees', variant: 'secondary', onClick: () => void run('settle_fees', () => withDispute((d) => actions.settleDisputeFees(task, d)))},
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

      {task.dispute ? (
        <DisputeCard task={task} detail={dispute} now={now} />
      ) : null}

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
      <OpenDisputeDialog
        open={dialog === 'dispute'}
        task={task}
        onClose={() => setDialog(null)}
        onDone={() => void query.refetch()}
      />
      {dispute ? (
        <>
          <DisputeEvidenceDialog
            open={dialog === 'evidence'}
            task={task}
            dispute={dispute}
            onClose={() => setDialog(null)}
            onDone={() => void disputeQuery.refetch()}
          />
          <AppealDisputeDialog
            open={dialog === 'appeal'}
            task={task}
            dispute={dispute}
            onClose={() => setDialog(null)}
            onDone={() => void disputeQuery.refetch()}
          />
        </>
      ) : null}
      <DisputeSettlementDialog
        open={dialog === 'settlement'}
        task={task}
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
