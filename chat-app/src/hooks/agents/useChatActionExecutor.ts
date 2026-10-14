import {useCallback} from 'react';
import {sha256} from '@noble/hashes/sha2.js';
import {ORG_PERM_MEMORY_READ, ORG_PERM_MEMORY_WRITE} from '@socialproof/memory/account';
import type {Memory} from '@socialproof/memory';

import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {assertAgentAccountBinding} from '../../lib/agents/account-isolation';
import {
  WORKER_DELEGATE_TTL_MS,
  WORKER_SPEND_LIMIT_MIST,
  defaultJobName,
  formatJobs,
  pickWorkerDelegate,
  requiredActionsFor,
  ruleSummary,
  ruleToChoice,
  workerDelegateName,
  type RuleParams,
} from '../../lib/agents/automation-chat';
import {AutomationClient} from '../../lib/agents/automation-client';
import {delegateKeyRef} from '../../lib/agents/automation-delegate';
import {buildTaskJobInput} from '../../lib/agents/automation-job';
import {CAP, CAPABILITY_LABELS} from '../../lib/agents/capabilities';
import {
  assertBuyerCanSettle,
  assertCanHostChild,
  assertOpenOfferFor,
  clampWindowMs,
  formatRecall,
  formatTaskList,
  isSelfOrDescendant,
  mergeTasks,
  planPermissionChange,
} from '../../lib/agents/chat-action-run';
import type {ChatActionProposal} from '../../lib/agents/chat-actions';
import {parseMysoToMist} from '../../lib/agents/format';
import {socialGet, socialGraphql, socialSchema} from '../../lib/agents/social-read';
import {
  createAgentMemoryClient,
  recallAgentMemories,
  rememberAgentFacts,
} from '../../lib/agents/memory-client';
import {
  fetchOrganization,
  fetchSubAgentByObjectId,
  fetchTask,
  fetchTaskConfig,
  fetchTasks,
  socialServerBase,
  type SubAgentRow,
} from '../../lib/agents/social-api';
import {useAgentActions} from './useAgentActions';
import {useJuryActions} from './useJury';
import {useMemoryAccount} from './useMemoryAccount';
import {useAllSubAgents} from './useSubAgents';
import {useTaskActions} from './useTaskActions';

const HOUR_MS = 3_600_000;
/** The same indexer GraphQL endpoint the profile and organization screens read. */
const SOCIAL_GRAPHQL_URL = import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';
const shortDigest = (digest: string | null | undefined) => (digest ? ` (tx ${digest.slice(0, 8)}…)` : '');
const label = (row: SubAgentRow) => row.label?.trim() || row.agent_object_id.slice(0, 10);
const sameAgentId = (a: string, b: string) =>
  a.toLowerCase().replace(/^0x0*/, '') === b.toLowerCase().replace(/^0x0*/, '');

/**
 * Runs an owner-approved (or automatic) action proposed by an agent in chat. It never decides
 * whether to run: the caller has already checked the capability and collected any approval.
 * Every action re-checks the facts it depends on, because the world may have moved since the
 * agent proposed it. Returns the line the agent posts back.
 */
