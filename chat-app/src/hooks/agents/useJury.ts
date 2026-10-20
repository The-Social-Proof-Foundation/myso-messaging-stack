import {useCallback} from 'react';
import {useQueries, useQuery} from '@tanstack/react-query';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Transaction} from '@socialproof/myso/transactions';

import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useAuthenticatedAddress, useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {resolveAgentChainIds} from '../../lib/agents/chain-ids';
import {executeAsHuman} from '../../lib/agents/execute';
import {sortDuties} from '../../lib/agents/jury';
import {
  fetchJuryHealth,
  fetchJuryRationales,
  fetchJurorAssignments,
  fetchOwnerJurors,
  type SubAgentRow,
} from '../../lib/agents/social-api';
import {joinRosterTx, leaveRosterTx} from '../../lib/agents/tx';
import {agentKeys} from './query-keys';
import {useInvalidateAgents} from './useInvalidateAgents';

/** Roster entries for the signed-in owner's agents. */
export function useOwnerJurors() {
  const principal = useAuthenticatedAddress();
  return useQuery({
    queryKey: agentKeys.ownerJurors(principal ?? ''),
    queryFn: ({signal}) => fetchOwnerJurors(principal!, signal),
    enabled: Boolean(principal),
    refetchInterval: 30_000,
  });
}

/** How many jurors and distinct owners can be drafted, against the floor a dispute needs. */
export function useJuryHealth() {
  return useQuery({
    queryKey: agentKeys.juryHealth(),
    queryFn: fetchJuryHealth,
    refetchInterval: 60_000,
  });
}

/** The reasons behind a case's revealed votes. Only worth asking once jurors are voting. */
export function useJuryRationales(caseId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: agentKeys.juryRationales(caseId ?? ''),
    queryFn: () => fetchJuryRationales(caseId!),
    enabled: Boolean(caseId) && enabled,
    // A reason is published a little after its reveal.
    refetchInterval: 30_000,
  });
}

/** Open duties across the given juror agents, soonest deadline first. */
export function useJurorDuties(agentIds: readonly string[]) {
  const results = useQueries({
    queries: agentIds.map((agentId) => ({
      queryKey: agentKeys.jurorDuties(agentId),
      queryFn: ({signal}: {signal: AbortSignal}) => fetchJurorAssignments(agentId, signal),
      // A duty has a deadline of hours, so a minute is fresh enough.
      refetchInterval: 60_000,
    })),
  });
  const duties = sortDuties(results.flatMap((r) => r.data ?? []));
  return {duties, isLoading: results.some((r) => r.isLoading), isError: results.some((r) => r.isError)};
}

/** Joining and leaving the roster is the owner's wallet, free of any deposit. */
export function useJuryActions() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const principal = useAuthenticatedAddress();
  const invalidate = useInvalidateAgents();

  const execute = useCallback(
    async (build: (ids: Awaited<ReturnType<typeof resolveAgentChainIds>>) => Transaction) => {
      if (!client || !keypair) throw new Error('Sign in before joining the jury roster.');
      const ids = await resolveAgentChainIds();
      const digest = await executeAsHuman(client as ClientWithCoreApi, keypair, build(ids));
      await invalidate();
      return digest;
    },
    [client, keypair, invalidate],
  );

  return {
    joinRoster: (agent: SubAgentRow, modelFamily: number) => {
      if (!principal) throw new Error('Sign in before joining the jury roster.');
      return execute((ids) =>
        joinRosterTx(ids, {
          accountId: agent.account_id,
          agentId: agent.agent_object_id,
          payoutAddress: principal,
          modelFamily,
        }),
      );
    },
    leaveRoster: (agent: SubAgentRow) =>
      execute((ids) =>
        leaveRosterTx(ids, {accountId: agent.account_id, agentId: agent.agent_object_id}),
      ),
  };
}
