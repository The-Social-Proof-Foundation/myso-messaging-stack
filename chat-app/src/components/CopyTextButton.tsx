import {useEffect, useRef, useState} from 'react';
import {Check, Copy} from 'lucide-react';

/** Copies text to the clipboard, falling back to a hidden textarea where the async API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/** A very small gray copy icon that flips to a check for a moment once the text is copied. */
export function CopyTextButton({text, label = 'Copy message'}: Readonly<{text: string; label?: string}>) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={async (event) => {
        event.stopPropagation();
        if (!(await copyText(text))) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded align-middle leading-none text-secondary-400/70 transition-colors hover:text-secondary-600 dark:text-secondary-500/70 dark:hover:text-secondary-300"
    >
      {copied ? <Check className="h-2.5 w-2.5" aria-hidden /> : <Copy className="h-2.5 w-2.5" aria-hidden />}
    </button>
  );
}
