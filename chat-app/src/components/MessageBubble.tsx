import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type {
  Message,
  AttachmentHandle,
  RelayerReactionEntry,
} from '../hooks/useMessages';

/** Basic reaction palette shown in the left-click picker. */
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface MessageBubbleProps {
  message: Message;
  isOwnMessage: boolean;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  /** Reaction entries for this message (keyed by relayer order upstream). */
  reactions?: RelayerReactionEntry[];
  /** When provided, left-clicking the bubble opens the reaction picker. */
  onToggleReaction?: (order: number, emoji: string) => Promise<void>;
  /** Used to highlight reactions the current user has set. */
  myAddress?: string;
}

/** Format Unix timestamp (seconds) to a short relative/absolute time string. */
function formatTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateAddress(address: string): string {
  if (!address) return 'unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentItem({
  handle,
  isOwnMessage,
}: Readonly<{
  handle: AttachmentHandle;
  isOwnMessage: boolean;
}>) {
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const isImage = handle.mimeType.startsWith('image/');

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(false);
    try {
      const data = await handle.data();
      const blob = new Blob([new Uint8Array(data)], { type: handle.mimeType });
      const url = URL.createObjectURL(blob);

      // For images, show inline preview
      if (isImage) {
        setPreviewUrl(url);
        // Don't revoke — the img element needs it
      } else {
        // Trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = handle.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Failed to download attachment:', err);
      setError(true);
    } finally {
      setDownloading(false);
    }
  }, [handle, isImage]);

  return (
    <div className="mt-1.5">
      {/* Image preview */}
      {previewUrl && isImage && (
        <img
          src={previewUrl}
          alt={handle.fileName}
          className="mb-1 max-h-48 rounded-lg object-contain"
        />
      )}
      <div
        className={`flex items-center gap-2 rounded-lg p-1.5 text-xs ${
          isOwnMessage
            ? 'bg-white/10'
            : 'bg-secondary-200/50 dark:bg-secondary-600/50'
        }`}
      >
        <span className="truncate font-medium" title={handle.fileName}>
          {handle.fileName}
        </span>
        <span
          className={
            isOwnMessage
              ? 'text-primary-200'
              : 'text-secondary-400 dark:text-secondary-500'
          }
        >
          {formatSize(handle.fileSize)}
        </span>

        {error ? (
          <span className="text-danger-400">failed</span>
        ) : (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium ${
              isOwnMessage
                ? 'text-white/80 hover:text-white disabled:opacity-50'
                : 'text-primary-500 hover:text-primary-600 disabled:opacity-50'
            }`}
            title={isImage && !previewUrl ? 'Preview' : 'Download'}
          >
            {downloading && '...'}
            {!downloading && isImage && !previewUrl && 'View'}
            {!downloading && !(isImage && !previewUrl) && '↓'}
          </button>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  isOwnMessage,
  onEdit,
  onDelete,
  reactions,
  onToggleReaction,
  myAddress,
}: Readonly<MessageBubbleProps>) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Wraps bubble + picker so bubble clicks toggle without racing outside-close.
  const bubbleWrapperRef = useRef<HTMLDivElement>(null);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.setSelectionRange(editText.length, editText.length);
    }
  }, [editing, editText.length]);

  // Close the reaction picker on outside click or Escape
  useEffect(() => {
    if (!showReactionPicker) return;

    function handleMouseDown(e: globalThis.MouseEvent) {
      if (
        bubbleWrapperRef.current &&
        !bubbleWrapperRef.current.contains(e.target as Node)
      ) {
        setShowReactionPicker(false);
      }
    }
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setShowReactionPicker(false);
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showReactionPicker]);

  const handleBubbleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onToggleReaction || editing) return;
      // Ignore clicks on interactive elements (attachment buttons, links, ...).
      const target = e.target as HTMLElement;
      if (target.closest('button, a, textarea, input, img')) return;
      setShowReactionPicker((open) => !open);
    },
    [onToggleReaction, editing],
  );

  const handlePickEmoji = useCallback(
    (emoji: string) => {
      setShowReactionPicker(false);
      // Errors surface via the hook's error banner; state reverts there.
      onToggleReaction?.(message.order, emoji).catch(() => {});
    },
    [onToggleReaction, message.order],
  );

  if (message.isDeleted) {
    return (
      <div className="flex justify-center py-1">
        <span className="text-xs italic text-secondary-400 dark:text-secondary-500">
          Message deleted
        </span>
      </div>
    );
  }

  async function handleSaveEdit() {
    if (!onEdit || saving) return;
    const trimmed = editText.trim();
    if (!trimmed || trimmed === message.text) {
      setEditing(false);
      setEditText(message.text);
      return;
    }

    setSaving(true);
    try {
      await onEdit(message.messageId, trimmed);
      setEditing(false);
    } catch {
      // Error is handled in the hook; keep edit mode open
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    setEditing(false);
    setEditText(message.text);
  }

  function handleEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit().then();
    }
    if (e.key === 'Escape') {
      handleCancelEdit();
    }
  }

  async function handleDelete() {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(message.messageId);
      setShowDeleteConfirm(false);
    } catch {
      // Error is handled in the hook
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className={`group flex min-w-0 max-w-full px-4 py-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
    >
      <div ref={bubbleWrapperRef} className="relative min-w-0 max-w-[70%] shrink">
        {/* Action buttons (visible on hover, own messages only) */}
        {isOwnMessage && !editing && (onEdit || onDelete) && (
          <div className="absolute -top-3 right-2 z-10 hidden rounded-lg border border-secondary-200 bg-white shadow-sm group-hover:flex dark:border-secondary-600 dark:bg-secondary-700">
            {onEdit && (
              <button
                onClick={() => {
                  setEditText(message.text);
                  setEditing(true);
                }}
                className="px-2 py-1 text-xs text-secondary-500 hover:text-primary-500 dark:text-secondary-400 dark:hover:text-primary-400"
                title="Edit"
              >
                ✎
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-2 py-1 text-xs text-secondary-500 hover:text-danger-500 dark:text-secondary-400 dark:hover:text-danger-400"
                title="Delete"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div
          onClick={handleBubbleClick}
          className={`max-w-full overflow-hidden rounded-2xl px-4 py-2 ${
            onToggleReaction && !editing ? 'cursor-pointer' : ''
          } ${
            isOwnMessage
              ? 'bg-primary-500 text-white'
              : 'bg-secondary-100 text-secondary-900 dark:bg-secondary-700 dark:text-secondary-100'
          }`}
        >
          {/* Sender (only for other people's messages) */}
          {!isOwnMessage && message.senderAddress && (
            <p className="mb-0.5 text-xs font-medium text-secondary-500 dark:text-secondary-400">
              {truncateAddress(message.senderAddress)}
              {message.isAgentMessage && (
                <span
                  className="ml-1 rounded bg-secondary-200/80 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-600 dark:bg-secondary-600/80 dark:text-secondary-200"
                  title={
                    message.principalOwner
                      ? `Agent of ${truncateAddress(message.principalOwner)}`
                      : 'Agent message'
                  }
                >
                  Agent
                </span>
              )}
              {message.senderVerified && (
                <span className="ml-1 text-green-500 dark:text-green-400" title="Sender verified">
                  ✓
                </span>
              )}
            </p>
          )}

          {/* Message text or edit form */}
          {editing ? (
            <div className="space-y-2">
              <textarea
                ref={editRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleEditKeyDown}
                rows={2}
                disabled={saving}
                className="w-full max-w-full resize-none break-all rounded-lg border border-primary-300 bg-white px-2 py-1 text-sm text-secondary-900 focus:outline-none focus:ring-1 focus:ring-primary-300 disabled:opacity-50 dark:bg-secondary-800 dark:text-secondary-100"
              />
              <div className="flex justify-end gap-1">
                <button
                  onClick={handleCancelEdit}
                  disabled={saving}
                  className="rounded px-2 py-0.5 text-xs text-primary-200 hover:text-white disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={saving || !editText.trim()}
                  className="rounded bg-white/20 px-2 py-0.5 text-xs font-medium text-white hover:bg-white/30 disabled:opacity-50"
                >
                  {saving ? '...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <>
              {message.text && (
                <p className="text-sm break-all whitespace-pre-wrap">
                  {message.text}
                </p>
              )}
            </>
          )}

          {/* Attachments */}
          {message.attachments?.length > 0 && (
            <div className="space-y-1">
              {message.attachments.map((handle, i) => (
                <AttachmentItem
                  key={`${handle.fileName}-${i}`}
                  handle={handle}
                  isOwnMessage={isOwnMessage}
                />
              ))}
            </div>
          )}

          {/* Footer: time + edited badge */}
          <div
            className={`mt-1 flex items-center gap-1 text-xs ${
              isOwnMessage
                ? 'text-primary-200'
                : 'text-secondary-400 dark:text-secondary-500'
            }`}
          >
            <span>{formatTime(message.createdAt)}</span>
            {message.isEdited && <span className="italic">(edited)</span>}
            {message.senderVerified && isOwnMessage && (
              <span title="Sender verified">✓</span>
            )}
            {/* Sync status badge (CHAT-053) */}
            {isOwnMessage && message.syncStatus === 'SYNC_PENDING' && (
              <span title="Sending...">○</span>
            )}
            {isOwnMessage && message.syncStatus === 'SYNCED' && (
              <span title="Delivered">●</span>
            )}
          </div>
        </div>

        {/* Reaction chips */}
        {reactions && reactions.length > 0 && (
          <div
            className={`mt-1 flex flex-wrap gap-1 ${
              isOwnMessage ? 'justify-end' : 'justify-start'
            }`}
          >
            {reactions.map((entry) => {
              const mine = myAddress
                ? entry.reactors.includes(myAddress)
                : false;
              return (
                <button
                  key={entry.emoji}
                  onClick={() => handlePickEmoji(entry.emoji)}
                  disabled={!onToggleReaction}
                  title={
                    mine
                      ? 'You reacted — click to remove'
                      : 'Click to react'
                  }
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    mine
                      ? 'border-primary-400 bg-primary-100 text-primary-700 dark:border-primary-500 dark:bg-primary-900/40 dark:text-primary-300'
                      : 'border-secondary-200 bg-white text-secondary-600 hover:bg-secondary-100 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-300 dark:hover:bg-secondary-600'
                  } ${onToggleReaction ? '' : 'cursor-default'}`}
                >
                  <span>{entry.emoji}</span>
                  <span className="font-medium">{entry.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Reaction picker popover (left-click on bubble) */}
        {showReactionPicker && onToggleReaction && (
          <div
            className={`absolute -top-11 z-20 flex gap-0.5 rounded-full border border-secondary-200 bg-white px-2 py-1 shadow-lg dark:border-secondary-600 dark:bg-secondary-700 ${
              isOwnMessage ? 'right-0' : 'left-0'
            }`}
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handlePickEmoji(emoji)}
                title={`React with ${emoji}`}
                className="rounded-full px-1.5 py-0.5 text-base transition-transform hover:scale-125 hover:bg-secondary-100 dark:hover:bg-secondary-600"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {/* Delete confirmation popover */}
        {showDeleteConfirm && (
          <div className="absolute -top-16 right-0 z-20 rounded-lg border border-secondary-200 bg-white p-3 shadow-lg dark:border-secondary-600 dark:bg-secondary-700">
            <p className="mb-2 text-xs text-secondary-600 dark:text-secondary-300">
              Delete this message?
            </p>
            <div className="flex justify-end gap-1">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="rounded px-2 py-0.5 text-xs text-secondary-500 hover:text-secondary-700 disabled:opacity-50 dark:text-secondary-400 dark:hover:text-secondary-200"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded bg-danger-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-danger-600 disabled:opacity-50"
              >
                {deleting ? '...' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
