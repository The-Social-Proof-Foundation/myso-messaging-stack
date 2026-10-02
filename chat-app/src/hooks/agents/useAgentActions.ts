import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {Transaction} from '@socialproof/myso/transactions';

import {deriveAgentKeypair, findAgentKeypair} from '../../lib/agents/agent-keys';
import {registrationGrant, withRootRegistration} from '../../lib/agents/capabilities';
import {resolveAgentChainIds} from '../../lib/agents/chain-ids';
import {executeAsAgent, executeAsHuman, requireCreatedObjectId} from '../../lib/agents/execute';
import {
  approveAgentSpendTx,
  assignOrgRoleTx,
  createAgenticOrganizationTx,
  createOrgInvitationTx,
  deactivateAgenticOrganizationTx,
  deactivateSubAgentTx,
  depositAiCreditTx,
  ensureAgentMemoryVaultTx,
  ensureOrgMemoryGroupTx,
  grantOrgMemoryPermissionTx,
  pauseAiCreditTx,
  reactivateAiCreditTx,
  registerSubAgentDelegatedTx,
  registerSubAgentTx,
  revokeAgentSpendApprovalTx,
  revokeOrgMemoryPermissionTx,
  revokeOrgRoleTx,
  IDENTITY_CLASS_DELEGATED_AI,
  revokeSubAgentTx,
  setAgentBudgetTx,
  setAiCreditAccountCapsTx,
  updateAgenticOrganizationLabelTx,
  updateSubAgentLabelTx,
  updateSubAgentTx,
  withdrawAiCreditTx,
  type AgentBudgetArgs,
} from '../../lib/agents/tx';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {fetchOrganization, fetchSubAgentByObjectId} from '../../lib/agents/social-api';
import {ORG_OWNER_MASK} from '../../lib/agents/org-permissions';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {useInvalidateAgents, useSeedCreatedSubAgent} from './useInvalidateAgents';

/** The org's derived memory group id, once the indexer has caught up. */
async function orgMemoryGroupId(organizationId: string): Promise<string | null> {
  const row = await fetchOrganization(organizationId);
  return row?.org_memory_group_id ?? null;
}

