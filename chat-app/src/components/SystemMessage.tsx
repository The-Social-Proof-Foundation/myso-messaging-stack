import { formatSystemMessage, type SystemMessageFields } from '../lib/system-message-copy';

interface SystemMessageProps {
  system: SystemMessageFields;
  labelFor: (address: string) => string;
  /** Coalesced / backfilled copy; when set, skips `formatSystemMessage`. */
  text?: string;
}

/** Centered muted system timeline row (visual peer to day separators). */
export function SystemMessage({
  system,
  labelFor,
  text: textOverride,
}: Readonly<SystemMessageProps>) {
  const text = textOverride ?? formatSystemMessage(system, labelFor);
  return (
    <div className="flex justify-center px-4 py-2">
      <p className="max-w-[90%] text-center text-xs font-medium text-secondary-500 dark:text-secondary-400">
        {text}
      </p>
    </div>
  );
}