export function useChatActionExecutor(options: {enabled?: boolean} = {}) {
  const tasks = useTaskActions();
  const jury = useJuryActions();
  const agentActions = useAgentActions();
  const vault = useAgentVault();
  const account = useMemoryAccount();
  const principal = useAuthenticatedAddress();
  const allAgents = useAllSubAgents({enabled: options.enabled ?? true});
  const known = allAgents.items;

  const withMemory = useCallback(
    async <T>(agent: SubAgentRow, run: (memory: Memory) => Promise<T>): Promise<T> => {
      const accountId = account.data?.account_id;
      if (!vault || !accountId) throw new Error('Unlock agent keys first.');
      await vault.ensureUnlocked();
      const key = await vault.getAgent(agent);
      const memory = createAgentMemoryClient(key, accountId);
      try {
        return await run(memory);
      } finally {
        memory.destroy();
      }
    },
    [vault, account.data?.account_id],
  );

  /** The agent an automation is for: the proposer or anyone below it, and a live record. */
  const automationTarget = useCallback(
    async (proposer: SubAgentRow, targetId: string): Promise<SubAgentRow> => {
      if (!isSelfOrDescendant(known, proposer.agent_object_id, targetId)) {
        throw new Error('I can only set up automations for myself or an agent below me.');
      }
      const target = await fetchSubAgentByObjectId(targetId);
      if (!target?.active) throw new Error('That agent was not found or is deactivated.');
      return target;
    },
    [known],
  );

  /** An automation client signed as the target agent, which is the only identity the engine accepts. */
  const automationClientFor = useCallback(
    async (target: SubAgentRow): Promise<AutomationClient> => {
      const accountId = account.data?.account_id;
      if (!vault || !accountId) throw new Error('Unlock agent keys first.');
      await vault.ensureUnlocked();
      const key = await vault.getAgent(target);
      assertAgentAccountBinding({
        agentObjectId: target.agent_object_id,
        agentAccountId: target.account_id,
        derivedAddress: target.derived_address,
        chatCreatorActor: null,
        expectedAccountId: accountId,
      });
      return AutomationClient.create({key: key.seed, accountId});
    },
    [vault, account.data?.account_id],
  );

  return useCallback(
    async (proposal: ChatActionProposal, agent: SubAgentRow): Promise<string> => {
      const {name, params} = proposal;
      switch (name) {
        case 'list_agents': {
          const org = agent.organization_id?.toLowerCase();
          const rows = known.filter((row) => row.active && (!org || row.organization_id?.toLowerCase() === org));
          if (!rows.length) return 'I can only see myself right now.';
          const parentName = (row: SubAgentRow) =>
            row.parent_object_id ? known.find((p) => p.agent_object_id === row.parent_object_id) : undefined;
          const lines = rows.slice(0, 25).map((row) => {
            const parent = parentName(row);
            const role = row.agent_object_id === agent.agent_object_id ? 'me' : parent ? `reports to ${label(parent)}` : 'root';
            return `• ${label(row)} — ${role} — ${row.agent_object_id}`;
          });
          return `Agents in my organization:\n${lines.join('\n')}`;
        }

        case 'recall_memory': {
          const scope = params.memoryScope ?? 'all';
          const found = await withMemory(agent, (memory) =>
            recallAgentMemories(memory, params.query!, 8, {scope, anyLabel: true}),
          );
          return formatRecall(found.memories, params.query!, scope, found.truncated);
        }
        case 'remember': {
          await withMemory(agent, (memory) => rememberAgentFacts(memory, [params.fact!], 'private'));
          return 'Saved to my memory.';
        }
        case 'remember_for_org': {
          await withMemory(agent, (memory) => rememberAgentFacts(memory, [params.fact!], 'org'));
          return 'Saved to the organization’s shared memory.';
        }
        case 'grant_org_memory': {
          const targetId = params.agentId!;
          if (!isSelfOrDescendant(known, agent.agent_object_id, targetId)) {
            throw new Error('I can only change memory access for myself or an agent below me.');
          }
          const target = await fetchSubAgentByObjectId(targetId);
          if (!target?.active) throw new Error('That agent was not found or is deactivated.');
          if (!target.organization_id) throw new Error('That agent is not in an organization.');
          const org = await fetchOrganization(target.organization_id);
          if (!org?.org_memory_group_id) {
            throw new Error('This organization has no shared memory yet. Set it up from the Organizations panel first.');
          }
          const mask =
            params.access === 'read'
              ? ORG_PERM_MEMORY_READ
              : params.access === 'write'
                ? ORG_PERM_MEMORY_WRITE
                : ORG_PERM_MEMORY_READ | ORG_PERM_MEMORY_WRITE;
          await agentActions.grantOrgMemory({
            accountId: target.account_id,
            organizationId: target.organization_id,
            orgMemoryGroupId: org.org_memory_group_id,
            memberAddress: target.derived_address,
            permissionsMask: mask,
          });
          return `Done. ${label(target)} now has org memory ${params.access === 'both' ? 'read and write' : params.access} access.`;
        }

        case 'list_tasks': {
          const [asSeller, asBuyer] = await Promise.all([
            fetchTasks({sellerAgentId: agent.agent_object_id}, {limit: 20, offset: 0}),
            fetchTasks({buyerAgentId: agent.agent_object_id}, {limit: 20, offset: 0}),
          ]);
          return formatTaskList(mergeTasks(asSeller.items, asBuyer.items), agent.agent_object_id);
        }
        case 'create_task': {
          const config = await fetchTaskConfig();
          if (!config) throw new Error('The task market is not available right now.');
          if (!config.active) throw new Error('The task market is paused and is not taking new offers.');
          const amountMist = parseMysoToMist(params.amountMyso!);
          if (!amountMist || amountMist < BigInt(config.minEscrowMist)) {
            throw new Error(`Escrow at least ${Number(config.minEscrowMist) / 1e9} MySo.`);
          }
          const seller = await fetchSubAgentByObjectId(params.sellerAgentId!);
          if (!seller) throw new Error('No agent was found with that id.');
          if (!seller.active) throw new Error('That agent is deactivated and cannot take new work.');
          const digest = await tasks.createTask({
            sellerAccountId: seller.account_id,
            sellerAgentId: seller.agent_object_id,
            amountMist,
            // Only the digest of the scope goes on chain; the text stays in this chat.
            scopeDigest: sha256(new TextEncoder().encode(params.scope!)),
            title: params.title!,
            acceptWindowMs: clampWindowMs(params.acceptHours, config.acceptWindowDefaultMs, config.acceptWindowMinMs, config.acceptWindowMaxMs),
            deliveryWindowMs: clampWindowMs(params.deliveryHours, 24 * HOUR_MS, config.deliveryWindowMinMs, config.deliveryWindowMaxMs),
            settleWindowMs: clampWindowMs(params.settleHours, 48 * HOUR_MS, config.settleWindowMinMs, config.settleWindowMaxMs),
            roomGroupId: null,
            platformId: null,
          });
          return `Done. I offered "${params.title}" to ${label(seller)} with ${params.amountMyso} MySo in escrow.${shortDigest(digest)}`;
        }
        case 'accept_task': {
          const task = assertOpenOfferFor(await fetchTask(params.taskId!), agent.agent_object_id);
          const digest = await tasks.acceptTask(task);
          return `Done. I accepted "${task.title}".${shortDigest(digest)}`;
        }
        case 'decline_task': {
          const task = assertOpenOfferFor(await fetchTask(params.taskId!), agent.agent_object_id);
          const digest = await tasks.declineTask(task);
          return `Done. I declined "${task.title}".${shortDigest(digest)}`;
        }
        case 'settle_task': {
          const task = assertBuyerCanSettle(await fetchTask(params.taskId!), principal, agent.agent_object_id);
          const digest = await tasks.settleTask(task, {stars: params.stars});
          return `Done. I paid out "${task.title}"${params.stars ? ` and rated it ${params.stars}★` : ''}.${shortDigest(digest)}`;
        }

        case 'create_agent': {
          if (!agent.organization_id) throw new Error('I need to be in an organization to create agents.');
          if (!vault) throw new Error('Unlock agent keys first.');
          await vault.ensureUnlocked();
          const capabilities = (params.capabilities ?? []).reduce((mask, cap) => mask | CAP[cap], 0);
          const common = {
            accountId: agent.account_id,
            organizationId: agent.organization_id,
            label: params.label!,
            capabilities,
          };
          // A child goes under the proposer unless it names a deeper parent: itself or anyone below.
          let manager: SubAgentRow | undefined;
          if (params.relation === 'child' && params.parentAgentId) {
            if (!isSelfOrDescendant(known, agent.agent_object_id, params.parentAgentId)) {
              throw new Error('I can only place a new agent under myself or an agent below me.');
            }
            manager = known.find((row) => sameAgentId(row.agent_object_id, params.parentAgentId!));
            if (!manager) throw new Error('I could not find that agent to place the new one under.');
            assertCanHostChild(manager, CAP.AGENT_REGISTER);
          } else {
            manager = params.relation === 'sibling' && agent.parent_object_id
              ? known.find((row) => row.agent_object_id === agent.parent_object_id)
              : agent;
          }
          if (params.relation === 'sibling' && agent.parent_object_id && !manager) {
            throw new Error('I could not find my manager to register a sibling under.');
          }
          const created =
            params.relation === 'sibling' && !agent.parent_object_id
              ? await agentActions.registerRootAgent(common)
              : await agentActions.registerChildAgent({...common, parent: manager!, approveParentGrant: true});
          const where =
            params.relation === 'child'
              ? manager && manager.agent_object_id !== agent.agent_object_id
                ? `reporting to ${label(manager)}`
                : 'reporting to me'
              : 'beside me';
          return `Done. I created "${params.label}" ${where}.${created?.agentObjectId ? ` Its id is ${created.agentObjectId}.` : ''}`;
        }
        case 'rename_agent': {
          const targetId = params.agentId!;
          if (!isSelfOrDescendant(known, agent.agent_object_id, targetId)) {
            throw new Error('I can only rename myself or an agent below me.');
          }
          const target = await fetchSubAgentByObjectId(targetId);
          if (!target?.active) throw new Error('That agent was not found or is deactivated.');
          await agentActions.updateAgent({
            accountId: target.account_id,
            agentObjectId: target.agent_object_id,
            organizationId: target.organization_id,
            capabilities: target.capabilities,
            label: params.label,
          });
          return `Done. ${label(target)} is now called "${params.label}".`;
        }
        case 'update_agent_permissions': {
          const targetId = params.agentId!;
          if (
            sameAgentId(targetId, agent.agent_object_id) ||
            !isSelfOrDescendant(known, agent.agent_object_id, targetId)
          ) {
            throw new Error('I can only change permissions for an agent below me, never my own.');
          }
          const [target, proposer] = await Promise.all([
            fetchSubAgentByObjectId(targetId),
            fetchSubAgentByObjectId(agent.agent_object_id),
          ]);
          if (!target?.active) throw new Error('That agent was not found or is deactivated.');
          if (!proposer) throw new Error('I could not read my own permissions.');
          const plan = planPermissionChange({
            proposerDelegatable: proposer.delegatable_caps,
            target,
            grant: params.grant ?? [],
            revoke: params.revoke ?? [],
            delegate: params.delegate !== false,
          });
          if (!plan.added.length && !plan.removed.length) {
            return `${label(target)} already has exactly those permissions, so nothing changed.`;
          }
          await agentActions.updateAgent({
            accountId: target.account_id,
            agentObjectId: target.agent_object_id,
            organizationId: target.organization_id,
            capabilities: plan.capabilities,
            delegatableCaps: plan.delegatableCaps,
          });
          const said = [
            plan.added.length ? `gave it ${plan.added.map((c) => CAPABILITY_LABELS[c]).join(', ')}` : null,
            plan.removed.length ? `removed ${plan.removed.map((c) => CAPABILITY_LABELS[c]).join(', ')}` : null,
          ].filter(Boolean);
          return `Done. I updated ${label(target)}: ${said.join(' and ')}.`;
        }
        case 'query_social_graphql':
          return socialGraphql(params.graphql!, params.variables, SOCIAL_GRAPHQL_URL);
        case 'social_api_get':
          return socialGet(params.path!, socialServerBase());
        case 'social_schema':
          return socialSchema({search: params.search, typeName: params.typeName}, SOCIAL_GRAPHQL_URL);
        case 'list_automations': {
          const target = await automationTarget(agent, params.agentId!);
          const client = await automationClientFor(target);
          const [jobs, delegates] = await Promise.all([client.listJobs(50), client.listDelegates()]);
          const workers = delegates.filter((row) => row.delegate_class === 'task_worker').length;
          return `${formatJobs(jobs)}\nTask worker delegates: ${workers}.`;
        }
        case 'automate_agent': {
          const target = await automationTarget(agent, params.agentId!);
          if (!target.organization_id) throw new Error('That agent is not in an organization.');
          const rule = params as RuleParams;
          const choice = ruleToChoice(rule);
          const required = requiredActionsFor(rule);
          const client = await automationClientFor(target);
          const accountId = account.data!.account_id;

          // The job signs as a task worker delegate. Reuse one that may run these actions, or make
          // a short-lived, near-zero-spend one: the owner's approval covers both steps.
          const delegates = await client.listDelegates();
          let keyRef = pickWorkerDelegate(delegates, required);
          if (!keyRef) {
            const taken = new Set(delegates.map((row) => row.delegate_ref));
            let attempt = 0;
            let name = workerDelegateName(target.agent_object_id, attempt);
            while (taken.has(delegateKeyRef(name))) name = workerDelegateName(target.agent_object_id, (attempt += 1));
            await agentActions.registerAutomationDelegate({
              accountId,
              organizationId: target.organization_id,
              parent: target,
              name,
              expiresAtMs: Date.now() + WORKER_DELEGATE_TTL_MS,
              maxActionSpendMist: WORKER_SPEND_LIMIT_MIST,
              delegateClass: 'task_worker',
              client,
            });
            keyRef = delegateKeyRef(name);
          }
          const job = await client.createJob(
            buildTaskJobInput({
              name: defaultJobName(rule, label(target)),
              choice,
              targetAgentObjectId: target.agent_object_id,
              delegateKeyRef: keyRef,
            }),
          );
          return `Done. ${label(target)} will now ${ruleSummary(rule)}, on its own. (Job "${job.name}".)`;
        }
        case 'deactivate_agent': {
          const targetId = params.agentId!;
          if (targetId.toLowerCase() === agent.agent_object_id.toLowerCase() || !isSelfOrDescendant(known, agent.agent_object_id, targetId)) {
            throw new Error('I can only deactivate an agent below me.');
          }
          const target = await fetchSubAgentByObjectId(targetId);
          if (!target?.active) throw new Error('That agent was not found or is already deactivated.');
          await agentActions.deactivateAgent({
            accountId: target.account_id,
            agentObjectId: target.agent_object_id,
            organizationId: target.organization_id,
          });
          return `Done. ${label(target)} is deactivated.`;
        }

        case 'join_jury_roster': {
          const digest = await jury.joinRoster(agent, params.modelFamily ?? 0);
          return `Done. I'm on the juror roster.${shortDigest(digest)}`;
        }
        case 'leave_jury_roster': {
          const digest = await jury.leaveRoster(agent);
          return `Done. I've left the juror roster.${shortDigest(digest)}`;
        }
      }
    },
    [tasks, jury, agentActions, vault, principal, known, withMemory, account.data?.account_id, automationTarget, automationClientFor],
  );
}
