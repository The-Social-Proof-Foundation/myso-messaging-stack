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
import { ReservationNavAvatar } from './ReservationNavAvatar';

/** Basic reaction palette shown in the left-click picker. */
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const AVATAR_SIZE = 28;
/** Pull the bubble + meta stack under the avatar corner. */
const AVATAR_OVERLAP_PX = 14;

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
  /** Anchor reaction picker/delete below the bubble (avoids clipping on first row). */
  preferReactionBelow?: boolean;
  /** First message in a consecutive same-sender run. */
  isFirstInGroup?: boolean;
  /** Last message in a consecutive same-sender run. */
  isLastInGroup?: boolean;
  /** Profile photo URL for the sender; falls back to default avatar. */
  avatarSrc?: string | null;
  /** Resolve a display label (username / name / truncated address) for a wallet. */
  labelForAddress?: (address: string) => string;
}

/** iMessage-style corner radii for clustered same-sender bubbles. */
function bubbleRadiusClass(
  isOwnMessage: boolean,
  isFirstInGroup: boolean,
  isLastInGroup: boolean,
): string {
  const alone = isFirstInGroup && isLastInGroup;
  if (alone) return 'rounded-[18px]';

  if (isOwnMessage) {
    if (isFirstInGroup && !isLastInGroup) {
      return 'rounded-[18px] rounded-br-[4px]';
    }
    if (!isFirstInGroup && !isLastInGroup) {
      return 'rounded-[18px] rounded-r-[4px]';
    }
    // last in group
    return 'rounded-[18px] rounded-tr-[4px]';
  }

  if (isFirstInGroup && !isLastInGroup) {
    return 'rounded-[18px] rounded-bl-[4px]';
  }
  if (!isFirstInGroup && !isLastInGroup) {
    return 'rounded-[18px] rounded-l-[4px]';
  }
  return 'rounded-[18px] rounded-tl-[4px]';
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
              ? 'text-bubble-sent-meta'
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
                : 'text-bubble-sent hover:text-bubble-sent-dark disabled:opacity-50'
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
  preferReactionBelow = false,
  isFirstInGroup = true,
  isLastInGroup = true,
  avatarSrc = null,
  labelForAddress,
}: Readonly<MessageBubbleProps>) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  /** Only one reaction-chip tooltip at a time (also suppresses the picker). */
  const [hoveredReactionEmoji, setHoveredReactionEmoji] = useState<
    string | null
  >(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Wraps bubble + picker so outside-close / hover leave don't race.
  const bubbleWrapperRef = useRef<HTMLDivElement>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredReactionRef = useRef<string | null>(null);
  const radiusClass = bubbleRadiusClass(
    isOwnMessage,
    isFirstInGroup,
    isLastInGroup,
  );
  // Chips always sit opposite the avatar at the top of the bubble.
  // First-message picker/delete go below so they aren't clipped by the scroll edge.
  const reactionAnchorClass = isOwnMessage
    ? '-top-4 -left-3'
    : '-top-4 -right-3';
  const popoverVerticalClass = preferReactionBelow
    ? 'top-full mt-1'
    : '-top-11';
  const deletePopoverVerticalClass = preferReactionBelow
    ? 'top-full mt-1'
    : '-top-16';

  /** Desktop / iPad with hover — open picker on hover; phones use tap. */
  const canHover = useCallback(() => {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    );
  }, []);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.setSelectionRange(editText.length, editText.length);
    }
  }, [editing, editText.length]);

  useEffect(() => {
    return () => {
      if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    };
  }, []);

  // Close the reaction picker on outside click or Escape (mobile tap path)
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

  const openReactionPicker = useCallback(() => {
    if (!onToggleReaction || editing) return;
    if (hoveredReactionRef.current) return;
    if (hoverLeaveTimerRef.current) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setShowReactionPicker(true);
  }, [onToggleReaction, editing]);

  const scheduleCloseReactionPicker = useCallback(() => {
    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    hoverLeaveTimerRef.current = setTimeout(() => {
      setShowReactionPicker(false);
      hoveredReactionRef.current = null;
      setHoveredReactionEmoji(null);
      hoverLeaveTimerRef.current = null;
    }, 120);
  }, []);

  const handleBubbleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onToggleReaction || editing) return;
      // Desktop hover path — ignore click so hover owns open/close.
      if (canHover()) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, a, textarea, input, img')) return;
      hoveredReactionRef.current = null;
      setHoveredReactionEmoji(null);
      setShowReactionPicker((open) => !open);
    },
    [onToggleReaction, editing, canHover],
  );

  const handlePickEmoji = useCallback(
    (emoji: string) => {
      setShowReactionPicker(false);
      hoveredReactionRef.current = null;
      setHoveredReactionEmoji(null);
      // Errors surface via the hook's error banner; state reverts there.
      onToggleReaction?.(message.order, emoji).catch(() => {});
    },
    [onToggleReaction, message.order],
  );

  const handleReactionChipEnter = useCallback((emoji: string) => {
    if (hoverLeaveTimerRef.current) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    hoveredReactionRef.current = emoji;
    setShowReactionPicker(false);
    setHoveredReactionEmoji(emoji);
  }, []);

  const handleReactionChipLeave = useCallback(() => {
    hoveredReactionRef.current = null;
    setHoveredReactionEmoji(null);
    if (canHover()) openReactionPicker();
  }, [canHover, openReactionPicker]);

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

  const senderLabel = message.senderAddress
    ? truncateAddress(message.senderAddress)
    : null;
  const showAvatar = isLastInGroup;

  const verifiedCheck = message.senderVerified ? (
    <span
      className="text-green-500 dark:text-green-400"
      title="Sender verified"
    >
      ✓
    </span>
  ) : null;

  const timeMeta = (
    <>
      <span>{formatTime(message.createdAt)}</span>
      {message.isEdited && <span className="italic">(edited)</span>}
    </>
  );

  return (
    <div
      className={`group flex min-w-0 max-w-full px-4 ${
        isFirstInGroup ? 'mt-2.5' : 'mt-0.5'
      } ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex max-w-[85%] items-end gap-0 sm:max-w-[75%] ${
          isOwnMessage ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        {/* Avatar only on the latest bubble in a same-sender run */}
        {showAvatar ? (
          <ReservationNavAvatar
            address={message.senderAddress}
            imageSrc={avatarSrc}
            size={AVATAR_SIZE}
            className="relative z-20 mb-0.5 shrink-0"
          />
        ) : (
          <span
            className="shrink-0"
            style={{
              width: Math.max(0, AVATAR_SIZE - AVATAR_OVERLAP_PX),
              height: AVATAR_SIZE,
            }}
            aria-hidden
          />
        )}

        <div
          ref={bubbleWrapperRef}
          className={`relative z-0 flex min-w-0 max-w-full flex-col ${
            isOwnMessage ? 'items-end' : 'items-start'
          }`}
          style={
            isOwnMessage
              ? { marginRight: -AVATAR_OVERLAP_PX }
              : { marginLeft: -AVATAR_OVERLAP_PX }
          }
          onMouseEnter={() => {
            if (canHover()) openReactionPicker();
          }}
          onMouseLeave={() => {
            if (canHover()) scheduleCloseReactionPicker();
          }}
        >
          {/* Bubble + overlays share one sizing box so reactions track the bubble */}
          <div className="relative w-fit max-w-full">
            <div
              onClick={handleBubbleClick}
              className={`w-fit max-w-full overflow-hidden px-3.5 py-2 ${radiusClass} ${
                onToggleReaction && !editing ? 'cursor-pointer' : ''
              } ${
                isOwnMessage
                  ? 'bg-bubble-sent-fill text-white'
                  : 'bg-bubble-received-fill text-secondary-900 dark:text-secondary-100'
              }`}
            >
              {editing ? (
                <div className="space-y-2">
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    rows={2}
                    disabled={saving}
                    className="w-full max-w-full resize-none break-all rounded-xl border border-white/40 bg-white px-2 py-1 text-sm text-secondary-900 focus:outline-none focus:ring-1 focus:ring-white/50 disabled:opacity-50 dark:bg-secondary-800 dark:text-secondary-100"
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={handleCancelEdit}
                      disabled={saving}
                      className="rounded px-2 py-0.5 text-xs text-bubble-sent-meta hover:text-white disabled:opacity-50"
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
                    <p className="text-[15px] leading-snug break-words whitespace-pre-wrap">
                      {message.text}
                    </p>
                  )}
                </>
              )}

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
            </div>

            {/* Reaction chips — opposite avatar corner at top */}
            {reactions && reactions.length > 0 && (
              <div
                className={`absolute z-10 flex max-w-[min(100%,14rem)] flex-wrap gap-1 ${reactionAnchorClass}`}
              >
                {reactions.map((entry) => {
                  const mine = myAddress
                    ? entry.reactors.some(
                        (a) => a.toLowerCase() === myAddress.toLowerCase(),
                      )
                    : false;
                  const reactorRows = entry.reactors.map((addr) => ({
                    addr,
                    label:
                      myAddress &&
                      addr.toLowerCase() === myAddress.toLowerCase()
                        ? 'You'
                        : (labelForAddress?.(addr) ??
                          `${addr.slice(0, 6)}...${addr.slice(-4)}`),
                  }));
                  const reactorsTitle = reactorRows
                    .map((r) => r.label)
                    .join(', ');
                  const showTip =
                    hoveredReactionEmoji === entry.emoji && !showReactionPicker;
                  return (
                    <div
                      key={entry.emoji}
                      className="relative"
                      onMouseEnter={() => handleReactionChipEnter(entry.emoji)}
                      onMouseLeave={handleReactionChipLeave}
                    >
                      <button
                        type="button"
                        onClick={() => handlePickEmoji(entry.emoji)}
                        disabled={!onToggleReaction}
                        aria-label={`${entry.emoji} reaction from ${reactorsTitle}`}
                        title={reactorsTitle}
                        className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs shadow-sm transition-colors ${
                          mine
                            ? 'border-bubble-sent/40 bg-white text-bubble-sent dark:border-bubble-sent-dark/50 dark:bg-secondary-800 dark:text-bubble-sent-dark'
                            : 'border-secondary-200 bg-white text-secondary-600 hover:bg-secondary-50 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-300 dark:hover:bg-secondary-700'
                        } ${onToggleReaction ? '' : 'cursor-default'}`}
                      >
                        <span>{entry.emoji}</span>
                        {entry.count >= 2 && (
                          <span className="font-medium tabular-nums">
                            {entry.count}
                          </span>
                        )}
                      </button>
                      {showTip && (
                        <div
                          role="tooltip"
                          className={`pointer-events-none absolute top-full z-40 mt-1 w-max max-w-[14rem] rounded-lg border border-secondary-200 bg-white px-2.5 py-1.5 text-[11px] leading-snug text-secondary-700 shadow-lg dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-200 ${
                            isOwnMessage ? 'right-0' : 'left-0'
                          }`}
                        >
                          <div className="flex flex-col gap-0.5">
                            {reactorRows.map((row) => (
                              <span key={row.addr} className="truncate">
                                {row.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Reaction picker — hover (desktop) / tap (mobile); hidden while a chip tip is open */}
            {showReactionPicker &&
              !hoveredReactionEmoji &&
              onToggleReaction && (
              <div
                className={`absolute z-20 flex gap-0.5 rounded-full border border-secondary-200 bg-white px-2 py-1 shadow-lg dark:border-secondary-600 dark:bg-secondary-800 ${popoverVerticalClass} ${
                  isOwnMessage ? 'right-0' : 'left-0'
                }`}
                onMouseEnter={() => {
                  if (canHover()) openReactionPicker();
                }}
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
              <div
                className={`absolute right-0 z-20 rounded-2xl border border-secondary-200 bg-white p-3 shadow-lg dark:border-secondary-600 dark:bg-secondary-800 ${deletePopoverVerticalClass}`}
              >
                <p className="mb-2 text-xs text-secondary-600 dark:text-secondary-300">
                  Delete this message?
                </p>
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={deleting}
                    className="rounded-full px-2.5 py-0.5 text-xs text-secondary-500 hover:text-secondary-700 disabled:opacity-50 dark:text-secondary-400 dark:hover:text-secondary-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="rounded-full bg-danger-500 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-danger-600 disabled:opacity-50"
                  >
                    {deleting ? '...' : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Meta — extra padding on the avatar side so labels sit clear of the overlap */}
          <div
            className={`mt-1 flex w-max max-w-[min(100vw,20rem)] flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-secondary-400 dark:text-secondary-500 ${
              isOwnMessage
                ? 'justify-end pl-3.5 pr-5'
                : 'justify-start pl-5 pr-3.5'
            }`}
          >
            {isOwnMessage ? (
              <>
                {verifiedCheck}
                {timeMeta}
                {!editing && (onEdit || onDelete) && (
                  <span className="ml-1 inline-flex items-center gap-2.5">
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditText(message.text);
                          setEditing(true);
                        }}
                        className="border-0 bg-transparent p-0 text-xs leading-none text-secondary-400 hover:text-bubble-sent dark:text-secondary-500 dark:hover:text-bubble-sent-dark"
                        title="Edit"
                      >
                        ✎
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="border-0 bg-transparent p-0 text-xs leading-none text-secondary-400 hover:text-danger-500 dark:text-secondary-500 dark:hover:text-danger-400"
                        title="Delete"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                )}
              </>
            ) : (
              <>
                {isLastInGroup && senderLabel && (
                  <span className="font-medium text-secondary-500 dark:text-secondary-400">
                    {senderLabel}
                  </span>
                )}
                {isLastInGroup && message.isAgentMessage && (
                  <span
                    className="rounded bg-secondary-200/80 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-600 dark:bg-secondary-600/80 dark:text-secondary-200"
                    title={
                      message.principalOwner
                        ? `Agent of ${truncateAddress(message.principalOwner)}`
                        : 'Agent message'
                    }
                  >
                    Agent
                  </span>
                )}
                {timeMeta}
                {isLastInGroup && verifiedCheck}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
