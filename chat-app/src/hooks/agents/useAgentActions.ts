import {useQueryClient} from '@tanstack/react-query';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import {Transaction} from '@socialproof/myso/transactions';

import {useAgentVault, findRegisteredDraft, readAgentPolicy} from '../../contexts/AgentKeyVaultContext';
import {generateAgentKey, type AgentKeyEnvelopeV1, type AgentRegistrationIntent} from '@socialproof/memory';
import type {AutomationClient} from '../../lib/agents/automation-client';
import {
  DELEGATE_CAPABILITIES,
  automationDelegateLabel,
  DelegateError,
  configuredMyDataKey,
  delegateKeyRef,
  encryptDelegateSeed,
  validateDelegatePolicy,
} from '../../lib/agents/automation-delegate';
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
import {
  fetchOrganization,
  fetchOrganizationAuditLogs,
  fetchSubAgentByObjectId,
} from '../../lib/agents/social-api';
import {ORG_OWNER_MASK} from '../../lib/agents/org-permissions';
import {
  fetchProfileOverview,
  mistBigint,
  withCreditBalanceDelta,
  type ProfileOrganizationStatistics,
  type ProfileOverview,
} from '../../lib/agents/profile-graphql';

const EMPTY_ORG_STATISTICS: ProfileOrganizationStatistics = {
  totalAgents: 0,
  activeAgents: 0,
  totalRevenueMyso: 0,
  totalOutboundSpendMyso: 0,
  netCashFlowMyso: 0,
  totalActionsExecuted: 0,
  totalEngagement: 0,
  memoryEntries: 0,
  memoryBytes: 0,
  aiCreditUsageEvents: 0,
  aiCreditSpentMist: 0,
};
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

  /**
   * The social server reads permissions from its index, which trails the chain. Refetching right
   * after the grant lands would just 403 again, so wait until the gated route accepts the wallet.
   */
  async function waitForAuditorAccess(organizationId: string, {timeoutMs = 20_000, intervalMs = 1000} = {}) {
    if (!keypair) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetchOrganizationAuditLogs(organizationId, keypair, {limit: 1, offset: 0});
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

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
    if (row.organization_id) publishAgentCountBump(row.organization_id);
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

  /**
   * The sidebar reads the indexed profile overview, which trails the chain. Seed what we already
   * know (the new organization, or one more agent in a count) so it shows up at once, and keep
   * re-applying it until the indexer returns a snapshot that includes the change.
   */
  function publishOverviewChange(
    apply: (overview: ProfileOverview) => ProfileOverview,
    indexedHasChange: (overview: ProfileOverview) => boolean,
  ) {
    if (!address) return;
    const key = agentKeys.profileOverview(address);
    const seed = () =>
      queryClient.setQueryData<ProfileOverview>(key, (current) =>
        current && !indexedHasChange(current) ? apply(current) : current,
      );
    seed();
    void (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const indexed = await fetchProfileOverview(address).catch(() => null);
        if (indexed && indexedHasChange(indexed)) {
          queryClient.setQueryData(key, indexed);
          return;
        }
        // A refetch triggered elsewhere may have replaced the seeded value with a stale one.
        seed();
      }
    })();
  }

  function publishCreatedOrganization(row: ProfileOverview['organizations'][number]) {
    const id = row.organizationId.toLowerCase();
    publishOverviewChange(
      (overview) => ({...overview, organizations: [...overview.organizations, row]}),
      (overview) => overview.organizations.some((org) => org.organizationId.toLowerCase() === id),
    );
  }

  /** One more agent in an organization's count; done once the indexed count reaches the target. */
  function publishAgentCountBump(organizationId: string) {
    if (!address) return;
    const id = organizationId.toLowerCase();
    const find = (overview?: ProfileOverview) =>
      overview?.organizations.find((org) => org.organizationId.toLowerCase() === id);
    const before = Number(
      find(queryClient.getQueryData<ProfileOverview>(agentKeys.profileOverview(address)))?.statistics
        ?.totalAgents ?? 0,
    );
    const target = before + 1;
    publishOverviewChange(
      (overview) => ({
        ...overview,
        organizations: overview.organizations.map((org) =>
          org.organizationId.toLowerCase() === id
            ? {
                ...org,
                statistics: {
                  ...(org.statistics ?? EMPTY_ORG_STATISTICS),
                  totalAgents: target,
                  activeAgents: Number(org.statistics?.activeAgents ?? 0) + 1,
                },
              }
            : org,
        ),
      }),
      (overview) => Number(find(overview)?.statistics?.totalAgents ?? 0) >= target,
    );
  }

  const requireClient = () => {
    if (!client || !keypair) {
      throw new Error('Sign in and wait for the messaging client before sending a transaction.');
    }
    return {client: client as ClientWithCoreApi, human: keypair};
  };

  async function finishAgentSetup(agentId:string) {
    if(!vault)throw new Error('Unlock agent keys first.');
    await vault.ensureUnlocked();
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
      publishCreatedOrganization({
        organizationId,
        name: args.name,
        description: args.description,
        orgType: String(args.orgType),
        active: true,
        createdAt: Date.now(),
        statistics: EMPTY_ORG_STATISTICS,
      });
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
      /** Reports each stage of the multi-step registration, for a progress display. */
      onStep?: (step: string) => void;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      if (!vault) throw new Error('Agent key custody is not enabled.');
      const epoch = vault.generation();
      const saved=args.draft?await vault.verifiedIntent(args.draft):null;
      if(saved){if(saved.parentAgentId!==null)throw new Error('Choose the saved child setup with its original parent.');args={...args,label:saved.label,capabilities:saved.capabilities,delegatableCaps:saved.delegatableCaps,expiresAtMs:saved.expiresAtMs,budget:intentBudget(saved)};}
      args.onStep?.('Securing the agent key…');
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
      args.onStep?.('Registering on chain…');
      const existingId = await findRegisteredDraft(prepared.envelope);
      vault.assertCurrent(epoch);
      const agentObjectId = existingId ?? await requireCreatedObjectId(rpc, await executeAsHuman(rpc, human, register), 'SubAgent');
      vault.assertCurrent(epoch);
      args.onStep?.('Backing up the key…');
      await vault.finalize(prepared.envelope, derived.seed, agentObjectId);

      args.onStep?.('Setting up memory…');
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

    /**
     * Create a delegate for unattended automation.
     *
     * Registers a fresh sub-agent on-chain with memory-only capabilities, a
     * spend cap and an expiry, then encrypts its seed to the memory bridge. The
     * user's own agent keys are never touched; the delegate's seed exists in
     * this browser only until it is encrypted and uploaded.
     */
    async registerAutomationDelegate(args: {
      accountId: string;
      organizationId: string;
      /** The agent this delegate works for; it registers the delegate on chain. */
      parent: SubAgentRow;
      name: string;
      expiresAtMs: number;
      /** Spend cap in MIST, as a decimal string. */
      maxActionSpendMist: string;
      client: AutomationClient;
      onStep?: (step: string) => void;
    }) {
      const myDataKey = configuredMyDataKey();
      if (!myDataKey) {
        throw new DelegateError(
          'Automation delegates are not set up: the memory bridge has not published a MyData key (VITE_AUTOMATION_MYDATA_KEY).',
        );
      }
      validateDelegatePolicy({
        name: args.name,
        expiresAtMs: args.expiresAtMs,
        maxActionSpendMist: args.maxActionSpendMist,
      });
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();

      args.onStep?.('Creating the delegate key…');
      const key = await generateAgentKey();
      try {
        args.onStep?.('Registering the delegate on chain…');
        // An organization has exactly one root, so a delegate is a CHILD of the agent it works
        // for, registered by that agent's own key (the owner's browser holds it in the vault).
        if (!vault) throw new DelegateError('Agent key custody is not enabled.');
        const parentKey = await vault.getAgent(args.parent);
        const parentPolicy = await readAgentPolicy(args.parent.agent_object_id);
        if (registrationGrant(
          {capabilities: parentPolicy.capabilities, delegatableCaps: parentPolicy.delegatableCaps},
          DELEGATE_CAPABILITIES,
        )) {
          throw new DelegateError(
            `"${args.parent.label}" is not allowed to create delegates yet. Open its permissions and ` +
              'allow it to register agents and to delegate read and write memory, then try again.',
          );
        }
        if (parentPolicy.maxActionSpend != null && BigInt(args.maxActionSpendMist) > BigInt(parentPolicy.maxActionSpend)) {
          throw new DelegateError(
            `A delegate cannot spend more than its parent agent's limit (${parentPolicy.maxActionSpend} MIST).`,
          );
        }
        const expiresAtMs =
          parentPolicy.expiresAt == null ? args.expiresAtMs : Math.min(args.expiresAtMs, parentPolicy.expiresAt);
        const register = registerSubAgentDelegatedTx(ids, {
          accountId: args.accountId,
          parentAgentObjectId: args.parent.agent_object_id,
          publicKey: key.publicKey,
          derivedAddress: key.address,
          label: automationDelegateLabel(args.name),
          capabilities: DELEGATE_CAPABILITIES,
          // Cannot mint children, and acts without an owner co-sign.
          delegatableCaps: 0,
          approvalRequiredCaps: 0,
          maxActionSpend: args.maxActionSpendMist,
          expiresAtMs,
          platformScope: parentPolicy.platformScope,
        });
        const agentObjectId = await requireCreatedObjectId(
          rpc,
          await executeAsAgent(rpc, parentKey.keypair, human, register, parentKey.signal),
          'SubAgent',
        );

        try {
          args.onStep?.('Setting up its memory vault…');
          const followUp = new Transaction();
          ensureAgentMemoryVaultTx(ids, {accountId: args.accountId, agentObjectId}, followUp);
          await executeAsHuman(rpc, human, followUp);

          args.onStep?.('Encrypting the key to the bridge…');
          const encrypted_key = await encryptDelegateSeed(
            key.seed,
            myDataKey,
            args.accountId,
            args.name,
            agentObjectId,
          );
          await args.client.putDelegate(args.name, {
            agent_object_id: agentObjectId,
            mydata_key_id: myDataKey.id,
            encrypted_key,
          });
        } catch (error) {
          // The seed existed only here, so it is gone with this call. Say so,
          // and say what to do: an unusable delegate should be revoked, not left.
          const reason = error instanceof Error ? error.message : String(error);
          throw new DelegateError(
            `The delegate was registered on-chain (${agentObjectId}) but could not be stored, ` +
              `and its key is now gone. Revoke it and create it again. ${reason}`,
          );
        }

        await invalidate();
        return {
          agentObjectId,
          keyRef: delegateKeyRef(args.name),
          expiresAtMs: args.expiresAtMs,
        };
      } finally {
        key.seed.fill(0);
      }
    },

    /**
     * Revoke a delegate. The on-chain revoke is the kill switch (the relayer and
     * the bridge both refuse a revoked delegate on their next request); deleting
     * the stored ciphertext afterwards is housekeeping.
     */
    async revokeAutomationDelegate(args: {
      accountId: string;
      agentObjectId: string;
      name: string;
      client: AutomationClient;
    }) {
      const {client: rpc, human} = requireClient();
      const ids = await resolveAgentChainIds();
      await executeAsHuman(
        rpc,
        human,
        revokeSubAgentTx(ids, {accountId: args.accountId, agentObjectId: args.agentObjectId}),
      );
      try {
        await args.client.deleteDelegate(args.name);
      } catch {
        // Already unusable on-chain; a stale ciphertext row is harmless.
      }
      await invalidate();
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
      /** Reports each stage of the multi-step registration, for a progress display. */
      onStep?: (step: string) => void;
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
      args.onStep?.('Securing the agent key…');
      const prepared = args.draft ? {envelope: args.draft, key: await vault.recoverDraft(args.draft)} : await vault.prepare(args.organizationId ?? args.parent.organization_id!,registrationIntent(args,args.parent.agent_object_id));
      await vault.api.setIntent(prepared.envelope.keyId,saved??registrationIntent(args,args.parent.agent_object_id));
      const child = prepared.key;
      const delegatableCaps = args.delegatableCaps ?? 0;
      args.onStep?.('Registering on chain…');
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
      args.onStep?.('Backing up the key…');
      await vault.finalize(prepared.envelope, child.seed, agentObjectId);
      args.onStep?.('Setting up memory…');
      args.onStep?.('Setting up memory…');
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
      await waitForAuditorAccess(args.organizationId);
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
