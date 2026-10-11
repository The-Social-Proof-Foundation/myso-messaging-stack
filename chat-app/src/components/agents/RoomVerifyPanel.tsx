import {useMemo} from 'react';
import {ShieldAlert, ShieldCheck, ShieldQuestion} from 'lucide-react';

import {useGroupDigests} from '../../hooks/agents';
import {
  matchDigestsToMessages,
  summarizeVerification,
  type DigestVerificationRow,
  type VerifiableMessage,
} from '../../lib/agents/rooms';
import {truncateAddress} from '../../lib/agents/format';
import {ListError, LoadMoreRow} from './ListStates';

interface RoomVerifyPanelProps {
  groupId: string;
  /** Messages already loaded in the open thread; matched to digests by sender and time. */
  messages: readonly VerifiableMessage[];
}

function statusOf(row: DigestVerificationRow) {
  if (row.matchedMessageId === null) {
    return {
      Icon: ShieldQuestion,
      label: 'Not in this view',
      tone: 'text-secondary-400 dark:text-secondary-500',
    };
  }
  return row.senderVerified
    ? {Icon: ShieldCheck, label: 'Sender verified', tone: 'text-emerald-600 dark:text-emerald-400'}
    : {Icon: ShieldAlert, label: 'Signature mismatch', tone: 'text-danger-500 dark:text-danger-400'};
}

/**
 * Chain-anchored message digests for a room, set against the messages loaded in the thread.
 *
 * It shows that each digest exists on-chain at its sequence from its sender, and whether the
 * SDK verified the sender's signature on the matching message. It does not recompute content
 * hashes (only members hold the plaintext), and says so.
 */
export function RoomVerifyPanel({groupId, messages}: Readonly<RoomVerifyPanelProps>) {
  const digests = useGroupDigests(groupId);
  const rows = useMemo(
    () => matchDigestsToMessages(digests.digests, messages),
    [digests.digests, messages],
  );
  const summary = useMemo(() => summarizeVerification(rows), [rows]);

  return (
    <details className="shrink-0 border-t border-secondary-200 text-xs dark:border-secondary-700">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2 text-secondary-600 dark:text-secondary-300">
        <ShieldCheck className="h-4 w-4" strokeWidth={2} aria-hidden />
        <span className="font-medium">Verify room</span>
        <span className="text-secondary-400 dark:text-secondary-500">
          {digests.isInitialLoading
            ? 'Loading…'
            : `${summary.total} on-chain · ${summary.verified} verified${
                summary.failed > 0 ? ` · ${summary.failed} mismatched` : ''
              }`}
        </span>
      </summary>

      <div className="max-h-64 overflow-y-auto border-t border-secondary-100 dark:border-secondary-800">
        {digests.isError ? (
          <ListError error={digests.error} onRetry={digests.refetch} />
        ) : rows.length === 0 && !digests.isInitialLoading ? (
          <p className="px-4 py-3 text-secondary-500 dark:text-secondary-400">
            No on-chain digests for this room yet.
          </p>
        ) : (
          <ul>
            {rows.map((row) => {
              const {Icon, label, tone} = statusOf(row);
              return (
                <li
                  key={row.seq}
                  className="flex items-center gap-2 border-b border-secondary-100 px-4 py-1.5 last:border-b-0 dark:border-secondary-800"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} strokeWidth={2} aria-label={label} />
                  <span className="w-8 shrink-0 tabular-nums text-secondary-500">#{row.seq}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {truncateAddress(row.sender)}
                    <span className="ml-2 font-mono text-secondary-400" title={row.contentDigest}>
                      {row.contentDigest.slice(0, 10)}…
                    </span>
                  </span>
                  <span className={`shrink-0 ${tone}`}>{label}</span>
                </li>
              );
            })}
          </ul>
        )}
        <LoadMoreRow list={digests} showCompleteCount={false} />
        <p className="px-4 py-2 text-[11px] text-secondary-400 dark:text-secondary-500">
          Digests are anchored on-chain by the sender. Content hashes are not recomputed here.
        </p>
      </div>
    </details>
  );
}
