import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import EmojiPicker, {
  EmojiStyle,
  Theme as EmojiPickerTheme,
  type EmojiClickData,
} from 'emoji-picker-react';
import { Plus } from 'lucide-react';
import type {
  Message,
  AttachmentHandle,
  RelayerReactionEntry,
} from '../hooks/useMessages';
import { useTheme } from '../contexts/ThemeContext';
import {
  ReservationNavAvatar,
  reservationAvatarShellSize,
} from './ReservationNavAvatar';
import { formatMessageTime } from '../lib/message-time';

/** Quick reaction palette shown in the reaction tray. */
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Enter/exit duration budget for staggered picker (keep mounted for exit). */
const REACTION_PICKER_EXIT_MS = 280;

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
  /** SPT reservation ring for the sender avatar (when GraphQL indicates SPT/pool). */
  avatarShowRing?: boolean;
  avatarRingPercent?: number;
}

/** Uniform bubble radius for every message (no cluster corner edits). */
const BUBBLE_RADIUS = 'rounded-[18px]';

/** Match http(s) URLs in plain message text for linkification. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/gi;

function trimTrailingUrlPunctuation(url: string): {
  href: string;
  trailing: string;
} {
  // Peel common sentence punctuation off the end of a matched URL.
  let href = url;
  let trailing = '';
  while (/[.,);:!?]$/.test(href)) {
    trailing = href.slice(-1) + trailing;
    href = href.slice(0, -1);
  }
  return { href, trailing };
}

/** Render message text with http(s) URLs as external links. */
function LinkifiedText({
  text,
  isOwnMessage,
}: Readonly<{ text: string; isOwnMessage: boolean }>) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  const re = new RegExp(URL_IN_TEXT_RE.source, URL_IN_TEXT_RE.flags);
  let match: RegExpExecArray | null;
  const linkClass = isOwnMessage
    ? 'underline decoration-white/55 underline-offset-2 break-all hover:decoration-white'
    : 'underline decoration-bubble-sent/50 underline-offset-2 break-all text-bubble-sent hover:decoration-bubble-sent dark:text-bubble-sent-dark dark:decoration-bubble-sent-dark/60';
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const { href, trailing } = trimTrailingUrlPunctuation(match[0]);
    nodes.push(
      <a
        key={`${match.index}-${href}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
        onClick={(e) => e.stopPropagation()}
      >
        {href}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return <>{nodes.length > 0 ? nodes : text}</>;
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

function isImageAttachment(handle: AttachmentHandle): boolean {
  return handle.mimeType.startsWith('image/');
}

async function fetchAttachmentBlob(handle: AttachmentHandle): Promise<Blob> {
  const data = await handle.data();
  return new Blob([new Uint8Array(data)], { type: handle.mimeType });
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getScrollParent(el: HTMLElement | null): Element | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/** Edge-hugging image tile; loads via IntersectionObserver when near viewport. */
function ImageAttachmentTile({
  handle,
  isOwnMessage,
  reactionOverlay,
}: Readonly<{
  handle: AttachmentHandle;
  isOwnMessage: boolean;
  /** Message reactions — must live on this tile so wide images keep correct corners. */
  reactionOverlay?: ReactNode;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [chromeOpen, setChromeOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  const canHover = useCallback(() => {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    );
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const loadPreview = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError(false);
    try {
      const blob = await fetchAttachmentBlob(handle);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (err) {
      console.error('Failed to load image attachment:', err);
      startedRef.current = false;
      setError(true);
    }
  }, [handle]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || previewUrl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadPreview();
          observer.disconnect();
        }
      },
      {
        root: getScrollParent(el),
        rootMargin: '200px 0px',
        threshold: 0,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadPreview, previewUrl]);

  // Local optimistic bytes are already in memory — load immediately.
  useEffect(() => {
    if (!previewUrl && handle.wire.storageId === '') {
      void loadPreview();
    }
  }, [handle.wire.storageId, loadPreview, previewUrl]);

  const handleDownload = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setDownloading(true);
      setDownloadError(false);
      try {
        const blob = await fetchAttachmentBlob(handle);
        triggerBlobDownload(blob, handle.fileName);
      } catch (err) {
        console.error('Failed to download attachment:', err);
        setDownloadError(true);
      } finally {
        setDownloading(false);
      }
    },
    [handle],
  );

  const showChrome = chromeOpen;

  return (
    <div
      ref={containerRef}
      className="group/img relative w-max max-w-[min(100%,17.5rem)] overflow-visible bg-transparent"
      onMouseEnter={() => {
        if (canHover()) setChromeOpen(true);
      }}
      onMouseLeave={() => {
        if (canHover()) setChromeOpen(false);
      }}
      onClick={() => {
        if (!canHover() && previewUrl) setChromeOpen((open) => !open);
      }}
    >
      <div className="relative overflow-hidden rounded-[18px] shadow-sm dark:shadow-none">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={handle.fileName}
            className="block h-auto max-h-72 w-auto max-w-full bg-transparent object-contain"
          />
        ) : (
          <div className="flex h-36 w-[min(100%,17.5rem)] items-center justify-center bg-secondary-200/40 dark:bg-secondary-800/50">
            {error ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void loadPreview();
                }}
                className="text-xs font-medium text-bubble-sent hover:text-bubble-sent-dark dark:text-bubble-sent-dark"
              >
                Retry
              </button>
            ) : (
              <span
                className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-secondary-400 border-t-transparent opacity-60 dark:border-secondary-500"
                aria-label="Loading image"
              />
            )}
          </div>
        )}

        {/* Name / size (left) + download (right) — hover or tap */}
        {previewUrl && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/55 via-black/25 to-transparent px-2.5 pb-2 pt-8 transition-opacity duration-150 ${
              showChrome
                ? 'opacity-100'
                : 'opacity-0 group-hover/img:opacity-100'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-[11px] font-medium leading-tight text-white drop-shadow-sm"
                title={handle.fileName}
              >
                {handle.fileName}
              </p>
              <p className="tabular-nums text-[10px] leading-tight text-white/80 drop-shadow-sm">
                {formatSize(handle.fileSize)}
              </p>
            </div>
            <div className="pointer-events-auto shrink-0">
              {downloadError ? (
                <span className="text-[11px] text-danger-400">failed</span>
              ) : (
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloading}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-sm font-medium text-secondary-800 shadow-sm hover:bg-white disabled:opacity-50"
                  title="Download"
                >
                  {downloading ? '…' : '↓'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {reactionOverlay ? (
        <div
          className={`absolute z-10 flex w-max max-w-none flex-nowrap gap-1 ${
            isOwnMessage ? '-top-3.5 -right-2' : '-top-3.5 -left-2'
          }`}
        >
          {reactionOverlay}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Staggered Meta-style reaction tray + optional full Apple emoji panel.
 * Received: left → right. Own: right → left (bounce upward).
 */
function ReactionPickerTray({
  open,
  isOwnMessage,
  preferBelow,
  verticalClass,
  onPick,
}: Readonly<{
  open: boolean;
  isOwnMessage: boolean;
  preferBelow: boolean;
  verticalClass: string;
  onPick: (emoji: string) => void;
}>) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [showFullPicker, setShowFullPicker] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    setShowFullPicker(false);
    const t = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, REACTION_PICKER_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => {
    if (!showFullPicker) return;
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowFullPicker(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [showFullPicker]);

  if (!mounted) return null;

  // Quick emojis + trailing "+" control share the stagger index space.
  const quickCount = REACTION_EMOJIS.length;
  const totalSlots = quickCount + 1;

  const handleFullEmojiClick = (data: EmojiClickData) => {
    onPick(data.emoji);
    setShowFullPicker(false);
  };

  return (
    <div
      className={`absolute z-20 ${verticalClass} ${
        isOwnMessage ? 'right-0' : 'left-0'
      }`}
    >
      <div className="relative">
        {showFullPicker && (
          <div
            className={`absolute z-30 overflow-hidden rounded-xl border border-secondary-200 shadow-xl dark:border-secondary-600 ${
              preferBelow ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
            } ${isOwnMessage ? 'right-0' : 'left-0'}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <EmojiPicker
              onEmojiClick={handleFullEmojiClick}
              theme={
                resolvedTheme === 'dark'
                  ? EmojiPickerTheme.DARK
                  : EmojiPickerTheme.LIGHT
              }
              emojiStyle={EmojiStyle.APPLE}
              width={320}
              height={360}
              lazyLoadEmojis
              previewConfig={{ showPreview: false }}
            />
          </div>
        )}

        <div
          className={`flex gap-0.5 rounded-full border border-secondary-200 bg-white px-2 py-1 shadow-lg dark:border-secondary-600 dark:bg-secondary-800 ${
            leaving ? 'reaction-picker-tray-out' : 'reaction-picker-tray-in'
          }`}
        >
          {REACTION_EMOJIS.map((emoji, i) => {
            const staggerI = leaving
              ? isOwnMessage
                ? i
                : totalSlots - 1 - i
              : isOwnMessage
                ? totalSlots - 1 - i
                : i;
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onPick(emoji)}
                title={`React with ${emoji}`}
                style={{ '--reaction-i': staggerI } as CSSProperties}
                className={`reaction-picker-emoji-btn rounded-full px-1.5 py-0.5 text-base ${
                  leaving
                    ? 'reaction-picker-emoji-out'
                    : 'reaction-picker-emoji-in'
                }`}
              >
                <span className="reaction-picker-emoji-glyph inline-block">
                  {emoji}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowFullPicker((v) => !v);
            }}
            title="More emojis"
            aria-label="Open full emoji picker"
            aria-expanded={showFullPicker}
            style={
              {
                '--reaction-i': leaving
                  ? isOwnMessage
                    ? quickCount
                    : 0
                  : isOwnMessage
                    ? 0
                    : quickCount,
              } as CSSProperties
            }
            className={`reaction-picker-emoji-btn inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-secondary-500 dark:text-secondary-400 ${
              leaving
                ? 'reaction-picker-emoji-out'
                : 'reaction-picker-emoji-in'
            }`}
          >
            <Plus
              className="reaction-picker-emoji-glyph h-4 w-4"
              strokeWidth={2.5}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Filename / size / download row for the meta stack (above sender/time). */
