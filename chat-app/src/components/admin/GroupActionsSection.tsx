import { useState } from 'react';
import {
  REPORT_NOTE_MAX_CHARS,
  REPORT_REASONS,
  threadSafetyActions,
  type ReportReason,
} from '../../lib/report-conversation';
import { HoldSignOutButton } from '../HoldSignOutButton';

const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  scam: 'Scam',
  other: 'Other',
};

interface GroupActionsSectionProps {
  canRotateKey: boolean;
  canArchive: boolean;
  actionError: string | null;
  onRotateKey: () => Promise<void>;
  onArchive: () => Promise<void>;
  onLeave: () => Promise<void>;
  leaving?: boolean;
  leaveError?: string | null;
  /**
   * 1:1 peer while members are loaded. `null` is a group.
   * `undefined` means membership is still loading.
   */
  peerAddress?: string | null;
  onReport: (input: { reason: ReportReason; note?: string }) => Promise<void>;
  onBlock: () => Promise<void>;
}

export function GroupActionsSection({
  canRotateKey,
  canArchive,
  actionError,
  onRotateKey,
  onArchive,
  onLeave,
  leaving = false,
  leaveError = null,
  peerAddress,
  onReport,
  onBlock,
}: Readonly<GroupActionsSectionProps>) {
  const [archiving, setArchiving] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reason, setReason] = useState<ReportReason>('spam');
  const [note, setNote] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  const safety =
    peerAddress === undefined ? null : threadSafetyActions(peerAddress);

  async function handleArchive() {
    setArchiving(true);
    try {
      await onArchive();
    } finally {
      setArchiving(false);
    }
  }

  async function handleLeave() {
    try {
      await onLeave();
    } catch {
      // Parent surfaces leaveError
    }
  }

  async function handleReport() {
    setReporting(true);
    setReportError(null);
    try {
      await onReport({
        reason,
        note: reason === 'other' ? note : undefined,
      });
      setShowReport(false);
      setNote('');
      setReportSent(true);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'Failed to send report.');
    } finally {
      setReporting(false);
    }
  }

  async function handleBlock() {
    setBlocking(true);
    setBlockError(null);
    try {
      await onBlock();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : 'Failed to block this person.');
    } finally {
      setBlocking(false);
    }
  }

  return (
    <section className="p-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Group Actions
      </h4>

      {canRotateKey && (
        <button
          type="button"
          onClick={onRotateKey}
          className="mb-2 w-full rounded-lg border border-secondary-300 py-1.5 text-xs font-medium text-secondary-700 hover:bg-secondary-50 dark:border-secondary-600 dark:text-secondary-300 dark:hover:bg-secondary-700"
        >
          Rotate Encryption Key
        </button>
      )}

      {canArchive && (
        <HoldSignOutButton
          text={archiving ? 'Archiving...' : 'Archive Group'}
          icon={null}
          disabled={archiving}
          accentOnHold={false}
          contentClassName="justify-center"
          className="mb-2 rounded-lg bg-[#E6E3EA] py-2 text-xs font-medium text-[#2D2D32] hover:bg-[#DDD9E4] active:bg-[#D2CDD9] dark:bg-[#3D3A45] dark:text-white dark:hover:bg-[#494653] dark:active:bg-[#34313B]"
          progressBarClassName="bg-black/15 dark:bg-white/25"
          onConfirm={() => void handleArchive()}
        />
      )}

      {safety?.report &&
        (showReport ? (
          <div className="mb-2 rounded-lg border border-secondary-300 p-3 dark:border-secondary-600">
            <p className="mb-2 text-xs text-secondary-600 dark:text-secondary-300">
              This report includes who, which chat, when, and the reason. It
              does not include messages.
            </p>
            <div className="mb-2 flex flex-col gap-1">
              {REPORT_REASONS.map((option) => (
                <label
                  key={option}
                  className="flex items-center gap-2 text-xs text-secondary-700 dark:text-secondary-200"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={option}
                    checked={reason === option}
                    onChange={() => setReason(option)}
                  />
                  {REPORT_REASON_LABELS[option]}
                </label>
              ))}
            </div>
            {reason === 'other' && (
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={REPORT_NOTE_MAX_CHARS}
                rows={3}
                placeholder="Short reason"
                className="mb-2 w-full resize-none rounded-lg border border-secondary-300 bg-white px-2 py-1.5 text-xs text-secondary-800 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-100"
              />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowReport(false);
                  setReportError(null);
                }}
                disabled={reporting}
                className="flex-1 rounded py-1 text-xs text-secondary-500 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleReport()}
                disabled={reporting}
                className="flex-1 rounded bg-danger-500 py-1 text-xs font-medium text-white hover:bg-danger-600 disabled:opacity-50"
              >
                {reporting ? 'Sending...' : 'Send report'}
              </button>
            </div>
            {reportError && (
              <p className="mt-2 text-xs text-danger-500 dark:text-danger-400">
                {reportError}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowReport(true);
              setReportSent(false);
              setReportError(null);
            }}
            className="mb-2 w-full rounded-lg border border-secondary-300 py-1.5 text-xs font-medium text-secondary-700 hover:bg-secondary-50 dark:border-secondary-600 dark:text-secondary-300 dark:hover:bg-secondary-700"
          >
            {reportSent ? 'Report sent' : 'Report'}
          </button>
        ))}

      {safety?.block && (
        <HoldSignOutButton
          text={blocking ? 'Blocking...' : 'Block'}
          icon={null}
          disabled={blocking}
          accentOnHold={false}
          contentClassName="justify-center"
          className="mb-2 rounded-lg bg-[#C97A7A] py-2 text-xs font-medium text-white hover:bg-[#D58787] active:bg-[#B96C6C] dark:bg-[#9A5C5C] dark:hover:bg-[#A96969] dark:active:bg-[#875050]"
          progressBarClassName="bg-black/15 dark:bg-white/25"
          onConfirm={() => void handleBlock()}
        />
      )}

      {safety?.leave && (
        <HoldSignOutButton
          text={leaving ? 'Leaving...' : 'Leave Group'}
          icon={null}
          disabled={leaving}
          accentOnHold={false}
          contentClassName="justify-center"
          className="rounded-lg bg-[#C97A7A] py-2 text-xs font-medium text-white hover:bg-[#D58787] active:bg-[#B96C6C] dark:bg-[#9A5C5C] dark:hover:bg-[#A96969] dark:active:bg-[#875050]"
          progressBarClassName="bg-black/15 dark:bg-white/25"
          onConfirm={() => void handleLeave()}
        />
      )}

      {(actionError || leaveError || blockError) && (
        <p className="mt-2 text-xs text-danger-500 dark:text-danger-400">
          {leaveError || blockError || actionError}
        </p>
      )}
    </section>
  );
}
