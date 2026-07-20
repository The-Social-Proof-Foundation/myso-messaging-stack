import { useState } from 'react';

interface GroupActionsSectionProps {
  canRotateKey: boolean;
  canArchive: boolean;
  actionError: string | null;
  onRotateKey: () => Promise<void>;
  onArchive: () => Promise<void>;
  onLeave: () => Promise<void>;
  leaving?: boolean;
  leaveError?: string | null;
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
}: Readonly<GroupActionsSectionProps>) {
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  async function handleArchive() {
    setArchiving(true);
    try {
      await onArchive();
      setShowArchiveConfirm(false);
    } finally {
      setArchiving(false);
    }
  }

  async function handleLeave() {
    try {
      await onLeave();
      setShowLeaveConfirm(false);
    } catch {
      // Parent surfaces leaveError
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

      {canArchive &&
        (showArchiveConfirm ? (
          <div className="mb-2 rounded-lg border border-danger-300 p-3 dark:border-danger-700">
            <p className="mb-2 text-xs text-danger-600 dark:text-danger-400">
              This action is permanent. The group will be paused and no new
              messages can be sent.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowArchiveConfirm(false)}
                disabled={archiving}
                className="flex-1 rounded py-1 text-xs text-secondary-500 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleArchive}
                disabled={archiving}
                className="flex-1 rounded bg-danger-500 py-1 text-xs font-medium text-white hover:bg-danger-600 disabled:opacity-50"
              >
                {archiving ? 'Archiving...' : 'Confirm Archive'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowArchiveConfirm(true)}
            className="mb-2 w-full rounded-lg bg-[#E6E3EA] py-2 text-xs font-medium text-[#2D2D32] hover:bg-[#DDD9E4] active:bg-[#D2CDD9] dark:bg-[#3D3A45] dark:text-white dark:hover:bg-[#494653] dark:active:bg-[#34313B]"
          >
            Archive Group
          </button>
        ))}

      {showLeaveConfirm ? (
        <div className="rounded-lg border border-danger-300 p-3 dark:border-danger-700">
          <p className="mb-2 text-xs text-danger-600 dark:text-danger-400">
            Leave this group? You will no longer receive messages here.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowLeaveConfirm(false)}
              disabled={leaving}
              className="flex-1 rounded py-1 text-xs text-secondary-500 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleLeave()}
              disabled={leaving}
              className="flex-1 rounded bg-danger-500 py-1 text-xs font-medium text-white hover:bg-danger-600 disabled:opacity-50"
            >
              {leaving ? 'Leaving...' : 'Confirm Leave'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowLeaveConfirm(true)}
          disabled={leaving}
          className="w-full rounded-lg bg-[#C97A7A] py-2 text-xs font-medium text-white hover:bg-[#D58787] active:bg-[#B96C6C] disabled:opacity-50 dark:bg-[#9A5C5C] dark:hover:bg-[#A96969] dark:active:bg-[#875050]"
        >
          Leave Group
        </button>
      )}

      {(actionError || leaveError) && (
        <p className="mt-2 text-xs text-danger-500 dark:text-danger-400">
          {leaveError || actionError}
        </p>
      )}
    </section>
  );
}
