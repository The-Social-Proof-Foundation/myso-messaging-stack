import type {CollectResult} from '../pagination';
import type {SubAgentRow} from './social-api';

function sameAgent(left: string, right: string): boolean {
  return left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase();
}

/**
 * Inserts a just-created agent into the chart's full agent list.
 *
 * Registration invalidates that list immediately, and the indexer often has not
 * recorded the new object yet, so the refetch comes back without it. Seeding the
 * row we already know keeps the card on screen until the indexed row replaces it.
 */
export function upsertCollectedSubAgent(
  current: CollectResult<SubAgentRow> | undefined,
  row: SubAgentRow,
): CollectResult<SubAgentRow> {
  const items = current?.items ?? [];
  const index = items.findIndex((item) => sameAgent(item.agent_object_id, row.agent_object_id));
  const nextItems =
    index === -1
      ? [...items, row]
      : items.map((item, itemIndex) => (itemIndex === index ? {...item, ...row} : item));
  const added = index === -1 ? 1 : 0;
  const totalCount =
    current?.totalCount == null ? nextItems.length : current.totalCount + added;

  return {
    items: nextItems,
    totalCount,
    complete: current?.complete ?? true,
    reason: current?.reason ?? 'short-page',
    pages: current?.pages ?? 1,
    partialError: current?.partialError ?? null,
  };
}