function AttachmentFileRow({
  handle,
}: Readonly<{
  handle: AttachmentHandle;
}>) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(false);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setError(false);
    try {
      const blob = await fetchAttachmentBlob(handle);
      triggerBlobDownload(blob, handle.fileName);
    } catch (err) {
      console.error('Failed to download attachment:', err);
      setError(true);
    } finally {
      setDownloading(false);
    }
  }, [handle]);

  return (
    <div className="flex max-w-full items-center gap-2 text-[11px] text-secondary-400 dark:text-secondary-500">
      <span
        className="min-w-0 truncate font-medium text-secondary-500 dark:text-secondary-400"
        title={handle.fileName}
      >
        {handle.fileName}
      </span>
      <span className="shrink-0 tabular-nums">{formatSize(handle.fileSize)}</span>
      {error ? (
        <span className="shrink-0 text-danger-400">failed</span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleDownload();
          }}
          disabled={downloading}
          className="ml-auto shrink-0 rounded px-1 py-0.5 font-medium text-bubble-sent hover:text-bubble-sent-dark disabled:opacity-50 dark:text-bubble-sent-dark"
          title="Download"
        >
          {downloading ? '...' : '↓'}
        </button>
      )}
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
  avatarShowRing = false,
  avatarRingPercent = 0,
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
  // Wraps bubble + picker so outside-close doesn't race.
  const bubbleWrapperRef = useRef<HTMLDivElement>(null);
  const hoveredReactionRef = useRef<string | null>(null);
  // Grow into open gutter: own anchors right (extends left); peer anchors left (extends right).
  // First-message picker/delete go below so they aren't clipped by the scroll edge.
  const reactionAnchorClass = isOwnMessage
    ? '-top-4 -right-3'
    : '-top-4 -left-3';
  const popoverVerticalClass = preferReactionBelow
    ? 'top-full mt-1'
    : '-top-11';
  const deletePopoverVerticalClass = preferReactionBelow
    ? 'top-full mt-1'
    : '-top-16';

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

  const handleMessageContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onToggleReaction || editing) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, a, textarea, input')) return;
      e.preventDefault();
      hoveredReactionRef.current = null;
      setHoveredReactionEmoji(null);
      setShowReactionPicker(true);
    },
    [onToggleReaction, editing],
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
    hoveredReactionRef.current = emoji;
    setShowReactionPicker(false);
    setHoveredReactionEmoji(emoji);
  }, []);

  const handleReactionChipLeave = useCallback(() => {
    hoveredReactionRef.current = null;
    setHoveredReactionEmoji(null);
  }, []);

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
    ? (labelForAddress?.(message.senderAddress) ??
      truncateAddress(message.senderAddress))
    : null;
  const senderLabelIsWallet =
    Boolean(senderLabel) &&
    Boolean(message.senderAddress) &&
    senderLabel === truncateAddress(message.senderAddress);
  const showAvatar = isLastInGroup;
  const avatarShellWidth = reservationAvatarShellSize(
    AVATAR_SIZE,
    Boolean(avatarShowRing),
  );
  const avatarColumnInset = Math.max(0, avatarShellWidth - AVATAR_OVERLAP_PX);
  const attachments = message.attachments ?? [];
  const imageAttachments = attachments.filter(isImageAttachment);
  const fileOnlyAttachments = attachments.filter((h) => !isImageAttachment(h));
  const showTextBubble = editing || Boolean(message.text?.trim());

  const verifiedCheck = message.senderVerified ? (
    <span
      className="text-green-500 dark:text-green-400"
      title="Sender verified"
    >
      ✓
    </span>
  ) : null;

  const timeLabel = formatMessageTime(message.createdAt, {
    always: isOwnMessage,
  });
  const editedSuffix = message.isEdited ? (
    <span className="italic">(edited)</span>
  ) : null;

  // 2px tighter to the avatar column than pl/pr-5 (20 → 18).
  const metaPadClass = isOwnMessage ? 'pl-3.5 pr-[18px]' : 'pl-[14px] pr-3.5';

  const reactionChipItems =
    reactions && reactions.length > 0
      ? reactions.map((entry) => {
          const mine = myAddress
            ? entry.reactors.some(
                (a) => a.toLowerCase() === myAddress.toLowerCase(),
              )
            : false;
          const reactorRows = entry.reactors.map((addr) => ({
            addr,
            label:
              myAddress && addr.toLowerCase() === myAddress.toLowerCase()
                ? 'You'
                : (labelForAddress?.(addr) ??
                  `${addr.slice(0, 6)}...${addr.slice(-4)}`),
          }));
          const reactorsTitle = reactorRows.map((r) => r.label).join(', ');
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
                className={`flex items-center gap-1 rounded-full border px-2 py-1 shadow-sm transition-colors ${
                  mine
                    ? 'border-bubble-sent/50 bg-bubble-sent/15 text-bubble-sent backdrop-blur-md dark:border-bubble-sent-dark/70 dark:bg-[#0A3A6E]/92 dark:text-bubble-sent-dark'
                    : 'border-secondary-200 bg-white text-secondary-600 hover:bg-secondary-50 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-300 dark:hover:bg-secondary-700'
                } ${onToggleReaction ? '' : 'cursor-default'}`}
              >
                <span className="text-[15px] leading-none">{entry.emoji}</span>
                {entry.count >= 2 && (
                  <span className="text-xs font-medium tabular-nums leading-none">
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
        })
      : null;

  const showOwnEditDelete =
    isOwnMessage && !editing && Boolean(onEdit || onDelete);

  return (
    <div
      data-message-order={message.order}
      className={`group/msg flex min-w-0 max-w-full px-4 ${
        isFirstInGroup ? 'mt-2.5' : 'mt-0.5'
      } ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex max-w-[85%] items-end gap-0 sm:max-w-[75%] ${
          isOwnMessage ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        {/* Avatar only on the latest bubble; spacer uses the same shell width as
            the avatar (incl. SPT ring) so mid-cluster edges match. */}
        {showAvatar ? (
          <ReservationNavAvatar
            address={message.senderAddress}
            imageSrc={avatarSrc}
            size={AVATAR_SIZE}
            showRing={avatarShowRing}
            ringPercent={avatarRingPercent}
            className="relative z-20 mb-0.5 shrink-0 rounded-full shadow-sm dark:shadow-none"
          />
        ) : (
          <span
            className="shrink-0"
            style={{
              width: avatarColumnInset,
              height: avatarShellWidth,
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
            showAvatar
              ? isOwnMessage
                ? { marginRight: -AVATAR_OVERLAP_PX }
                : { marginLeft: -AVATAR_OVERLAP_PX }
              : undefined
          }
          onContextMenu={handleMessageContextMenu}
        >
          {/* Content + overlays — reactions track image + text column */}
          <div className="relative w-fit max-w-full">
            {/* Hover chrome beside the bubble (left of own messages) — avoids
                sitting under the avatar in the meta row. */}
            {(showOwnEditDelete || !isLastInGroup) && (
              <div
                className={`absolute top-1/2 z-30 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap text-[11px] text-secondary-400 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 dark:text-secondary-500 ${
                  isOwnMessage ? 'right-full mr-2' : 'left-full ml-2'
                }`}
              >
                {showOwnEditDelete && (
                  <span className="inline-flex items-center gap-2.5">
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
                {!isLastInGroup && (
                  <span className="pointer-events-none">
                    {timeLabel}
                    {editedSuffix ? <> {editedSuffix}</> : null}
                  </span>
                )}
              </div>
            )}

            <div
              className={`flex w-fit max-w-full flex-col gap-0.5 ${
                isOwnMessage ? 'items-end' : 'items-start'
              }`}
            >
              {imageAttachments.length > 0 && (
                <div
                  className={`flex w-max max-w-full flex-col gap-0.5 ${
                    isOwnMessage ? 'items-end' : 'items-start'
                  }`}
                >
                  {imageAttachments.map((handle, i) => (
                    <ImageAttachmentTile
                      key={`img-${handle.fileName}-${i}`}
                      handle={handle}
                      isOwnMessage={isOwnMessage}
                      reactionOverlay={
                        i === 0 && reactionChipItems
                          ? reactionChipItems
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}

              {showTextBubble && (
                <div className="relative w-fit max-w-full">
                  <div
                    className={`w-fit max-w-full overflow-hidden px-3.5 py-2 shadow-sm dark:shadow-none ${BUBBLE_RADIUS} ${
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
                      <p className="text-[15px] leading-snug break-words whitespace-pre-wrap">
                        <LinkifiedText
                          text={message.text}
                          isOwnMessage={isOwnMessage}
                        />
                      </p>
                    )}
                  </div>
                  {imageAttachments.length === 0 && reactionChipItems ? (
                    <div
                      className={`absolute z-10 flex w-max max-w-none flex-nowrap gap-1 ${reactionAnchorClass}`}
                    >
                      {reactionChipItems}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* Reaction picker — right-click / long-press; staggered Meta-style motion */}
            {onToggleReaction && (
              <ReactionPickerTray
                open={showReactionPicker && !hoveredReactionEmoji}
                isOwnMessage={isOwnMessage}
                preferBelow={preferReactionBelow}
                verticalClass={popoverVerticalClass}
                onPick={handlePickEmoji}
              />
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

          {/* Non-image file meta — above sender / time / check */}
          {fileOnlyAttachments.length > 0 && (
            <div
              className={`mt-1 flex w-max max-w-[min(100vw,20rem)] flex-col gap-0.5 ${
                isOwnMessage ? 'items-end' : 'items-start'
              } ${metaPadClass}`}
            >
              {fileOnlyAttachments.map((handle, i) => (
                <AttachmentFileRow
                  key={`file-${handle.fileName}-${i}`}
                  handle={handle}
                />
              ))}
            </div>
          )}

          {/* Meta — only under the last bubble in a same-sender run */}
          {isLastInGroup && (
            <div
              className={`mt-0.5 flex w-max max-w-[min(100vw,20rem)] flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-secondary-400 dark:text-secondary-500 ${
                isOwnMessage ? 'justify-end' : 'justify-start'
              } ${metaPadClass}`}
            >
              {isOwnMessage ? (
                <>
                  {verifiedCheck}
                  {timeLabel ? (
                    <span className="text-secondary-400/70 dark:text-secondary-500/70">
                      {timeLabel}
                    </span>
                  ) : null}
                  {editedSuffix}
                </>
              ) : (
                <>
                  {senderLabel && (
                    <span
                      className={`font-sans font-medium tracking-tight text-secondary-500 dark:text-secondary-400 ${
                        senderLabelIsWallet
                          ? 'text-[10px] tabular-nums'
                          : 'text-[11px]'
                      }`}
                      title={message.senderAddress ?? undefined}
                    >
                      {senderLabel}
                    </span>
                  )}
                  {message.isAgentMessage && (
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
                  {timeLabel ? (
                    <span className="text-secondary-400/70 dark:text-secondary-500/70">
                      {timeLabel}
                    </span>
                  ) : null}
                  {editedSuffix}
                  {verifiedCheck}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
