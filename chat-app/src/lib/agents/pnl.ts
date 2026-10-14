import {formatMistAmount} from './format';
import type {TaskReceiptInfo} from './social-api';

export interface AgentPnl {
  /** Net paid out to the agent as a task seller, after fees. */
  revenueMist: bigint;
  /** What left the agent's side as a task buyer: the seller's net plus fees. */
  taskSpendMist: bigint;
  /** AI credits the agent has spent. */
  aiSpentMist: bigint;
  pnlMist: bigint;
  /** Settled tasks counted, as seller and as buyer. */
  soldCount: number;
  boughtCount: number;
}

const sameId = (a: string | null | undefined, b: string) =>
  Boolean(a) && a!.replace(/^0x0*/i, '').toLowerCase() === b.replace(/^0x0*/i, '').toLowerCase();

const big = (n: number | null | undefined): bigint => {
  if (n == null || !Number.isFinite(n)) return 0n;
  return BigInt(Math.trunc(n));
};

/**
 * An agent's profit and loss, from receipts of settled tasks plus its AI spend:
 *
 *   PnL = net earned as seller − (net + fees) paid as buyer − AI credits spent
 *
 * Receipts record what actually left escrow, so disputes that split the payment, or paid the
 * seller less than the escrow, are counted at the amount that moved. A task that was refunded in
 * full never produces a receipt and counts for neither side. Gas is not included: derived agent
 * addresses hold no MYSO and the owner's wallet pays it.
 */
export function computeAgentPnl(
  receipts: readonly TaskReceiptInfo[],
  agentObjectId: string,
  aiSpentMist: bigint | null | undefined,
): AgentPnl {
  let revenueMist = 0n;
  let taskSpendMist = 0n;
  let soldCount = 0;
  let boughtCount = 0;
  for (const receipt of receipts) {
    if (sameId(receipt.sellerAgentId, agentObjectId)) {
      revenueMist += big(receipt.netAmountMist);
      soldCount += 1;
    }
    if (sameId(receipt.buyerAgentId, agentObjectId)) {
      taskSpendMist += big(receipt.netAmountMist) + big(receipt.platformFeeMist) + big(receipt.ecosystemFeeMist);
      boughtCount += 1;
    }
  }
  const ai = aiSpentMist ?? 0n;
  return {
    revenueMist,
    taskSpendMist,
    aiSpentMist: ai,
    pnlMist: revenueMist - taskSpendMist - ai,
    soldCount,
    boughtCount,
  };
}

/** `+1.25`, `−0.4`, or `0`, in MySo. */
export function formatSignedMist(mist: bigint): string {
  if (mist === 0n) return '0';
  const amount = formatMistAmount(mist < 0n ? -mist : mist);
  return `${mist < 0n ? '−' : '+'}${amount}`;
}
