import {useQueryClient} from '@tanstack/react-query';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import {Transaction} from '@socialproof/myso/transactions';

import {useAgentVault, findRegisteredDraft, readAgentPolicy} from '../../contexts/AgentKeyVaultContext';
import type {AgentKeyEnvelopeV1, AgentRegistrationIntent} from '@socialproof/memory';
import {registrationGrant} from '../../lib/agents/capabilities';
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
import {
  fetchProfileOverview,
  mistBigint,
  withCreditBalanceDelta,
  type ProfileOverview,
} from '../../lib/agents/profile-graphql';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useAuthenticatedAddress, useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {agentKeys} from './query-keys';
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

function registrationIntent(args: {label:string;capabilities:number;delegatableCaps?:number;expiresAtMs?:number|null;budget?:Omit<AgentBudgetArgs,'agentObjectId'>}, parentAgentId:string|null): AgentRegistrationIntent {
  const budget=args.budget;
  const decimal=(v:bigint|null)=>v==null?null:v.toString();
  return {label:args.label,capabilities:args.capabilities,delegatableCaps:args.delegatableCaps??0,expiresAtMs:args.expiresAtMs??null,parentAgentId,
    budget:budget?{balanceId:budget.balanceId,budgetMist:decimal(budget.budgetMist),dailyCapMist:decimal(budget.dailyCapMist),monthlyCapMist:decimal(budget.monthlyCapMist),requireApprovalAboveMist:decimal(budget.requireApprovalAboveMist)}:null};
}
function intentBudget(intent:AgentRegistrationIntent):Omit<AgentBudgetArgs,'agentObjectId'>|undefined {
  const b=intent.budget;if(!b)return undefined;
  const mist=(v:string|null)=>v==null?null:BigInt(v);
  return {balanceId:b.balanceId,budgetMist:mist(b.budgetMist),dailyCapMist:mist(b.dailyCapMist),monthlyCapMist:mist(b.monthlyCapMist),requireApprovalAboveMist:mist(b.requireApprovalAboveMist)};
}

