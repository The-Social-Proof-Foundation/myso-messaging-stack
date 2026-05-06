import { useState, useRef, type KeyboardEvent } from 'react';
import type { AttachmentFile } from '../hooks/useMessages';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 10;

interface MessageInputProps {
  onSend: (text: string, files?: AttachmentFile[]) => Promise<void>;
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
  disabled = false,
  sending = false,
}: Readonly<MessageInputProps>) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSend() {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || disabled || sending) return;

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

  return (
    <div className="border-t border-secondary-200 px-4 py-3 dark:border-secondary-700">
      {/* File chips */}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-1 rounded-full bg-secondary-100 px-2.5 py-1 text-xs text-secondary-700 dark:bg-secondary-700 dark:text-secondary-300"
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
        <p className="mb-1.5 text-xs text-danger-500">{fileError}</p>
      )}

      {/* Sending indicator */}
      {sending && (
        <div className="mb-2 flex items-center gap-2 text-xs text-secondary-500">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <span>Sending{files.length > 0 ? ' (uploading files...)' : '...'}</span>
        </div>
      )}

      <div className="flex gap-2">
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-secondary-400 hover:bg-secondary-100 hover:text-secondary-600 disabled:opacity-50 dark:hover:bg-secondary-700 dark:hover:text-secondary-300"
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

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={disabled || sending}
          className="flex-1 resize-none rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500"
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50 disabled:hover:bg-primary-500"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
