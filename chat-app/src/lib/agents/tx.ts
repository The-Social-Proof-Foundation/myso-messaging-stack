import { Transaction, coinWithBalance } from '@socialproof/myso/transactions';
import { MYSO_CLOCK_OBJECT_ID } from '@socialproof/myso/utils';

import type { AgentChainIds } from './chain-ids';

/**
 * Transaction builders for the agents workspace. Argument order mirrors
 * `social_contracts::memory` and `social_contracts::ai_credit` exactly; each builder
 * appends one Move call to `tx` (a new transaction by default) and returns it so
 * callers can execute through `signAndExecuteTransactionAndWait` (sponsored gas).
 */

/** `memory::CLASS_DELEGATED_AI` */
export const IDENTITY_CLASS_DELEGATED_AI = 1;
/** `memory::REGISTER_SCOPE_BOTH` */
export const REGISTER_SCOPE_BOTH = 3;
/** `memory::REGISTER_CHILD`. `0` is not a relation and aborts as `EInvalidRegisterRelation`. */
export const REGISTER_RELATION_CHILD = 1;

type Ids = Pick<AgentChainIds, 'socialPackageId'>;
type MemoryIds = Pick<AgentChainIds, 'socialPackageId' | 'memoryConfigId'>;
type AiCreditIds = Pick<AgentChainIds, 'socialPackageId' | 'aiCreditConfigId'>;
type PlatformIds = Pick<AgentChainIds, 'socialPackageId' | 'platformRegistryId' | 'blockListRegistryId'>;

function memoryTarget(ids: Ids, fn: string): `${string}::${string}::${string}` {
  return `${ids.socialPackageId}::memory::${fn}`;
}

function aiCreditTarget(ids: Ids, fn: string): `${string}::${string}::${string}` {
  return `${ids.socialPackageId}::ai_credit::${fn}`;
}

function platformTarget(ids: Ids, fn: string): `${string}::${string}::${string}` {
  return `${ids.socialPackageId}::platform::${fn}`;
}

function optionalU64(tx: Transaction, value: bigint | number | null | undefined) {
  return tx.pure.option('u64', value ?? null);
}

// ============================================================
// Organizations
// ============================================================

export interface CreateOrganizationArgs {
  accountId: string;
  orgType: number;
  name: string | null;
  description: string | null;
}

export function createAgenticOrganizationTx(
  ids: MemoryIds,
  args: CreateOrganizationArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'create_agentic_organization'),
    arguments: [
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.pure.u8(args.orgType),
      tx.pure.option('string', args.name || null),
      tx.pure.option('string', args.description || null),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export interface UpdateOrganizationLabelArgs {
  accountId: string;
  organizationId: string;
  name: string | null;
  description: string | null;
}

export function updateAgenticOrganizationLabelTx(
  ids: MemoryIds,
  args: UpdateOrganizationLabelArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'update_agentic_organization_metadata'),
    arguments: [
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.pure.option('string', args.name || null),
      tx.pure.option('string', args.description || null),
    ],
  });
  return tx;
}

