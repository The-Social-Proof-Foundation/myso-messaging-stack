/**
 * Per-conversation notification, read-receipt, and online-visibility toggles
 * (Chat Details). Visible to every member — not admin-gated.
 */

export type ChatSettingsSavingKey =
  | 'notifications'
  | 'readReceipts'
  | 'onlinePresence'
  | null;

interface ChatSettingsSectionProps {
  notificationsEnabled: boolean;
  readReceiptsEnabled: boolean;
  /** Show online in this chat (inverse of hideOnlinePresence). */
  onlinePresenceEnabled: boolean;
  loading: boolean;
  savingKey: ChatSettingsSavingKey;
  error: string | null;
  onToggleNotifications: (enabled: boolean) => void;
  onToggleReadReceipts: (enabled: boolean) => void;
  onToggleOnlinePresence: (enabled: boolean) => void;
}

export function ChatSettingsSection({
  notificationsEnabled,
  readReceiptsEnabled,
  onlinePresenceEnabled,
  loading,
  savingKey,
  error,
  onToggleNotifications,
  onToggleReadReceipts,
  onToggleOnlinePresence,
}: Readonly<ChatSettingsSectionProps>) {
  const busy = loading || savingKey !== null;

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Chat settings
      </h4>

      <div className="flex flex-col gap-3">
        <ToggleRow
          label="Notifications"
          helper="Notify me about new messages in this chat"
          checked={notificationsEnabled}
          disabled={busy}
          saving={savingKey === 'notifications'}
          onChange={onToggleNotifications}
        />
        <ToggleRow
          label="Read receipts"
          helper="Let others see when you’ve read messages"
          checked={readReceiptsEnabled}
          disabled={busy}
          saving={savingKey === 'readReceipts'}
          onChange={onToggleReadReceipts}
        />
        <ToggleRow
          label="Show online status"
          helper="Let others see when you’re online in this chat"
          checked={onlinePresenceEnabled}
          disabled={busy}
          saving={savingKey === 'onlinePresence'}
          onChange={onToggleOnlinePresence}
        />
      </div>

      {error ? (
        <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>
      ) : null}
    </section>
  );
}

function ToggleRow({
  label,
  helper,
  checked,
  disabled,
  saving,
  onChange,
}: Readonly<{
  label: string;
  helper: string;
  checked: boolean;
  disabled: boolean;
  saving: boolean;
  onChange: (next: boolean) => void;
}>) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-secondary-800 dark:text-secondary-100">
          {label}
          {saving ? (
            <span className="ml-1.5 text-xs font-normal text-secondary-400">
              Saving…
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-secondary-500 dark:text-secondary-400">
          {helper}
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-secondary-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-800"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