/** Polls briefly for the freshly created derived group to appear in the index. */
async function waitForOrgMemoryGroup(
  organizationId: string,
  {timeoutMs = 20_000, intervalMs = 750} = {},
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groupId = await orgMemoryGroupId(organizationId).catch(() => null);
    if (groupId) return groupId;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function createdSubAgentRow(args: {
  agentObjectId: string;
  derivedAddress: string;
  accountId: string;
  label: string;
  capabilities: number;
  delegatableCaps: number;
  parentObjectId: string | null;
  depth: number;
  registeredBy: string;
  expiresAtMs: number | null;
  organizationId: string | null;
}): SubAgentRow {
  const now = Date.now();
  return {
    agent_object_id: args.agentObjectId,
    derived_address: args.derivedAddress,
    account_id: args.accountId,
    label: args.label,
    identity_class: IDENTITY_CLASS_DELEGATED_AI,
    capabilities: args.capabilities,
    delegatable_caps: args.delegatableCaps,
    parent_object_id: args.parentObjectId,
    depth: args.depth,
    registered_by: args.registeredBy,
    expires_at_ms: args.expiresAtMs,
    active: true,
    created_at_ms: now,
    deactivated_at_ms: null,
    revoked_at_ms: null,
    updated_at_ms: now,
    organization_id: args.organizationId,
  };
}

export function useAgentActions() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const invalidate = useInvalidateAgents();
  const seedCreatedSubAgent = useSeedCreatedSubAgent();

  function publishCreatedAgent(row: SubAgentRow) {
    seedCreatedSubAgent(row);
    const id = row.agent_object_id;
    void (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const indexed = await fetchSubAgentByObjectId(id).catch(() => null);
        if (indexed) {
          seedCreatedSubAgent(indexed);
          return;
        }
      }
    })();
  }

  const requireClient = () => {
    if (!client || !keypair) {
      throw new Error('Sign in and wait for the messaging client before sending a transaction.');
    }
    return {client: client as ClientWithCoreApi, human: keypair};
  };

  return {
    async createOrganization(args: {
      accountId: string;
      orgType: number;
      name: string;
      description: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      const digest = await executeAsHuman(
        rpc,
        human,
        createAgenticOrganizationTx(ids, args),
      );
      const organizationId = await requireCreatedObjectId(
        rpc,
        digest,
        'AgenticOrganization',
      );
      await invalidate(organizationId);
      return organizationId;
    },

    async updateOrganization(args: {
      accountId: string;
      organizationId: string;
      name: string | null;
      description: string | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, updateAgenticOrganizationLabelTx(ids, args));
      await invalidate(args.organizationId);
    },

    async deactivateOrganization(args: {accountId: string; organizationId: string}) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, deactivateAgenticOrganizationTx(ids, args));
      await invalidate(args.organizationId);
    },

    async registerRootAgent(args: {
      accountId: string;
      organizationId: string;
      label: string;
      capabilities: number;
      expiresAtMs?: number | null;
      nextIndex: number;
      budget?: Omit<AgentBudgetArgs, 'agentObjectId'>;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      const derived = await deriveAgentKeypair(human as Ed25519Keypair, {
        organizationId: args.organizationId,
        index: args.nextIndex,
      });
      const capabilities = withRootRegistration(args.capabilities);
      const register = registerSubAgentTx(ids, {
        accountId: args.accountId,
        organizationId: args.organizationId,
        publicKey: derived.publicKey,
        derivedAddress: derived.address,
        label: args.label,
        capabilities,
        delegatableCaps: capabilities,
        expiresAtMs: args.expiresAtMs ?? null,
      });
      const digest = await executeAsHuman(rpc, human, register);
      const agentObjectId = await requireCreatedObjectId(rpc, digest, 'SubAgent');

      const followUp = new Transaction();
      ensureAgentMemoryVaultTx(
        ids,
        {accountId: args.accountId, agentObjectId},
        followUp,
      );
      if (args.budget) {
        setAgentBudgetTx(ids, {...args.budget, agentObjectId}, followUp);
      }
      await executeAsHuman(rpc, human, followUp);
      await invalidate(args.organizationId);
      publishCreatedAgent(
        createdSubAgentRow({
          agentObjectId,
          derivedAddress: derived.address,
          accountId: args.accountId,
          label: args.label,
          capabilities,
          delegatableCaps: capabilities,
          parentObjectId: null,
          depth: 0,
          registeredBy: human.toMySoAddress(),
          expiresAtMs: args.expiresAtMs ?? null,
          organizationId: args.organizationId,
        }),
      );
      return {agentObjectId, derived};
    },

    async registerChildAgent(args: {
      accountId: string;
      organizationId: string | null;
      parent: SubAgentRow;
      label: string;
      capabilities: number;
      expiresAtMs?: number | null;
      nextIndex: number;
      maxScanIndex: number;
      budget?: Omit<AgentBudgetArgs, 'agentObjectId'>;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      const parentKey = await findAgentKeypair(
        human as Ed25519Keypair,
        args.parent.derived_address,
        args.parent.organization_id ?? args.organizationId,
        Math.max(args.maxScanIndex, 32),
      );
      if (!parentKey) {
        throw new Error('Could not re-derive the parent agent key from this login.');
      }
      const grant = registrationGrant(
        {
          capabilities: args.parent.capabilities,
          delegatableCaps: args.parent.delegatable_caps,
        },
        args.capabilities,
      );
      if (grant) {
        await executeAsHuman(
          rpc,
          human,
          updateSubAgentTx(ids, {
            accountId: args.accountId,
            agentObjectId: args.parent.agent_object_id,
            capabilities: grant.capabilities,
            delegatableCaps: grant.delegatableCaps,
            expiresAtMs: args.parent.expires_at_ms,
          }),
        );
      }
      const child = await deriveAgentKeypair(human as Ed25519Keypair, {
        organizationId: args.organizationId ?? args.parent.organization_id,
        index: args.nextIndex,
      });
      const digest = await executeAsAgent(
        rpc,
        parentKey.keypair,
        human,
        registerSubAgentDelegatedTx(ids, {
          accountId: args.accountId,
          parentAgentObjectId: args.parent.agent_object_id,
          publicKey: child.publicKey,
          derivedAddress: child.address,
          label: args.label,
          capabilities: args.capabilities,
          delegatableCaps: args.capabilities,
          expiresAtMs: args.expiresAtMs ?? null,
        }),
      );
      // The parent signs delegated registration; recover the created child from effects.
      const agentObjectId = await requireCreatedObjectId(rpc, digest, 'SubAgent');
      const followUp = new Transaction();
      ensureAgentMemoryVaultTx(
        ids,
        {accountId: args.accountId, agentObjectId},
        followUp,
      );
      if (args.budget) {
        setAgentBudgetTx(ids, {...args.budget, agentObjectId}, followUp);
      }
      await executeAsHuman(rpc, human, followUp);
      await invalidate(args.organizationId);
      publishCreatedAgent(
        createdSubAgentRow({
          agentObjectId,
          derivedAddress: child.address,
          accountId: args.accountId,
          label: args.label,
          capabilities: args.capabilities,
          delegatableCaps: args.capabilities,
          parentObjectId: args.parent.agent_object_id,
          depth: args.parent.depth + 1,
          registeredBy: human.toMySoAddress(),
          expiresAtMs: args.expiresAtMs ?? null,
          organizationId: args.organizationId ?? args.parent.organization_id,
        }),
      );
      return {agentObjectId, derived: child};
    },

    async updateAgent(args: {
      accountId: string;
      agentObjectId: string;
      organizationId?: string | null;
      capabilities: number;
      expiresAtMs?: number | null;
      label?: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      const tx = updateSubAgentTx(ids, {
        accountId: args.accountId,
        agentObjectId: args.agentObjectId,
        capabilities: args.capabilities,
        delegatableCaps: args.capabilities,
        expiresAtMs: args.expiresAtMs ?? null,
      });
      if (args.label) {
        updateSubAgentLabelTx(
          ids,
          {
            accountId: args.accountId,
            agentObjectId: args.agentObjectId,
            label: args.label,
          },
          tx,
        );
      }
      await executeAsHuman(rpc, human, tx);
      await invalidate(args.organizationId);
    },

    async deactivateAgent(args: {
      accountId: string;
      agentObjectId: string;
      organizationId?: string | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, deactivateSubAgentTx(ids, args));
      await invalidate(args.organizationId);
    },

    async revokeAgent(args: {
      accountId: string;
      agentObjectId: string;
      organizationId?: string | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, revokeSubAgentTx(ids, args));
      await invalidate(args.organizationId);
    },

    async depositCredits(args: {balanceId: string; amountMist: bigint}) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, depositAiCreditTx(ids, args));
      await invalidate();
    },

    async withdrawCredits(args: {balanceId: string; amountMist: bigint}) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, withdrawAiCreditTx(ids, args));
      await invalidate();
    },

    async setAccountCaps(args: {
      balanceId: string;
      dailyCapMist: bigint | null;
      monthlyCapMist: bigint | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, setAiCreditAccountCapsTx(ids, args));
      await invalidate();
    },

    async setAgentBudget(args: AgentBudgetArgs & {organizationId?: string | null}) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, setAgentBudgetTx(ids, args));
      await invalidate(args.organizationId);
    },

    async pauseCredits(balanceId: string) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, pauseAiCreditTx(ids, {balanceId}));
      await invalidate();
    },

    async reactivateCredits(balanceId: string) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, reactivateAiCreditTx(ids, {balanceId}));
      await invalidate();
    },

    async approveSpend(args: {
      balanceId: string;
      agentObjectId: string;
      maxAmountMist: bigint;
      expiresAtMs: number;
      organizationId?: string | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, approveAgentSpendTx(ids, args));
      await invalidate(args.organizationId);
    },

    async revokeSpendApproval(args: {
      balanceId: string;
      agentObjectId: string;
      organizationId?: string | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, revokeAgentSpendApprovalTx(ids, args));
      await invalidate(args.organizationId);
    },

    /**
     * Creates the organization's shared-memory group and grants the owner the full
     * organization permission mask.
     *
     * Nothing grants the owner `DashboardViewer`/`Auditor` implicitly — `create_agentic_organization`
     * only records the owner, and the social server's dashboard routes read the granted bits —
     * so an org whose owner was never granted them returns 403 on every dashboard screen.
     * The grant needs the group's derived id, which only becomes known after indexing, hence
     * the bounded wait between the two transactions.
     */
    async ensureOrgMemory(args: {
      accountId: string;
      organizationId: string;
      ownerAddress: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(
        rpc,
        human,
        ensureOrgMemoryGroupTx(ids, {
          accountId: args.accountId,
          organizationId: args.organizationId,
        }),
      );

      const groupId =
        (await waitForOrgMemoryGroup(args.organizationId)) ?? (await orgMemoryGroupId(args.organizationId));
      if (groupId) {
        await executeAsHuman(
          rpc,
          human,
          grantOrgMemoryPermissionTx(ids, {
            accountId: args.accountId,
            organizationId: args.organizationId,
            orgMemoryGroupId: groupId,
            memberAddress: args.ownerAddress,
            permissionsMask: ORG_OWNER_MASK,
          }),
        );
      }
      await invalidate(args.organizationId);
      return groupId;
    },

    /** Repairs organization permission grants for an org that already has a memory group. */
    async grantOwnerOrgPermissions(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      ownerAddress: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(
        rpc,
        human,
        grantOrgMemoryPermissionTx(ids, {
          accountId: args.accountId,
          organizationId: args.organizationId,
          orgMemoryGroupId: args.orgMemoryGroupId,
          memberAddress: args.ownerAddress,
          permissionsMask: ORG_OWNER_MASK,
        }),
      );
      await invalidate(args.organizationId);
    },

    async grantOrgMemory(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      memberAddress: string;
      permissionsMask: number;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, grantOrgMemoryPermissionTx(ids, args));
      await invalidate(args.organizationId);
    },

    async revokeOrgMemory(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      memberAddress: string;
      permissionsMask: number;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, revokeOrgMemoryPermissionTx(ids, args));
      await invalidate(args.organizationId);
    },

    async assignRole(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      memberAddress: string;
      roleName: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, assignOrgRoleTx(ids, args));
      await invalidate(args.organizationId);
    },

    async revokeRole(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      memberAddress: string;
      roleName: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, revokeOrgRoleTx(ids, args));
      await invalidate(args.organizationId);
    },

    async inviteMember(args: {
      accountId: string;
      organizationId: string;
      orgMemoryGroupId: string;
      inviteeAddress: string;
      roleName: string | null;
      permissionsMask: number;
      expiresAtMs: number | null;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, createOrgInvitationTx(ids, args));
      await invalidate(args.organizationId);
    },
  };
}
