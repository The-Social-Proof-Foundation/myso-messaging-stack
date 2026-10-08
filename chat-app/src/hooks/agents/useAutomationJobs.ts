import {useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';

import type {SubAgentRow} from '../../lib/agents/social-api';
import type {AgentSigningKey} from '../../lib/agents/passkey-vault';
import {
  AutomationClient,
  type AutomationJob,
  type AutomationRun,
  type CreateJobInput,
} from '../../lib/agents/automation-client';
import {assertAgentAccountBinding} from '../../lib/agents/account-isolation';
import {agentKeys} from './query-keys';
import {useDerivedAgentKey} from './useDerivedAgentKey';
import {useMemoryAccount} from './useMemoryAccount';

/**
 * Build an automation client for an agent.
 *
 * Mirrors how the memory client is assembled: the signing key comes from the
 * custody vault and the account id from the memory account, and the two are
 * checked against each other before anything is signed. That binding check is
 * what stops an agent key from being used against an account it is not
 * registered under.
 */
function useAutomationClient(agent: SubAgentRow | null | undefined) {
  const memoryAccount = useMemoryAccount();
  const derived = useDerivedAgentKey(agent ?? null);

  const accountId = memoryAccount.data?.account_id ?? null;
  const derivedKey: AgentSigningKey | null = derived.data;

  const client = useMemo(() => {
    if (!derivedKey || !accountId || !agent) return null;
    // Throws rather than signing against a mismatched account: an automation
    // job is created with this agent's key, so the same binding check the
    // memory path uses has to gate it too.
    assertAgentAccountBinding({
      agentObjectId: agent.agent_object_id,
      agentAccountId: agent.account_id,
      derivedAddress: agent.derived_address,
      chatCreatorActor: null,
      expectedAccountId: accountId,
    });
    return AutomationClient.create({ key: derivedKey.seed, accountId });
    // `agent` is read for its identity fields; depending on the whole row would
    // rebuild the client on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    derivedKey,
    accountId,
    agent?.agent_object_id,
    agent?.account_id,
    agent?.derived_address,
  ]);

  return {
    client,
    accountId,
    isReady: Boolean(client),
    /** Non-null when the vault or account lookup failed, for display. */
    error: derived.error ?? memoryAccount.error ?? null,
  };
}

/** Jobs for the signed-in agent's account. */
export function useAutomationJobs(agent: SubAgentRow | null | undefined) {
  const {client, accountId} = useAutomationClient(agent);
  const query = useQuery({
    queryKey: agentKeys.automationJobs(accountId ?? ''),
    queryFn: () => client!.listJobs(),
    enabled: Boolean(client),
    // A job list changes only when someone creates or edits a job, and every
    // run writes a run row rather than a job row — so this does not need to
    // poll. The runs query below is the one that benefits from refresh.
    staleTime: 30_000,
  });
  return query;
}

/** Recent runs for one job, refreshed while the panel is open. */
export function useAutomationRuns(
  agent: SubAgentRow | null | undefined,
  jobId: string | null,
) {
  const {client, accountId} = useAutomationClient(agent);
  return useQuery({
    queryKey: agentKeys.automationRuns(accountId ?? '', jobId ?? ''),
    queryFn: () => client!.listRuns(jobId!),
    enabled: Boolean(client) && Boolean(jobId),
    // Runs are the live signal: a `running` row should become terminal without
    // a manual refresh.
    refetchInterval: 5_000,
  });
}

/**
 * Is the automation engine reachable at all?
 *
 * Distinguishes "no jobs yet" from "the engine is not deployed", which are
 * otherwise the same empty list.
 */
export function useAutomationHealth(agent: SubAgentRow | null | undefined) {
  const {client, accountId} = useAutomationClient(agent);
  return useQuery({
    queryKey: agentKeys.automationHealth(accountId ?? ''),
    queryFn: () => client!.health(),
    enabled: Boolean(client),
    staleTime: 60_000,
    retry: false,
  });
}

/** Exposed so callers can create jobs without re-deriving the client. */
export function useCreateAutomationJob(agent: SubAgentRow | null | undefined) {
  const {client, accountId} = useAutomationClient(agent);
  return {
    accountId,
    enabled: Boolean(client),
    create: (input: CreateJobInput) => {
      if (!client) throw new Error('Automation is not ready: the agent key is locked.');
      return client.createJob(input);
    },
  };
}

/**
 * Stored automation delegates for the signed-in agent's account.
 *
 * Also hands back the client, which registration and revocation need to store or
 * remove the encrypted copy. Listing returns metadata only; the relayer never sends
 * a encrypted key to the browser.
 */
export function useAutomationDelegates(agent: SubAgentRow | null | undefined) {
  const {client, accountId} = useAutomationClient(agent);
  const query = useQuery({
    queryKey: agentKeys.automationDelegates(accountId ?? ''),
    queryFn: () => client!.listDelegates(),
    enabled: Boolean(client),
    staleTime: 30_000,
    retry: false,
  });
  return {query, client, accountId};
}

export type {AutomationJob, AutomationRun};
