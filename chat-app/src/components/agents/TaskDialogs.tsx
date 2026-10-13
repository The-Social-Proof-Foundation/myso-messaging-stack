import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {sha256} from '@noble/hashes/sha2.js';

import {classifyTaskError} from '../../lib/agents/format-task-error';
import {formatMistAmount} from '../../lib/agents/format';
import type {
  AgentTaskInfo,
  SubAgentRow,
  TaskConfigInfo,
  TaskDisputeDetailInfo,
} from '../../lib/agents/social-api';
import {
  APPEAL_FEE_MULTIPLIER,
  DISPUTE_OUTCOME_LABEL,
  disputeFeeMist,
  feeBreakdown,
  formatTermsWindow,
  termsMatchDigest,
} from '../../lib/agents/tasks';
import {useTaskActions, type ReviewSide} from '../../hooks/agents/useTaskActions';
import {Button} from '../Button';
import {Dialog, dialogFieldClass} from '../Dialog';
import {ErrorNotice} from './ErrorNotice';
import {MysoAmount} from './MysoAmount';
import {StarRatingInput} from './StarRatingInput';

interface BaseDialogProps {
  open: boolean;
  task: AgentTaskInfo;
  onClose: () => void;
  onDone?: () => void;
}

function useRunner(onDone: (() => void) | undefined, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone?.();
      onClose();
    } catch (err) {
      setError(classifyTaskError(err).message);
    } finally {
      setBusy(false);
    }
  }
  return {busy, error, run, clear: () => setError(null)};
}

function Row({label, children}: Readonly<{label: string; children: ReactNode}>) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="text-secondary-500 dark:text-secondary-400">{label}</dt>
      <dd className="text-right text-secondary-900 dark:text-secondary-100">{children}</dd>
    </div>
  );
}

/**
 * The seller's explicit approval. It shows every term the contract hashes and approves that
 * exact digest on-chain, so scope, payment, windows and fees cannot differ from what was shown.
 */
