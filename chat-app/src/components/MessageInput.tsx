import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import EmojiPicker, {
  EmojiStyle,
  Theme as EmojiTheme,
  type EmojiClickData,
} from 'emoji-picker-react';
import { Smile } from 'lucide-react';
import type { AttachmentFile } from '../hooks/useMessages';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 10;
/** Composer grows with content up to this many lines, then scrolls. */
const MAX_COMPOSER_LINES = 6;
/** Max one typing.start broadcast per this window while typing continues. */
const TYPING_THROTTLE_MS = 3_000;
/** Send typing.stop after this much keyboard silence. */
const TYPING_IDLE_MS = 3_000;

function syncComposerHeight(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.overflowY = 'hidden';
  const style = getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || 21;
  const paddingY =
    (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const maxH = lineHeight * MAX_COMPOSER_LINES + paddingY;
  const contentH = el.scrollHeight;
  if (contentH > maxH + 0.5) {
    el.style.height = `${maxH}px`;
    el.style.overflowY = 'auto';
  } else {
    el.style.height = `${contentH}px`;
  }
}

interface MessageInputProps {
  onSend: (text: string, files?: AttachmentFile[]) => Promise<void>;
  /** Broadcast typing state: `true` on keystrokes (throttled), `false` on send/clear/idle. */
  onTyping?: (typing: boolean) => void;
  disabled?: boolean;
  sending?: boolean;
}

/** Format bytes into a human-readable size string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageInput({
  onSend,
  onTyping,
  disabled = false,
  sending = false,
}: Readonly<MessageInputProps>) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  // Typing broadcast state: explicit start/stop with the TTL as server-side
  // recovery. `start` is throttled; `stop` fires on send, clear, and idle.
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const lastStartRef = useRef(0);
  const isTypingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopTyping() {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onTypingRef.current?.(false);
    }
  }

  function noteTyping(value: string) {
    if (!onTypingRef.current) return;

    if (!value.trim()) {
      stopTyping();
      return;
    }

    const now = Date.now();
    if (!isTypingRef.current || now - lastStartRef.current >= TYPING_THROTTLE_MS) {
      lastStartRef.current = now;
      isTypingRef.current = true;
      onTypingRef.current(true);
    }

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  // Best-effort stop when the composer unmounts (group switch, sign-out).
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (isTypingRef.current) {
        isTypingRef.current = false;
        onTypingRef.current?.(false);
      }
    };
  }, []);

  // Grow with content up to MAX_COMPOSER_LINES; collapse when cleared.
  useEffect(() => {
    const el = textareaRef.current;
    if (el) syncComposerHeight(el);
  }, [text]);

  // Dismiss emoji panel on outside click / Escape.
  useEffect(() => {
    if (!showEmojiPicker) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (emojiPickerRef.current?.contains(target)) return;
      if (emojiButtonRef.current?.contains(target)) return;
      setShowEmojiPicker(false);
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setShowEmojiPicker(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showEmojiPicker]);

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    noteTyping(next);
    requestAnimationFrame(() => {
      const field = textareaRef.current;
      if (!field) return;
      field.focus();
      const pos = start + emoji.length;
      field.setSelectionRange(pos, pos);
      syncComposerHeight(field);
    });
  }

  function handleEmojiClick(data: EmojiClickData) {
    insertEmoji(data.emoji);
  }

  async function handleSend() {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || disabled || sending) return;

    stopTyping();

    // Convert File objects to AttachmentFile[]
    let attachmentFiles: AttachmentFile[] | undefined;
    if (files.length > 0) {
      attachmentFiles = await Promise.all(
        files.map(async (f) => ({
          fileName: f.name,
          mimeType: f.type || 'application/octet-stream',
          data: new Uint8Array(await f.arrayBuffer()),
        })),
      );
    }

    setText('');
    setFiles([]);
    setFileError(null);
    setShowEmojiPicker(false);
    await onSend(trimmed, attachmentFiles);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend().then();
    }
  }

  function handleFilesSelected(selectedFiles: FileList | null) {
    if (!selectedFiles) return;
    setFileError(null);

    const incoming = Array.from(selectedFiles);
    const total = files.length + incoming.length;

    if (total > MAX_FILES) {
      setFileError(`Maximum ${MAX_FILES} files per message.`);
      return;
    }

    for (const f of incoming) {
      if (f.size > MAX_FILE_SIZE) {
        setFileError(`"${f.name}" exceeds the 5 MB limit.`);
        return;
      }
    }

    setFiles((prev) => [...prev, ...incoming]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setFileError(null);
  }

  const canSend = (text.trim() || files.length > 0) && !disabled && !sending;
  const emojiTheme =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
      ? EmojiTheme.DARK
      : EmojiTheme.LIGHT;

  return (
    <div className="relative border-t border-secondary-200/80 px-3 py-2.5 dark:border-secondary-700">
      {/* File chips */}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-1 rounded-full bg-bubble-received px-2.5 py-1 text-xs text-secondary-700 dark:bg-bubble-received-dark dark:text-secondary-200"
            >
              <span className="max-w-30 truncate">{f.name}</span>
              <span className="text-secondary-400">{formatSize(f.size)}</span>
              <button
                onClick={() => removeFile(i)}
                className="ml-0.5 text-secondary-400 hover:text-danger-500"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File error */}
      {fileError && (
        <p className="mb-1.5 px-1 text-xs text-danger-500">{fileError}</p>
      )}

      {showEmojiPicker && (
        <div
          ref={emojiPickerRef}
          className="absolute bottom-full left-3 z-40 mb-2 overflow-hidden rounded-xl border border-secondary-200 shadow-xl dark:border-secondary-600"
        >
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            autoFocusSearch={false}
            emojiStyle={EmojiStyle.APPLE}
            theme={emojiTheme}
            width={320}
            height={360}
            lazyLoadEmojis
          />
        </div>
      )}

      <div className="flex items-end gap-1.5">
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending}
          className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary-400 hover:bg-secondary-100 hover:text-secondary-600 disabled:opacity-50 dark:hover:bg-secondary-700 dark:hover:text-secondary-300"
          title="Attach files"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5"
          >
            <path
              fillRule="evenodd"
              d="M15.621 4.379a3 3 0 00-4.242 0l-7 7a3 3 0 004.241 4.243h.001l.497-.5a.75.75 0 011.064 1.057l-.498.501-.002.002a4.5 4.5 0 01-6.364-6.364l7-7a4.5 4.5 0 016.368 6.36l-3.455 3.553A2.625 2.625 0 119.52 9.52l3.45-3.451a.75.75 0 111.061 1.06l-3.45 3.451a1.125 1.125 0 001.587 1.595l3.454-3.553a3 3 0 000-4.242z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFilesSelected(e.target.files);
            // Reset so the same file can be selected again
            e.target.value = '';
          }}
        />

        {/* Emoji — same light-gray treatment as paperclip */}
        <button
          ref={emojiButtonRef}
          type="button"
          onClick={() => setShowEmojiPicker((open) => !open)}
          disabled={disabled || sending}
          className={`mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary-400 hover:bg-secondary-100 hover:text-secondary-600 disabled:opacity-50 dark:hover:bg-secondary-700 dark:hover:text-secondary-300 ${
            showEmojiPicker
              ? 'bg-secondary-100 text-secondary-600 dark:bg-secondary-700 dark:text-secondary-200'
              : ''
          }`}
          title="Emoji"
          aria-label="Toggle emoji picker"
          aria-expanded={showEmojiPicker}
        >
          <Smile className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            noteTyping(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message"
          rows={1}
          disabled={disabled || sending}
          className="max-h-[none] flex-1 resize-none overflow-hidden rounded-[1.25rem] border border-secondary-200 bg-secondary-50 px-4 py-2 text-[15px] leading-snug text-secondary-900 placeholder:text-secondary-400 focus:border-bubble-sent focus:outline-none focus:ring-2 focus:ring-bubble-sent/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-100 dark:placeholder:text-secondary-500 dark:focus:border-bubble-sent-dark dark:focus:ring-bubble-sent-dark/20"
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          aria-label={sending ? 'Sending' : 'Send'}
          className={`mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bubble-sent text-white transition-opacity hover:bg-bubble-sent/90 disabled:hover:bg-bubble-sent dark:bg-bubble-sent-dark dark:hover:bg-bubble-sent-dark/90 dark:disabled:hover:bg-bubble-sent-dark ${
            sending ? 'opacity-100' : 'disabled:opacity-40'
          }`}
        >
          {sending ? (
            <span
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              aria-hidden="true"
            />
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4 -rotate-45"
              aria-hidden="true"
            >
              <path d="M3.105 2.288a.75.75 0 00-.826.95l1.414 4.926A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086L2.279 16.76a.75.75 0 00.826.95 28.897 28.897 0 0015.293-7.154.75.75 0 000-1.114A28.897 28.897 0 003.105 2.288z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