export function useAgentActions() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const address = useAuthenticatedAddress();
  const vault = useAgentVault();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAgents();
  const seedCreatedSubAgent = useSeedCreatedSubAgent();

  function publishCreditBalance(deltaMist: bigint) {
    if (!address) return;
    const key = agentKeys.profileOverview(address);
    queryClient.setQueryData<ProfileOverview>(key, (current) =>
      withCreditBalanceDelta(current, deltaMist),
    );
    const target = mistBigint(
      queryClient.getQueryData<ProfileOverview>(key)?.aiCreditBalance?.balanceMist,
    );
    void (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const indexed = await fetchProfileOverview(address).catch(() => null);
        if (!indexed?.aiCreditBalance) continue;
        const indexedMist = mistBigint(indexed.aiCreditBalance.balanceMist);
        const caughtUp = deltaMist >= 0n ? indexedMist >= target : indexedMist <= target;
        if (!caughtUp) continue;
        queryClient.setQueryData(key, indexed);
        return;
      }
    })();
  }

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

  async function finishAgentSetup(agentId:string) {
    if(!vault)throw new Error('Unlock agent keys first.');
    const epoch=vault.generation();const {client:rpc,human}=requireClient();
    const setup=await vault.verifiedSetup(agentId);
    const ids=await resolveAgentChainIds();
    const followUp=new Transaction();
    ensureAgentMemoryVaultTx(ids,{accountId:vault.api.accountId,agentObjectId:agentId},followUp);
    if(setup.intent?.budget&&setup.state.budget==='pending')setAgentBudgetTx(ids,{...intentBudget(setup.intent)!,agentObjectId:agentId},followUp);
    vault.assertCurrent(epoch);await executeAsHuman(rpc,human,followUp);vault.assertCurrent(epoch);
    await vault.api.setSetup(agentId,{vault:'complete',budget:setup.intent?.budget?'complete':'skipped'});
    await invalidate();
  }

  return {
    finishAgentSetup,
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
      draft?: AgentKeyEnvelopeV1;
      delegatableCaps?: number;
      budget?: Omit<AgentBudgetArgs, 'agentObjectId'>;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      if (!vault) throw new Error('Agent key custody is not enabled.');
      const epoch = vault.generation();
      const saved=args.draft?await vault.verifiedIntent(args.draft):null;
      if(saved){if(saved.parentAgentId!==null)throw new Error('Choose the saved child setup with its original parent.');args={...args,label:saved.label,capabilities:saved.capabilities,delegatableCaps:saved.delegatableCaps,expiresAtMs:saved.expiresAtMs,budget:intentBudget(saved)};}
      const prepared = args.draft ? {envelope: args.draft, key: await vault.recoverDraft(args.draft)} : await vault.prepare(args.organizationId,registrationIntent(args,null));
      await vault.api.setIntent(prepared.envelope.keyId,saved??registrationIntent(args,null));
      const derived = prepared.key;
      const capabilities = args.capabilities;
      const delegatableCaps = args.delegatableCaps ?? 0;
      const register = registerSubAgentTx(ids, {
        accountId: args.accountId,
        organizationId: args.organizationId,
        publicKey: derived.publicKey,
        derivedAddress: derived.address,
        label: args.label,
        capabilities,
        delegatableCaps,
        expiresAtMs: args.expiresAtMs ?? null,
      });
      const existingId = await findRegisteredDraft(prepared.envelope);
      vault.assertCurrent(epoch);
      const agentObjectId = existingId ?? await requireCreatedObjectId(rpc, await executeAsHuman(rpc, human, register), 'SubAgent');
      vault.assertCurrent(epoch);
      await vault.finalize(prepared.envelope, derived.seed, agentObjectId);

      await finishAgentSetup(agentObjectId);
      await invalidate(args.organizationId);
      publishCreatedAgent(
        createdSubAgentRow({
          agentObjectId,
          derivedAddress: derived.address,
          accountId: args.accountId,
          label: args.label,
          capabilities,
          delegatableCaps,
          parentObjectId: null,
          depth: 1,
          registeredBy: address!,
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
      draft?: AgentKeyEnvelopeV1;
      delegatableCaps?: number;
      approveParentGrant?: boolean;
      budget?: Omit<AgentBudgetArgs, 'agentObjectId'>;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      if (!vault) throw new Error('Agent key custody is not enabled.');
      const epoch = vault.generation();
      const saved=args.draft?await vault.verifiedIntent(args.draft):null;
      if(saved){if(saved.parentAgentId!==args.parent.agent_object_id)throw new Error('Choose the original parent for this saved setup.');args={...args,label:saved.label,capabilities:saved.capabilities,delegatableCaps:saved.delegatableCaps,expiresAtMs:saved.expiresAtMs,budget:intentBudget(saved)};}
      const parentKey = await vault.getAgent(args.parent);
      const parentPolicy = await readAgentPolicy(args.parent.agent_object_id);
      const grant = registrationGrant(
        {
          capabilities: parentPolicy.capabilities,
          delegatableCaps: parentPolicy.delegatableCaps,
        },
        args.capabilities,
      );
      if (grant) {
        if (!args.approveParentGrant) throw new Error('Approve the displayed parent permission update before creating this child.');
        await executeAsHuman(
          rpc,
          human,
          updateSubAgentTx(ids, {
            accountId: args.accountId,
            agentObjectId: args.parent.agent_object_id,
            capabilities: grant.capabilities,
            delegatableCaps: grant.delegatableCaps,
            expiresAtMs: parentPolicy.expiresAt,
            identityClass:parentPolicy.identityClass,roleTags:parentPolicy.roleTags,
            approvalRequiredCaps: parentPolicy.approvalRequiredCaps,
            maxActionSpend: parentPolicy.maxActionSpend == null ? null : String(parentPolicy.maxActionSpend),
            platformScope: parentPolicy.platformScope,
            registerScope: parentPolicy.registerScope,
          }),
        );
      }
      const prepared = args.draft ? {envelope: args.draft, key: await vault.recoverDraft(args.draft)} : await vault.prepare(args.organizationId ?? args.parent.organization_id!,registrationIntent(args,args.parent.agent_object_id));
      await vault.api.setIntent(prepared.envelope.keyId,saved??registrationIntent(args,args.parent.agent_object_id));
      const child = prepared.key;
      const delegatableCaps = args.delegatableCaps ?? 0;
      const existingId = await findRegisteredDraft(prepared.envelope);
      vault.assertCurrent(epoch);
      const digest = existingId ? null : await executeAsAgent(
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
          delegatableCaps,
          expiresAtMs: parentPolicy.expiresAt == null ? (args.expiresAtMs ?? null) : Math.min(args.expiresAtMs ?? parentPolicy.expiresAt, parentPolicy.expiresAt),
          approvalRequiredCaps: parentPolicy.approvalRequiredCaps & args.capabilities,
          maxActionSpend: parentPolicy.maxActionSpend == null ? null : String(parentPolicy.maxActionSpend),
          platformScope: parentPolicy.platformScope,
        }),
        parentKey.signal,
      );
      // The parent signs delegated registration; recover the created child from effects.
      const agentObjectId = existingId ?? await requireCreatedObjectId(rpc, digest, 'SubAgent');
      vault.assertCurrent(epoch);
      await vault.finalize(prepared.envelope, child.seed, agentObjectId);
      await finishAgentSetup(agentObjectId);
      await invalidate(args.organizationId);
      publishCreatedAgent(
        createdSubAgentRow({
          agentObjectId,
          derivedAddress: child.address,
          accountId: args.accountId,
          label: args.label,
          capabilities: args.capabilities,
          delegatableCaps,
          parentObjectId: args.parent.agent_object_id,
          depth: args.parent.depth + 1,
          registeredBy: parentKey.address,
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
      /** Explicit delegation change; omitted preserves the current grant within the new capabilities. */
      delegatableCaps?: number;
      expiresAtMs?: number | null;
      label?: string;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      const policy = await readAgentPolicy(args.agentObjectId);
      const tx = updateSubAgentTx(ids, {
        accountId: args.accountId,
        agentObjectId: args.agentObjectId,
        capabilities: args.capabilities,
        delegatableCaps: args.delegatableCaps ?? (policy.delegatableCaps & args.capabilities),
        expiresAtMs: args.expiresAtMs === undefined ? policy.expiresAt : args.expiresAtMs,
        identityClass:policy.identityClass,roleTags:policy.roleTags,
        approvalRequiredCaps:policy.approvalRequiredCaps,maxActionSpend:policy.maxActionSpend,
        platformScope:policy.platformScope,registerScope:policy.registerScope,
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
      publishCreditBalance(args.amountMist);
    },

    async withdrawCredits(args: {balanceId: string; amountMist: bigint}) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(rpc, human, withdrawAiCreditTx(ids, args));
      await invalidate();
      publishCreditBalance(-args.amountMist);
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