export function AcceptTaskDialog({
  open,
  task,
  config,
  onClose,
  onDone,
}: Readonly<BaseDialogProps & {config: TaskConfigInfo | null | undefined}>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);

  // Recompute the digest from what is displayed: a mismatch means the indexer is not showing
  // terms the chain would accept, so accepting is refused rather than approved blind.
  const verified = useMemo(
    () => (config ? termsMatchDigest(task, config) : null),
    [task, config],
  );
  const fees = feeBreakdown(
    task.amountMist,
    task.platformFeeBps,
    task.ecosystemFeeBps,
    task.platformId != null,
  );
  const expired = Date.now() > task.acceptDeadlineMs;

  return (
    <Dialog
      open={open}
      title="Review offer"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void run(() => actions.declineTask(task))}
          >
            Decline
          </Button>
          <Button
            disabled={busy || expired || verified === false}
            onClick={() => void run(() => actions.acceptTask(task))}
          >
            {busy ? 'Working…' : 'Accept terms'}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm font-medium text-secondary-900 dark:text-secondary-100">{task.title}</p>
      <dl className="divide-y divide-secondary-100 dark:divide-secondary-700">
        <Row label="Payment">
          <MysoAmount amount={formatMistAmount(task.amountMist)} />
        </Row>
        <Row label="You receive">
          <MysoAmount amount={formatMistAmount(fees.netMist)} />
        </Row>
        <Row label="Fees">
          {((task.platformFeeBps + task.ecosystemFeeBps) / 100).toFixed(2)}%
        </Row>
        <Row label="Deliver within">{formatTermsWindow(task.deliveryWindowMs)} of accepting</Row>
        <Row label="Buyer settles within">{formatTermsWindow(task.settleWindowMs)} of delivery</Row>
        <Row label="Offer expires">{new Date(task.acceptDeadlineMs).toLocaleString()}</Row>
        <Row label="Scope hash">
          <span className="font-mono text-xs" title={task.scopeDigest}>
            {task.scopeDigest.slice(0, 16)}…
          </span>
        </Row>
      </dl>
      <p className="mt-3 text-xs text-secondary-500 dark:text-secondary-400">
        The buyer holds the scope text; only its hash is on-chain. Accepting approves the digest of
        every term above. If the buyer does not settle in time you are paid automatically after a
        grace period, and a refund after delivery needs your agreement.
      </p>
      {verified === false ? (
        <ErrorNotice className="mt-3">
          The terms shown do not hash to the offer’s on-chain digest, so this offer cannot be accepted
          from here. Reload, and do not accept it elsewhere.
        </ErrorNotice>
      ) : null}
      {expired ? <ErrorNotice className="mt-3">This offer’s acceptance window has closed.</ErrorNotice> : null}
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** Pays the seller. A rating can ride in the same transaction. */
export function SettleTaskDialog({open, task, onClose, onDone}: Readonly<BaseDialogProps>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const [stars, setStars] = useState(0);
  const fees = feeBreakdown(task.amountMist, task.platformFeeBps, task.ecosystemFeeBps, task.platformId != null);

  return (
    <Dialog
      open={open}
      title="Settle task"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run(() => actions.settleTask(task, {stars: stars || undefined}))}
          >
            {busy ? 'Paying…' : 'Pay seller'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary-700 dark:text-secondary-200">
        Pay <MysoAmount amount={formatMistAmount(fees.netMist)} /> to the seller for “{task.title}”.
        This is final: delivered work cannot be refunded without the seller’s agreement.
      </p>
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Rate the seller <span className="font-normal text-secondary-400">(optional, once)</span>
        </p>
        <StarRatingInput value={stars} onChange={setStars} disabled={busy} label="Rate the seller" />
      </div>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** One review per direction on a settled task. */
export function ReviewTaskDialog({
  open,
  task,
  side,
  onClose,
  onDone,
}: Readonly<BaseDialogProps & {side: ReviewSide}>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const [stars, setStars] = useState(0);
  const who = side === 'buyer' ? 'the seller' : task.buyerAgentId ? 'the buyer agent' : 'the buyer';

  return (
    <Dialog
      open={open}
      title={`Rate ${who}`}
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy || stars === 0} onClick={() => void run(() => actions.reviewTask(task, side, stars))}>
            {busy ? 'Submitting…' : 'Submit rating'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-secondary-700 dark:text-secondary-200">
        How did working on “{task.title}” go? Ratings are public, final, and weighted by the task’s
        value and your track record, so repeated ratings of the same counterparty count for less.
      </p>
      <StarRatingInput value={stars} onChange={setStars} disabled={busy} label={`Rate ${who}`} />
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** The seller agent records the deliverable. Only the agent's own key can sign this. */
export function DeliverTaskDialog({
  open,
  task,
  agent,
  maxUriBytes,
  onClose,
  onDone,
}: Readonly<BaseDialogProps & {agent: SubAgentRow | null; maxUriBytes: number}>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const [uri, setUri] = useState('');
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!open) {
      setUri('');
      setContent('');
    }
  }, [open]);

  const canSubmit = Boolean(agent) && uri.trim().length > 0 && content.length > 0;

  return (
    <Dialog
      open={open}
      title="Deliver work"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || !canSubmit}
            onClick={() =>
              void run(() =>
                actions.deliverTask(task, agent!, {
                  digest: sha256(new TextEncoder().encode(content)),
                  uri: uri.trim(),
                }),
              )
            }
          >
            {busy ? 'Signing…' : 'Mark delivered'}
          </Button>
        </>
      }
    >
      {!agent ? (
        <ErrorNotice>The seller agent for this task is not one of your agents, so only it can deliver.</ErrorNotice>
      ) : null}
      <label className="mt-2 block text-sm font-medium text-secondary-700 dark:text-secondary-300">
        Where to find the work
        <input
          value={uri}
          onChange={(event) => setUri(event.target.value)}
          maxLength={maxUriBytes}
          placeholder="https:// or walrus:// link"
          disabled={busy}
          className={`mt-1 ${dialogFieldClass}`}
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-secondary-700 dark:text-secondary-300">
        Deliverable content
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          placeholder="Paste the delivered text. Only its sha256 is stored on-chain, so the buyer can verify what they received."
          disabled={busy}
          className={`mt-1 ${dialogFieldClass}`}
        />
      </label>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** A party takes delivered work to a jury. The fee is the only cost; the loser bears it. */
export function OpenDisputeDialog({open, task, onClose, onDone}: Readonly<BaseDialogProps>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const fee = disputeFeeMist(task.amountMist);

  return (
    <Dialog
      open={open}
      title="Take this to a jury"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run(() => actions.openDispute(task))}>
            {busy ? 'Opening…' : 'Open dispute and pay fee'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary-700 dark:text-secondary-200">
        Three independent AI jurors will review the evidence for “{task.title}” and decide: pay the
        seller, refund the buyer, or split 50/50. Their verdict is binding, and the losing side can
        appeal once to a larger jury.
      </p>
      <dl className="mt-3 divide-y divide-secondary-100 dark:divide-secondary-700">
        <Row label="Case fee (you pay now)">
          <MysoAmount amount={formatMistAmount(fee)} />
        </Row>
        <Row label="Escrow frozen">
          <MysoAmount amount={formatMistAmount(task.amountMist)} />
        </Row>
      </dl>
      <p className="mt-3 text-xs text-secondary-500 dark:text-secondary-400">
        The other side may match the fee before the jury is drawn. The side that loses pays the
        fee; the winner’s fee comes back. If the jury cannot decide, neither side wins by default:
        you get a window to agree a settlement, then the escrow is split 50/50.
      </p>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** Evidence is a link to the material plus the sha256 of its content, so the jury can verify it. */
export function DisputeEvidenceDialog({
  open,
  task,
  dispute,
  onClose,
  onDone,
}: Readonly<BaseDialogProps & {dispute: TaskDisputeDetailInfo}>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const [uri, setUri] = useState('');
  const [content, setContent] = useState('');
  const canSubmit = uri.trim().length > 0 && content.length > 0;

  return (
    <Dialog
      open={open}
      title="Add evidence"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || !canSubmit}
            onClick={() =>
              void run(() =>
                actions.submitDisputeEvidence(task, dispute, {
                  digest: sha256(new TextEncoder().encode(content)),
                  uri: uri.trim(),
                }),
              )
            }
          >
            {busy ? 'Signing…' : 'Submit evidence'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary-700 dark:text-secondary-200">
        Evidence is public. Only the link and the sha256 of the content go on-chain, so jurors can
        check that what they read is what you submitted.
      </p>
      <label className="mt-3 block text-sm font-medium text-secondary-700 dark:text-secondary-300">
        Link to the evidence
        <input
          value={uri}
          onChange={(event) => setUri(event.target.value)}
          placeholder="https://… or walrus://…"
          disabled={busy}
          className={`mt-1 ${dialogFieldClass}`}
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-secondary-700 dark:text-secondary-300">
        Evidence content
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          placeholder="Paste the exact content at that link."
          disabled={busy}
          className={`mt-1 ${dialogFieldClass}`}
        />
      </label>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** The losing side asks a larger jury to decide again. The earlier verdict stands if that jury fails. */
export function AppealDisputeDialog({
  open,
  task,
  dispute,
  onClose,
  onDone,
}: Readonly<BaseDialogProps & {dispute: TaskDisputeDetailInfo}>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const fee = dispute.feeEachMist * APPEAL_FEE_MULTIPLIER;

  return (
    <Dialog
      open={open}
      title="Appeal the verdict"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run(() => actions.appealDispute(task, dispute))}>
            {busy ? 'Appealing…' : 'Appeal and pay fee'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary-700 dark:text-secondary-200">
        A new jury of five, none of whom judged the first round, will decide. This is the last
        appeal. If that jury cannot decide, the first verdict stands.
      </p>
      <dl className="mt-3 divide-y divide-secondary-100 dark:divide-secondary-700">
        <Row label="Appeal fee">
          <MysoAmount amount={formatMistAmount(fee)} />
        </Row>
      </dl>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}

/** Either party proposes how to settle; the other must accept before it takes effect. */
export function DisputeSettlementDialog({open, task, onClose, onDone}: Readonly<BaseDialogProps>) {
  const actions = useTaskActions();
  const {busy, error, run} = useRunner(onDone, onClose);
  const [outcome, setOutcome] = useState(2);

  return (
    <Dialog
      open={open}
      title="Propose a settlement"
      onClose={() => !busy && onClose()}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run(() => actions.proposeDisputeSettlement(task, outcome))}
          >
            {busy ? 'Signing…' : 'Propose'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-secondary-700 dark:text-secondary-200">
        If the other side accepts, the escrow is paid out this way immediately and the jury case
        closes. Case fees are returned in proportion to what each side paid.
      </p>
      <label className="mt-3 block text-sm font-medium text-secondary-700 dark:text-secondary-300">
        Outcome
        <select
          value={outcome}
          onChange={(event) => setOutcome(Number(event.target.value))}
          disabled={busy}
          className={`mt-1 ${dialogFieldClass}`}
        >
          {Object.entries(DISPUTE_OUTCOME_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error ? <ErrorNotice className="mt-3">{error}</ErrorNotice> : null}
    </Dialog>
  );
}
