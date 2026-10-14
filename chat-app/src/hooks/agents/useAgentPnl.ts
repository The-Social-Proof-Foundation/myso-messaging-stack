import {useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';

import {computeAgentPnl, type AgentPnl} from '../../lib/agents/pnl';
import {fetchAgentReceipts, type TaskReceiptInfo} from '../../lib/agents/social-api';

const PAGE_SIZE = 100;
/** Enough for any agent's history today; a page cap keeps one card from paging forever. */
const MAX_PAGES = 10;
const REFRESH_MS = 60_000;

async function allReceipts(agentObjectId: string, signal?: AbortSignal): Promise<TaskReceiptInfo[]> {
  const out: TaskReceiptInfo[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const {items} = await fetchAgentReceipts(agentObjectId, {limit: PAGE_SIZE, offset: page * PAGE_SIZE, signal});
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * An agent's profit and loss: settled-task earnings and purchases from the indexer's receipts,
 * less the AI credits it has spent. `null` while the receipts load or when they cannot be read, so
 * a card shows a dash rather than a wrong zero.
 */
export function useAgentPnl(
  agentObjectId: string | null | undefined,
  aiSpentMist: bigint | null | undefined,
): AgentPnl | null {
  const receipts = useQuery({
    queryKey: ['agents', 'pnl-receipts', agentObjectId ?? ''],
    enabled: Boolean(agentObjectId),
    refetchInterval: REFRESH_MS,
    staleTime: 20_000,
    queryFn: ({signal}) => allReceipts(agentObjectId!, signal),
  });
  return useMemo(
    () =>
      receipts.data && agentObjectId && aiSpentMist !== undefined && aiSpentMist !== null
        ? computeAgentPnl(receipts.data, agentObjectId, aiSpentMist)
        : null,
    [receipts.data, agentObjectId, aiSpentMist],
  );
}
