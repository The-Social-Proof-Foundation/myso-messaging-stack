import {sha3_256} from '@noble/hashes/sha3.js';
import {bcs} from '@socialproof/myso/bcs';
import {normalizeMySoAddress} from '@socialproof/myso/utils';

import type {AgentTaskInfo, TaskConfigInfo} from './social-api';

/** Task states (`agent_task::STATUS_*`). */
export const TASK_STATUS = {
  OFFERED: 0,
  ACCEPTED: 1,
  DELIVERED: 2,
  SETTLED: 3,
  REFUNDED: 4,
  CANCELLED: 5,
} as const;

export const TASK_STATUS_LABEL: Record<number, string> = {
  0: 'Offered',
  1: 'In progress',
  2: 'Delivered',
  3: 'Settled',
  4: 'Refunded',
  5: 'Cancelled',
};

export const CLOSE_KIND_LABEL: Record<number, string> = {
  0: 'Cancelled by buyer',
  1: 'Declined by seller',
  2: 'Expired unanswered',
};

export const SETTLEMENT_KIND_LABEL: Record<number, string> = {
  1: 'Settled by buyer',
  2: 'Released to seller',
};

export const REFUND_KIND_LABEL: Record<number, string> = {
  0: 'Delivery missed',
  1: 'Refunded by agreement',
};

export function taskStatusLabel(task: Pick<AgentTaskInfo, 'status' | 'closeKind' | 'settlementKind' | 'refundKind'>): string {
  if (task.status === TASK_STATUS.CANCELLED && task.closeKind != null) {
    return CLOSE_KIND_LABEL[task.closeKind] ?? TASK_STATUS_LABEL[task.status]!;
  }
  if (task.status === TASK_STATUS.SETTLED && task.settlementKind != null) {
    return SETTLEMENT_KIND_LABEL[task.settlementKind] ?? TASK_STATUS_LABEL[task.status]!;
  }
  if (task.status === TASK_STATUS.REFUNDED && task.refundKind != null) {
    return REFUND_KIND_LABEL[task.refundKind] ?? TASK_STATUS_LABEL[task.status]!;
  }
  return TASK_STATUS_LABEL[task.status] ?? `Status ${task.status}`;
}

// ---------------------------------------------------------------------------
// Terms digest: the seller approves this exact hash on-chain.
// ---------------------------------------------------------------------------

export interface TermsDigestInput {
  buyerPrincipal: string;
  sellerAgentId: string;
  amountMist: bigint | number;
  /** The 32-byte scope digest. */
  scopeDigest: Uint8Array;
  acceptWindowMs: number;
  deliveryWindowMs: number;
  settleWindowMs: number;
  platformFeeBps: number;
  ecosystemFeeBps: number;
  ecosystemFeeRecipient: string;
  platformId: string | null;
}

/**
 * sha3-256 over the BCS of the fields the seller approves, in the order
 * `agent_task::compute_terms_digest` hashes them.
 */
