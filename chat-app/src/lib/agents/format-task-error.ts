/**
 * Turns `agent_task` / `memory` aborts into messages a person can act on. Move abort names appear
 * verbatim in the SDK's error text, so classification matches on them (case-insensitively).
 */

export interface TaskErrorInfo {
  kind: string;
  message: string;
  /** Whether trying the same action again can plausibly succeed. */
  retryable: boolean;
}

const RULES: ReadonlyArray<readonly [RegExp, string, string, boolean]> = [
  [/etermsmismatch/, 'terms_changed', 'The offer’s terms do not match what you approved. Reload the task and review it again.', false],
  [/eacceptexpired/, 'accept_expired', 'This offer’s acceptance window has closed.', false],
  [/ewrongstatus/, 'wrong_status', 'This task has already moved on. Reload to see its current state.', false],
  [/etooearly/, 'too_early', 'That step is not available yet. Check the task’s deadlines.', true],
  [/edeliverydeadlinepassed/, 'delivery_late', 'The delivery deadline has passed. The buyer can now be refunded.', false],
  [/enotseller/, 'not_seller', 'Only the seller (or its agent) can do this.', false],
  [/enotbuyer/, 'not_buyer', 'Only the buyer (or the agent that made the offer) can do this.', false],
  [/enotcounterparty/, 'not_counterparty', 'The other party has to respond to a refund proposal; you cannot accept your own.', false],
  [/enotproposer/, 'not_proposer', 'Only the party that proposed the refund can withdraw it.', false],
  [/eproposalpending/, 'proposal_pending', 'The other party has a refund proposal waiting. Accept or reject it first.', false],
  [/enoproposal/, 'no_proposal', 'There is no refund proposal to respond to.', false],
  [/emarketpaused/, 'market_paused', 'The task market is paused and is not taking new offers.', true],
  [/eescrowtoosmall/, 'escrow_small', 'That amount is below the market’s minimum escrow.', false],
  [/einvalidwindow/, 'invalid_window', 'One of the time windows is outside the market’s allowed range.', false],
  [/einvaliddigest/, 'invalid_digest', 'The scope or deliverable digest must be exactly 32 bytes.', false],
  [/etitletoolong|euritoolong/, 'too_long', 'The title or link is longer than the market allows.', false],
  [/einsufficientpayment/, 'insufficient_payment', 'Not enough MySo to fund this escrow.', false],
  [/etaskselfdealing/, 'self_dealing', 'You cannot send a task to your own agent.', false],
  [/ealreadyreviewed/, 'already_reviewed', 'You have already reviewed this task.', false],
  [/ereviewwindowclosed/, 'review_closed', 'The review window for this task has closed.', false],
  [/einvalidstars/, 'invalid_stars', 'Pick a rating from 1 to 5 stars.', false],
  [/ewrongreviewtarget/, 'wrong_review_target', 'That review does not match who bought this task.', false],
  [/esubagentmissingcap/, 'missing_capability', 'Enable “Trade tasks” for this agent first.', false],
  [/esubagentspendexceeded/, 'spend_cap', 'This amount is above the agent’s per-action spending limit.', false],
  [/esubagentapprovalrequired/, 'approval_required', 'This agent needs the owner’s approval for trading tasks.', false],
  [/esubagentnotactive|esubagentexpired|esubagentinactiveancestor/, 'agent_inactive', 'That agent is deactivated or expired and cannot take on this task.', false],
  [/ewrongplatform/, 'wrong_platform', 'This task is bound to a different platform.', false],
  [
    /eineligible/,
    'ineligible',
    'This agent cannot join the jury yet. Turn on “Serve on juries” and keep the agent active, or it needs more reputation, confidence, settled tasks, or time on the network.',
    false,
  ],
];

export function classifyTaskError(error: unknown): TaskErrorInfo {
  const text = (
    error instanceof Error
      ? `${error.message} ${(error as Error & {cause?: string}).cause ?? ''}`
      : String(error ?? '')
  ).toLowerCase();

  for (const [pattern, kind, message, retryable] of RULES) {
    if (pattern.test(text)) return {kind, message, retryable};
  }
  // The chain reports the numeric code, not the Move constant name.
  if (/jury::join_roster/.test(text) && /abort code:\s*9\b/.test(text)) {
    const rule = RULES.find((entry) => entry[1] === 'ineligible')!;
    return {kind: rule[1], message: rule[2], retryable: rule[3]};
  }
  if (/insufficient.*(gas|balance)|gas/.test(text)) {
    return {kind: 'gas', message: 'Not enough MySo to pay network fees.', retryable: false};
  }
  return {
    kind: 'unknown',
    message: error instanceof Error ? error.message : 'The transaction failed.',
    retryable: true,
  };
}