export function deactivateAgenticOrganizationTx(
  ids: Ids,
  args: { accountId: string; organizationId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'deactivate_agentic_organization'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Sub-agents
// ============================================================

export interface AgentPolicyArgs {
  capabilities: number;
  identityClass?: number;
  roleTags?: string;
  /** Caps this agent may hand down to children it registers. */
  delegatableCaps?: number;
  /** Absolute expiry (ms since epoch), or null for none. */
  expiresAtMs?: number | null;
  approvalRequiredCaps?: number;
  maxActionSpend?: string | null;
  platformScope?: string | null;
  registerScope?: number;
}

export interface RegisterAgentArgs extends AgentPolicyArgs {
  accountId: string;
  publicKey: Uint8Array;
  derivedAddress: string;
  label: string;
}

function pushAgentPolicy(tx: Transaction, args: AgentPolicyArgs) {
  return [
    tx.pure.u8(args.identityClass ?? IDENTITY_CLASS_DELEGATED_AI),
    tx.pure.u64(args.roleTags ?? '0'),
    tx.pure.u64(args.capabilities),
    tx.pure.u64(args.delegatableCaps ?? 0),
    tx.pure.u8(args.registerScope ?? REGISTER_SCOPE_BOTH),
    tx.pure.u64(args.approvalRequiredCaps ?? 0),
    tx.pure.option('u64', args.maxActionSpend ?? null),
    tx.pure.option('address', args.platformScope ?? null),
    optionalU64(tx, args.expiresAtMs),
  ];
}

/** Root agent in an organization; signed by the human owner. */
export function registerSubAgentTx(
  ids: MemoryIds,
  args: RegisterAgentArgs & { organizationId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'register_sub_agent'),
    arguments: [
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.pure.vector('u8', Array.from(args.publicKey)),
      tx.pure.address(args.derivedAddress),
      tx.pure.string(args.label),
      ...pushAgentPolicy(tx, args),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Child agent; signed by the parent agent's derived key (needs `CAP_AGENT_REGISTER`). */
export function registerSubAgentDelegatedTx(
  ids: MemoryIds,
  args: RegisterAgentArgs & { parentAgentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'register_sub_agent_delegated'),
    arguments: [
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.object(args.parentAgentObjectId),
      tx.pure.vector('u8', Array.from(args.publicKey)),
      tx.pure.address(args.derivedAddress),
      tx.pure.string(args.label),
      ...pushAgentPolicy(tx, args),
      tx.pure.u8(REGISTER_RELATION_CHILD),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function updateSubAgentTx(
  ids: Ids,
  args: AgentPolicyArgs & { accountId: string; agentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'update_sub_agent'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.agentObjectId),
      ...pushAgentPolicy(tx, args),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function updateSubAgentLabelTx(
  ids: MemoryIds,
  args: { accountId: string; agentObjectId: string; label: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'update_sub_agent_label'),
    arguments: [
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.object(args.agentObjectId),
      tx.pure.string(args.label),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function deactivateSubAgentTx(
  ids: Ids,
  args: { accountId: string; agentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'deactivate_sub_agent'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.agentObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function revokeSubAgentTx(
  ids: Ids,
  args: { accountId: string; agentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'revoke_sub_agent'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.agentObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function ensureAgentMemoryVaultTx(
  ids: Ids,
  args: { accountId: string; agentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'ensure_agent_memory_vault'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.agentObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Organization memory sharing, roles, invitations
// ============================================================

interface OrgGroupArgs {
  accountId: string;
  organizationId: string;
  /** `PermissionedGroup<MemorySharePackage>` id from the social server's organization row. */
  orgMemoryGroupId: string;
}

export function ensureOrgMemoryGroupTx(
  ids: Ids,
  args: { accountId: string; organizationId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'ensure_org_memory_group'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

function orgPermissionTx(
  fn: 'grant_org_memory_permission' | 'revoke_org_memory_permission',
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; permissionsMask: number },
  tx: Transaction,
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, fn),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.object(args.orgMemoryGroupId),
      tx.pure.address(args.memberAddress),
      tx.pure.u64(args.permissionsMask),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function grantOrgMemoryPermissionTx(
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; permissionsMask: number },
  tx = new Transaction(),
): Transaction {
  return orgPermissionTx('grant_org_memory_permission', ids, args, tx);
}

export function revokeOrgMemoryPermissionTx(
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; permissionsMask: number },
  tx = new Transaction(),
): Transaction {
  return orgPermissionTx('revoke_org_memory_permission', ids, args, tx);
}

function orgRoleTx(
  fn: 'assign_org_role' | 'revoke_org_role',
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; roleName: string },
  tx: Transaction,
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, fn),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.object(args.orgMemoryGroupId),
      tx.pure.address(args.memberAddress),
      tx.pure.string(args.roleName),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function assignOrgRoleTx(
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; roleName: string },
  tx = new Transaction(),
): Transaction {
  return orgRoleTx('assign_org_role', ids, args, tx);
}

export function revokeOrgRoleTx(
  ids: Ids,
  args: OrgGroupArgs & { memberAddress: string; roleName: string },
  tx = new Transaction(),
): Transaction {
  return orgRoleTx('revoke_org_role', ids, args, tx);
}

export interface CreateOrgInvitationArgs extends OrgGroupArgs {
  inviteeAddress: string;
  roleName: string | null;
  permissionsMask: number;
  expiresAtMs: number | null;
}

export function createOrgInvitationTx(
  ids: Ids,
  args: CreateOrgInvitationArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: memoryTarget(ids, 'create_org_invitation'),
    arguments: [
      tx.object(args.accountId),
      tx.object(args.organizationId),
      tx.object(args.orgMemoryGroupId),
      tx.pure.address(args.inviteeAddress),
      tx.pure.option('string', args.roleName || null),
      tx.pure.u64(args.permissionsMask),
      optionalU64(tx, args.expiresAtMs),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// AI credits
// ============================================================

/** `ai_credit::deposit`; the payment coin is split from gas (depositors pay their own gas). */
export function depositAiCreditTx(
  ids: AiCreditIds,
  args: { balanceId: string; amountMist: bigint },
  tx = new Transaction(),
): Transaction {
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(args.amountMist)]);
  tx.moveCall({
    target: aiCreditTarget(ids, 'deposit'),
    arguments: [tx.object(ids.aiCreditConfigId), tx.object(args.balanceId), payment!],
  });
  return tx;
}

export function withdrawAiCreditTx(
  ids: AiCreditIds,
  args: { balanceId: string; amountMist: bigint },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'withdraw'),
    arguments: [
      tx.object(ids.aiCreditConfigId),
      tx.object(args.balanceId),
      tx.pure.u64(args.amountMist),
    ],
  });
  return tx;
}

export function setAiCreditAccountCapsTx(
  ids: AiCreditIds,
  args: { balanceId: string; dailyCapMist: bigint | null; monthlyCapMist: bigint | null },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'set_account_caps'),
    arguments: [
      tx.object(ids.aiCreditConfigId),
      tx.object(args.balanceId),
      optionalU64(tx, args.dailyCapMist),
      optionalU64(tx, args.monthlyCapMist),
    ],
  });
  return tx;
}

export interface AgentBudgetArgs {
  balanceId: string;
  agentObjectId: string;
  budgetMist: bigint | null;
  dailyCapMist: bigint | null;
  monthlyCapMist: bigint | null;
  requireApprovalAboveMist: bigint | null;
}

export function setAgentBudgetTx(
  ids: AiCreditIds,
  args: AgentBudgetArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'set_agent_budget'),
    arguments: [
      tx.object(ids.aiCreditConfigId),
      tx.object(args.balanceId),
      tx.object(args.agentObjectId),
      optionalU64(tx, args.budgetMist),
      optionalU64(tx, args.dailyCapMist),
      optionalU64(tx, args.monthlyCapMist),
      optionalU64(tx, args.requireApprovalAboveMist),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function pauseAiCreditTx(
  ids: AiCreditIds,
  args: { balanceId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'pause_balance'),
    arguments: [tx.object(ids.aiCreditConfigId), tx.object(args.balanceId)],
  });
  return tx;
}

export function reactivateAiCreditTx(
  ids: AiCreditIds,
  args: { balanceId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'reactivate_balance'),
    arguments: [tx.object(ids.aiCreditConfigId), tx.object(args.balanceId)],
  });
  return tx;
}

export function approveAgentSpendTx(
  ids: AiCreditIds,
  args: {
    balanceId: string;
    agentObjectId: string;
    maxAmountMist: bigint;
    expiresAtMs: number;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'approve_agent_spend'),
    arguments: [
      tx.object(ids.aiCreditConfigId),
      tx.object(args.balanceId),
      tx.pure.id(args.agentObjectId),
      tx.pure.u64(args.maxAmountMist),
      tx.pure.u64(args.expiresAtMs),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function revokeAgentSpendApprovalTx(
  ids: AiCreditIds,
  args: { balanceId: string; agentObjectId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: aiCreditTarget(ids, 'revoke_agent_spend_approval'),
    arguments: [
      tx.object(ids.aiCreditConfigId),
      tx.object(args.balanceId),
      tx.pure.id(args.agentObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Platforms
// ============================================================

/**
 * `platform::join_platform` — registers the signing wallet as a member of `platformId`.
 *
 * Required before an agent can create a messaging group: the Move
 * `resolve_messaging_actor` asserts `platform::has_joined_platform(platform, principal)`,
 * so an agent group cannot be created until the human owner has joined an approved
 * platform. Idempotent on chain via `EAlreadyJoined`.
 */
export function joinPlatformTx(
  ids: PlatformIds,
  args: { platformId: string },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: platformTarget(ids, 'join_platform'),
    arguments: [
      tx.object(ids.platformRegistryId),
      tx.object(ids.blockListRegistryId),
      tx.object(args.platformId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Task market (`social_contracts::agent_task`)
//
// Argument order mirrors the Move entrypoints exactly. Escrow is paid from an explicit MYSO
// coin (never the gas coin, which belongs to the sponsor under sponsored gas).
// ============================================================

type TaskIds = Pick<AgentChainIds, 'socialPackageId' | 'memoryConfigId' | 'taskConfigId'>;

function taskTarget(ids: Ids, fn: string): `${string}::${string}::${string}` {
  return `${ids.socialPackageId}::agent_task::${fn}`;
}

export interface CreateTaskArgs {
  buyerAccountId: string;
  sellerAccountId: string;
  sellerAgentId: string;
  amountMist: bigint | number;
  /** Exactly 32 bytes (sha256 of the scope document). */
  scopeDigest: Uint8Array;
  title: string;
  acceptWindowMs: number;
  deliveryWindowMs: number;
  settleWindowMs: number;
  roomGroupId: string | null;
  /** Platform whose treasury receives the platform fee; `null` folds it into the ecosystem fee. */
  platformId: string | null;
  /** MYSO coin that pays the escrow. Omit to split exactly `amountMist` from the sender's coins. */
  paymentCoinId?: string;
  /**
   * Owner of a coin created for this call. `create_task` only borrows the coin, so a freshly
   * split coin has to be transferred back or the transaction is rejected as unused.
   */
  returnCoinTo?: string;
}

export function createTaskTx(
  ids: TaskIds,
  args: CreateTaskArgs,
  tx = new Transaction(),
): Transaction {
  const payment = args.paymentCoinId
    ? tx.object(args.paymentCoinId)
    : tx.add(coinWithBalance({balance: BigInt(args.amountMist), useGasCoin: false}));
  tx.moveCall({
    target: taskTarget(ids, 'create_task'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      payment,
      tx.pure.u64(args.amountMist),
      tx.pure.vector('u8', Array.from(args.scopeDigest)),
      tx.pure.string(args.title),
      tx.pure.u64(args.acceptWindowMs),
      tx.pure.u64(args.deliveryWindowMs),
      tx.pure.u64(args.settleWindowMs),
      // The room binding is an object id, not an address.
      tx.pure.option('id', args.roomGroupId),
      tx.pure.option('address', args.platformId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  if (!args.paymentCoinId) {
    if (!args.returnCoinTo) throw new Error('The payment coin has nowhere to return to.');
    tx.transferObjects([payment], tx.pure.address(args.returnCoinTo));
  }
  return tx;
}

export interface TaskSellerArgs {
  taskId: string;
  sellerAccountId: string;
  sellerAgentId: string;
}

export function acceptTaskTx(
  ids: TaskIds,
  args: TaskSellerArgs & {termsDigest: Uint8Array},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'accept_task'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      tx.pure.vector('u8', Array.from(args.termsDigest)),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function declineTaskTx(
  ids: TaskIds,
  args: TaskSellerArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'decline_task'),
    arguments: [
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function cancelOfferTx(
  ids: TaskIds,
  args: {taskId: string; buyerAccountId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'cancel_offer'),
    arguments: [
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Permissionless: returns an unanswered offer's escrow once the accept deadline passed. */
export function expireOfferTx(
  ids: Ids,
  args: {taskId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'expire_offer'),
    arguments: [tx.object(args.taskId), tx.object(MYSO_CLOCK_OBJECT_ID)],
  });
  return tx;
}

export function markTaskDeliveredTx(
  ids: TaskIds,
  args: {taskId: string; sellerAgentId: string; digest: Uint8Array; uri: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'mark_delivered'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.sellerAgentId),
      tx.pure.vector('u8', Array.from(args.digest)),
      tx.pure.string(args.uri),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export interface SettleTaskArgs {
  taskId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  /** Any `Platform` object when the task has no platform; the contract ignores it then. */
  platformObjectId: string;
}

export function settleTaskTx(
  ids: TaskIds,
  args: SettleTaskArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'settle_task'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.platformObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Permissionless once `settle_deadline + release_grace` has passed on a delivered task. */
export function releaseTaskTx(
  ids: TaskIds,
  args: SettleTaskArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'release_task'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.platformObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Permissionless refund of an accepted task whose seller missed the delivery deadline. */
export function refundTaskTx(
  ids: Ids,
  args: {taskId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'refund_task'),
    arguments: [tx.object(args.taskId), tx.object(MYSO_CLOCK_OBJECT_ID)],
  });
  return tx;
}

export interface RefundProposalArgs {
  taskId: string;
  buyerAccountId: string;
  sellerAgentId: string;
}

function refundProposalTx(
  fn: 'propose_refund' | 'accept_refund' | 'reject_refund' | 'withdraw_refund',
  ids: TaskIds,
  args: RefundProposalArgs,
  tx: Transaction,
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, fn),
    arguments: [
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export const proposeRefundTx = (ids: TaskIds, args: RefundProposalArgs, tx = new Transaction()) =>
  refundProposalTx('propose_refund', ids, args, tx);
export const acceptRefundTx = (ids: TaskIds, args: RefundProposalArgs, tx = new Transaction()) =>
  refundProposalTx('accept_refund', ids, args, tx);
export const rejectRefundTx = (ids: TaskIds, args: RefundProposalArgs, tx = new Transaction()) =>
  refundProposalTx('reject_refund', ids, args, tx);
export const withdrawRefundTx = (ids: TaskIds, args: RefundProposalArgs, tx = new Transaction()) =>
  refundProposalTx('withdraw_refund', ids, args, tx);

/** The buyer rates the seller agent. Can be appended to the settle transaction. */
export function reviewSellerTx(
  ids: TaskIds,
  args: {
    taskId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    sellerAgentId: string;
    stars: number;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'review_seller'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      tx.pure.u8(args.stars),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** The seller rates a buyer **agent**. */
export function reviewBuyerAgentTx(
  ids: TaskIds,
  args: {
    taskId: string;
    buyerAccountId: string;
    buyerAgentId: string;
    sellerAgentId: string;
    stars: number;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'review_buyer_agent'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.buyerAccountId),
      tx.object(args.buyerAgentId),
      tx.object(args.sellerAgentId),
      tx.pure.u8(args.stars),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** The seller rates a principal that bought directly (no buyer agent). */
export function reviewBuyerPrincipalTx(
  ids: TaskIds,
  args: {taskId: string; buyerAccountId: string; sellerAgentId: string; stars: number},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'review_buyer_principal'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.pure.u8(args.stars),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Task disputes (`agent_task` entry points that use `social_contracts::jury`)
//
// A party resolves to a role from the sender: the buyer passes its account and the seller its
// agent. Case fees are paid from an explicit MYSO coin; the contract returns any change.
// ============================================================

type DisputeIds = TaskIds & Pick<AgentChainIds, 'juryConfigId' | 'jurorRosterId'>;

export interface DisputePartyArgs {
  taskId: string;
  caseId: string;
  buyerAccountId: string;
  sellerAgentId: string;
}

export function openDisputeTx(
  ids: DisputeIds,
  args: {
    taskId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    sellerAgentId: string;
    feeMist: bigint | number;
  },
  tx = new Transaction(),
): Transaction {
  const fee = tx.add(coinWithBalance({balance: BigInt(args.feeMist), useGasCoin: false}));
  tx.moveCall({
    target: taskTarget(ids, 'open_dispute'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(ids.juryConfigId),
      tx.object(ids.jurorRosterId),
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      fee,
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

function feePaidDisputeTx(
  fn: 'respond_dispute' | 'appeal_dispute',
  ids: DisputeIds,
  args: DisputePartyArgs & {feeMist: bigint | number},
  tx: Transaction,
): Transaction {
  const fee = tx.add(coinWithBalance({balance: BigInt(args.feeMist), useGasCoin: false}));
  tx.moveCall({
    target: taskTarget(ids, fn),
    arguments: [
      tx.object(args.taskId),
      tx.object(args.caseId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      fee,
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export const respondDisputeTx = (
  ids: DisputeIds,
  args: DisputePartyArgs & {feeMist: bigint | number},
  tx = new Transaction(),
) => feePaidDisputeTx('respond_dispute', ids, args, tx);
export const appealDisputeTx = (
  ids: DisputeIds,
  args: DisputePartyArgs & {feeMist: bigint | number},
  tx = new Transaction(),
) => feePaidDisputeTx('appeal_dispute', ids, args, tx);

export function disputeEvidenceTx(
  ids: DisputeIds,
  args: DisputePartyArgs & {digest: Uint8Array; uri: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'submit_dispute_evidence'),
    arguments: [
      tx.object(ids.juryConfigId),
      tx.object(args.taskId),
      tx.object(args.caseId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.pure.vector('u8', Array.from(args.digest)),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.uri))),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function cancelDisputeTx(
  ids: DisputeIds,
  args: DisputePartyArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'cancel_dispute_before_draw'),
    arguments: [
      tx.object(args.taskId),
      tx.object(args.caseId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export interface DisputePayoutArgs {
  taskId: string;
  caseId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  /** Any `Platform` object when the task has no platform; the contract ignores it then. */
  platformObjectId: string;
}

/** Permissionless once the case is final. */
export function executeVerdictTx(
  ids: DisputeIds,
  args: DisputePayoutArgs,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'execute_verdict'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.caseId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.platformObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Permissionless once a case has failed: opens the settlement window. */
export function startNeutralResolutionTx(
  ids: DisputeIds,
  args: {taskId: string; caseId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'start_neutral_resolution'),
    arguments: [
      tx.object(ids.juryConfigId),
      tx.object(args.taskId),
      tx.object(args.caseId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Permissionless once the settlement window has ended: the escrow is split 50/50. */
export function executeNeutralResolutionTx(
  ids: DisputeIds,
  args: Omit<DisputePayoutArgs, 'caseId'>,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'execute_neutral_resolution'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.platformObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function proposeDisputeSettlementTx(
  ids: DisputeIds,
  args: {taskId: string; buyerAccountId: string; sellerAgentId: string; outcome: number},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'propose_dispute_settlement'),
    arguments: [
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.pure.u8(args.outcome),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function acceptDisputeSettlementTx(
  ids: DisputeIds,
  args: {
    taskId: string;
    buyerAccountId: string;
    sellerAccountId: string;
    sellerAgentId: string;
    platformObjectId: string;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'accept_dispute_settlement'),
    arguments: [
      tx.object(ids.taskConfigId),
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAccountId),
      tx.object(args.sellerAgentId),
      tx.object(args.platformObjectId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function clearDisputeSettlementTx(
  ids: DisputeIds,
  args: {taskId: string; buyerAccountId: string; sellerAgentId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: taskTarget(ids, 'clear_dispute_settlement'),
    arguments: [
      tx.object(args.taskId),
      tx.object(ids.memoryConfigId),
      tx.object(args.buyerAccountId),
      tx.object(args.sellerAgentId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Pays out the case fee pool once the dispute is over. When the dispute ended by agreement or a
 * neutral split the jury case is still open, so it is closed first in the same transaction.
 */
export function settleDisputeFeesTx(
  ids: DisputeIds,
  args: {taskId: string; caseId: string; closeCaseFirst: boolean},
  tx = new Transaction(),
): Transaction {
  if (args.closeCaseFirst) {
    tx.moveCall({
      target: taskTarget(ids, 'close_case_after_resolution'),
      arguments: [
        tx.object(ids.juryConfigId),
        tx.object(ids.jurorRosterId),
        tx.object(args.taskId),
        tx.object(args.caseId),
        tx.object(MYSO_CLOCK_OBJECT_ID),
      ],
    });
  }
  tx.moveCall({
    target: taskTarget(ids, 'settle_dispute_fees'),
    arguments: [tx.object(args.taskId), tx.object(args.caseId), tx.object(MYSO_CLOCK_OBJECT_ID)],
  });
  return tx;
}

// ============================================================
// Juror roster (`social_contracts::jury`) — free to join and leave; nothing is staked.
// ============================================================

type RosterIds = Pick<AgentChainIds, 'socialPackageId' | 'memoryConfigId' | 'juryConfigId' | 'jurorRosterId'>;

export function joinRosterTx(
  ids: RosterIds,
  args: {accountId: string; agentId: string; payoutAddress: string; modelFamily: number},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: `${ids.socialPackageId}::jury::join_roster`,
    arguments: [
      tx.object(ids.juryConfigId),
      tx.object(ids.jurorRosterId),
      tx.object(ids.memoryConfigId),
      tx.object(args.accountId),
      tx.object(args.agentId),
      tx.pure.address(args.payoutAddress),
      tx.pure.u8(args.modelFamily),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function leaveRosterTx(
  ids: RosterIds,
  args: {accountId: string; agentId: string},
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: `${ids.socialPackageId}::jury::leave_roster`,
    arguments: [
      tx.object(ids.jurorRosterId),
      tx.object(args.accountId),
      tx.pure.address(args.agentId),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Message anchoring (`messaging::send_agent_message_digest`)
// ============================================================

export interface AnchorPackageConfig {
  latestPackageId: string;
  versionId: string;
  messagingConfigId: string;
  blockListRegistryId: string;
  memoryConfigId: string;
}

/**
 * Commits a free message's sha256 and a pointer to it on-chain, signed by the sending agent.
 * This is the only free-message anchor the contract exposes, so it is agent-only: the content
 * stays in the room and only the digest, sender, recipient and time become public.
 */
export function anchorAgentMessageTx(
  pkg: AnchorPackageConfig,
  args: {
    groupId: string;
    messageLogId: string;
    platformId: string;
    memoryAccountId: string;
    recipient: string;
    contentDigest: Uint8Array;
    contentUri: string;
    dedupeKey: Uint8Array;
    nonce: bigint;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: `${pkg.latestPackageId}::messaging::send_agent_message_digest`,
    arguments: [
      tx.object(pkg.versionId),
      tx.object(pkg.messagingConfigId),
      tx.object(args.groupId),
      tx.object(args.messageLogId),
      tx.object(pkg.blockListRegistryId),
      tx.object(args.platformId),
      tx.object(pkg.memoryConfigId),
      tx.object(args.memoryAccountId),
      tx.pure.address(args.recipient),
      tx.pure.vector('u8', Array.from(args.contentDigest)),
      tx.pure.string(args.contentUri),
      tx.pure.vector('u8', Array.from(args.dedupeKey)),
      tx.pure.u128(args.nonce),
      tx.object(MYSO_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}
