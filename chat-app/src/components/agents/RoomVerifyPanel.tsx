import {useMemo} from 'react';
import {Anchor, ChevronRight, ShieldAlert, ShieldCheck, ShieldQuestion} from 'lucide-react';

import {useGroupDigests} from '../../hooks/agents';
import {
  matchDigestsToMessages,
  summarizeVerification,
  type DigestVerificationRow,
  type VerifiableMessage,
} from '../../lib/agents/rooms';
import {transactionDigestOf} from '../../lib/agents/anchor';
import {truncateAddress} from '../../lib/agents/format';
import {ListError, LoadMoreRow} from './ListStates';

interface RoomVerifyPanelProps {
  groupUuid: string;
  groupId: string;
  /** Messages already loaded in the open thread; matched to digests by message id, else by sender and time. */
  messages: readonly VerifiableMessage[];
  /** Display name for a sender address; used in the row tooltip. */
  labelFor?: (address: string) => string;
  /** Jump to a matched message in the thread. Rows with no loaded message are not clickable. */
  onSelectMessage?: (messageId: string) => void;
}

/** The icon carries the status: green when verified, red when it is not, gray when it cannot be checked. */
function statusOf(row: DigestVerificationRow) {
  if (row.matchedMessageId === null) {
    return {
      Icon: ShieldQuestion,
      detail: 'Not checked: this message is not in the part of the thread that is loaded.',
      tone: 'text-secondary-400 dark:text-secondary-500',
    };
  }
  if (row.contentVerified === false) {
    return {
      Icon: ShieldAlert,
      detail: 'Mismatch: the message text no longer hashes to the on-chain digest.',
      tone: 'text-danger-500 dark:text-danger-400',
    };
  }
  if (!row.senderVerified) {
    return {
      Icon: ShieldAlert,
      detail: "Bad signature: the sender's signature on this message did not verify.",
      tone: 'text-danger-500 dark:text-danger-400',
    };
  }
  if (row.contentVerified !== true) return {
    Icon: ShieldQuestion,
    detail: 'Signature checked. The message text is unavailable, so its on-chain content hash has not been verified.',
    tone: 'text-secondary-400 dark:text-secondary-500',
  };
  return {
    Icon: ShieldCheck,
    detail: 'Verified: signed by the sender, and the text matches the on-chain digest.',
    tone: 'text-emerald-500 dark:text-emerald-400',
  };
}

const shortHash = (hex: string) => (hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex);

/**
 * Chain-anchored message digests for a room, set against the messages loaded in the thread, in
 * the same card style as the member list.
 */
export function RoomVerifyPanel({
  groupUuid,
  groupId,
  messages,
  labelFor,
  onSelectMessage,
}: Readonly<RoomVerifyPanelProps>) {
  const digests = useGroupDigests(groupId);
  const rows = useMemo(
    () => matchDigestsToMessages(digests.digests, messages, {groupUuid}),
    [digests.digests, messages, groupUuid],
  );
  const summary = useMemo(() => summarizeVerification(rows), [rows]);

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="font-chakra mb-2 text-sm font-medium capitalize tracking-wide text-secondary-500 dark:text-secondary-400">
        Message anchors ({digests.isInitialLoading && rows.length === 0 ? '…' : summary.total})
        {summary.verified > 0 && <span className="ml-2 text-emerald-500 dark:text-emerald-400">{summary.verified} verified</span>}
        {summary.unchecked > 0 && <span className="ml-2">{summary.unchecked} unchecked</span>}
        {summary.failed > 0 && (
          <span className="ml-2 text-danger-500 dark:text-danger-400">{summary.failed} failed</span>
        )}
      </h4>

      {digests.isError ? (
        <ListError error={digests.error} onRetry={digests.refetch} />
      ) : rows.length === 0 && !digests.isInitialLoading ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-secondary-200 bg-secondary-100 px-6 py-7 text-center dark:border-secondary-700 dark:bg-secondary-800">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary-200/70 text-secondary-400 dark:bg-secondary-700/70 dark:text-secondary-500">
            <Anchor className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <p className="text-[13px] font-medium text-secondary-700 dark:text-secondary-200">
            Nothing anchored yet
          </p>
          <p className="max-w-[16rem] text-[11.5px] leading-relaxed text-secondary-400 dark:text-secondary-500">
            Tap the shield beside an agent's message to publish its fingerprint on-chain. The message
            itself stays private in this chat.
          </p>
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
          {rows.map((row) => {
            const {Icon, detail, tone} = statusOf(row);
            const jump = row.matchedMessageId && onSelectMessage ? row.matchedMessageId : null;
            const sender = labelFor?.(row.sender) ?? truncateAddress(row.sender);
            const title = `${sender}\n${detail}\nTransaction ${transactionDigestOf(row.transactionId)}\nAnchored ${new Date(row.createdAtMs).toLocaleString()}${
              jump ? '\nClick to jump to the message.' : ''
            }`;
            const body = (
              <>
                {/* h-6 box matches the member row avatar so row heights line up. */}
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <Icon className={`h-4 w-4 ${tone}`} strokeWidth={2} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="tabular-nums text-secondary-400 dark:text-secondary-500">#{row.seq}</span>
                  <span className="min-w-0 truncate font-mono text-secondary-700 dark:text-secondary-300">
                    {shortHash(row.contentDigest)}
                  </span>
                </span>
                {jump ? <ChevronRight className="h-4 w-4 shrink-0 text-secondary-400" aria-hidden /> : null}
              </>
            );
            const rowClass = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs';
            return (
              <li key={row.seq} className="border-b border-secondary-200 last:border-b-0 dark:border-secondary-700">
                {jump ? (
                  <button
                    type="button"
                    onClick={() => onSelectMessage?.(jump)}
                    title={title}
                    className={`${rowClass} text-secondary-700 transition-colors hover:bg-secondary-200/80 dark:text-secondary-300 dark:hover:bg-secondary-700`}
                  >
                    {body}
                  </button>
                ) : (
                  <div title={title} className={`${rowClass} text-secondary-500 dark:text-secondary-400`}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <LoadMoreRow list={digests} showCompleteCount={false} />
    </section>
  );
}
