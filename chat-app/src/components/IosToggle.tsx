type IosToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name when the control is not wrapped in a labelled row. */
  'aria-label'?: string;
  className?: string;
};

/**
 * Compact iOS-style switch (green when on).
 */
export function IosToggle({
  checked,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
  className = '',
}: Readonly<IosToggleProps>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-secondary-900 ${
        checked
          ? 'bg-[#34C759]'
          : 'bg-secondary-300 dark:bg-secondary-600'
      } ${className}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute top-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
          checked ? 'translate-x-[16px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