export function computeTermsDigest(input: TermsDigestInput): Uint8Array {
  const parts: Uint8Array[] = [
    bcs.Address.serialize(input.buyerPrincipal).toBytes(),
    // `ID` serializes as its address.
    bcs.Address.serialize(input.sellerAgentId).toBytes(),
    bcs.u64().serialize(input.amountMist).toBytes(),
    bcs.vector(bcs.u8()).serialize(Array.from(input.scopeDigest)).toBytes(),
    bcs.u64().serialize(input.acceptWindowMs).toBytes(),
    bcs.u64().serialize(input.deliveryWindowMs).toBytes(),
    bcs.u64().serialize(input.settleWindowMs).toBytes(),
    bcs.u64().serialize(input.platformFeeBps).toBytes(),
    bcs.u64().serialize(input.ecosystemFeeBps).toBytes(),
    bcs.Address.serialize(input.ecosystemFeeRecipient).toBytes(),
    bcs.option(bcs.Address).serialize(input.platformId).toBytes(),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return sha3_256(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('Invalid hex string.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Recomputes the digest from the displayed terms and compares it with the one the indexer
 * reports. A mismatch means the data shown to the seller is not what the chain would accept.
 */
export function termsMatchDigest(task: AgentTaskInfo, config: Pick<TaskConfigInfo, 'ecosystemFeeRecipient'>): boolean {
  try {
    const digest = computeTermsDigest({
      buyerPrincipal: task.buyerPrincipal,
      sellerAgentId: task.sellerAgentId,
      amountMist: BigInt(task.amountMist),
      scopeDigest: hexToBytes(task.scopeDigest),
      acceptWindowMs: task.acceptWindowMs,
      deliveryWindowMs: task.deliveryWindowMs,
      settleWindowMs: task.settleWindowMs,
      platformFeeBps: task.platformFeeBps,
      ecosystemFeeBps: task.ecosystemFeeBps,
      ecosystemFeeRecipient: config.ecosystemFeeRecipient,
      platformId: task.platformId,
    });
    return bytesToHex(digest) === task.termsDigest.toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Who can do what, and when
// ---------------------------------------------------------------------------

export type TaskRole = 'buyer' | 'seller' | 'observer';

export type TaskAction =
  | 'accept'
  | 'decline'
  | 'cancel_offer'
  | 'expire_offer'
  | 'deliver'
  | 'refund_missed_delivery'
  | 'settle'
  | 'release'
  | 'propose_refund'
  | 'accept_refund'
  | 'reject_refund'
  | 'withdraw_refund'
  | 'review';

export interface TaskViewer {
  /** The signed-in principal address. */
  principal: string;
  /** Object ids of the viewer's agents, so an agent's task is recognised for its principal. */
  agentIds: readonly string[];
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeMySoAddress(a) === normalizeMySoAddress(b);
}

export function viewerRole(
  task: Pick<AgentTaskInfo, 'buyerPrincipal' | 'buyerAgentId' | 'sellerPrincipal' | 'sellerAgentId'>,
  viewer: TaskViewer,
): TaskRole {
  if (same(task.buyerPrincipal, viewer.principal)) return 'buyer';
  if (same(task.sellerPrincipal, viewer.principal)) return 'seller';
  if (viewer.agentIds.some((id) => same(id, task.buyerAgentId))) return 'buyer';
  if (viewer.agentIds.some((id) => same(id, task.sellerAgentId))) return 'seller';
  return 'observer';
}

/** When anyone may release a delivered task to the seller; `null` before delivery. */
export function releaseAtMs(
  task: Pick<AgentTaskInfo, 'settleDeadlineMs'>,
  config: Pick<TaskConfigInfo, 'releaseGraceMs'>,
): number | null {
  return task.settleDeadlineMs == null ? null : task.settleDeadlineMs + config.releaseGraceMs;
}

/**
 * Every action the viewer's role may take right now. Mirrors the contract's gates so the UI
 * never offers a call that must abort; the chain still enforces each one.
 *
 * There is deliberately no unilateral buyer refund of delivered work: the buyer settles, or
 * proposes a refund that the seller must accept.
 */
export function availableActions(
  task: AgentTaskInfo,
  role: TaskRole,
  nowMs: number,
  config: Pick<TaskConfigInfo, 'releaseGraceMs'>,
): TaskAction[] {
  const actions: TaskAction[] = [];
  const proposer = task.refundProposer === 1 ? 'buyer' : task.refundProposer === 2 ? 'seller' : null;

  switch (task.status) {
    case TASK_STATUS.OFFERED:
      if (nowMs > task.acceptDeadlineMs) {
        actions.push('expire_offer');
      } else if (role === 'seller') {
        actions.push('accept');
      }
      if (role === 'seller') actions.push('decline');
      if (role === 'buyer') actions.push('cancel_offer');
      break;

    case TASK_STATUS.ACCEPTED:
      if (task.deliveryDeadlineMs != null && nowMs > task.deliveryDeadlineMs) {
        actions.push('refund_missed_delivery');
      } else if (role === 'seller') {
        actions.push('deliver');
      }
      break;

    case TASK_STATUS.DELIVERED: {
      if (role === 'buyer') actions.push('settle');
      const releaseAt = releaseAtMs(task, config);
      if (releaseAt != null && nowMs > releaseAt) actions.push('release');
      if (role !== 'observer') {
        if (proposer === null || proposer === role) actions.push('propose_refund');
        if (proposer !== null && proposer !== role) actions.push('accept_refund', 'reject_refund');
        if (proposer === role) actions.push('withdraw_refund');
      }
      break;
    }

    case TASK_STATUS.SETTLED: {
      const open = task.reviewDeadlineMs == null || nowMs <= task.reviewDeadlineMs;
      const reviewed = role === 'buyer' ? task.buyerReviewStars : task.sellerReviewStars;
      if (open && role !== 'observer' && !reviewed) actions.push('review');
      break;
    }

    default:
      break;
  }
  return actions;
}

/** Fee shares the seller will actually pay on `amountMist` with the offer's frozen bps. */
export function feeBreakdown(
  amountMist: number,
  platformFeeBps: number,
  ecosystemFeeBps: number,
  hasPlatform: boolean,
): {platformFeeMist: number; ecosystemFeeMist: number; netMist: number} {
  const platformShare = Math.floor((amountMist * platformFeeBps) / 10_000);
  const ecosystemShare = Math.floor((amountMist * ecosystemFeeBps) / 10_000);
  const platformFeeMist = hasPlatform ? platformShare : 0;
  const ecosystemFeeMist = hasPlatform ? ecosystemShare : platformShare + ecosystemShare;
  return {platformFeeMist, ecosystemFeeMist, netMist: amountMist - platformFeeMist - ecosystemFeeMist};
}

/** A duration for the terms table: whole days when it divides evenly, else hours. */
export function formatTermsWindow(ms: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  if (ms >= day && ms % day === 0) return `${ms / day} day${ms / day === 1 ? '' : 's'}`;
  if (ms >= hour) return `${+(ms / hour).toFixed(1)} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}
