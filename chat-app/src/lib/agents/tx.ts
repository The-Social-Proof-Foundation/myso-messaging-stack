import { Transaction } from '@socialproof/myso/transactions';
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
