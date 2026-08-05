import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ThemePreference } from '../../lib/theme-store';

const THEMES: {
  key: ThemePreference;
  icon: typeof Monitor;
  label: string;
}[] = [
  { key: 'system', icon: Monitor, label: 'System theme' },
  { key: 'light', icon: Sun, label: 'Light theme' },
  { key: 'dark', icon: Moon, label: 'Dark theme' },
];

/** Button slot size (px) — keeps the sliding pill aligned. */
const SLOT = 22;
const GAP = 6;
const PAD = 3;

export type ThemeSwitcherProps = {
  value?: ThemePreference;
  onChange?: (theme: ThemePreference) => void;
  defaultValue?: ThemePreference;
  className?: string;
};

/**
 * Compact kibo-style theme switcher with spaced options + sliding active pill.
 */
export function ThemeSwitcher({
  value,
  onChange,
  defaultValue = 'system',
  className = '',
}: Readonly<ThemeSwitcherProps>) {
  const [uncontrolled, setUncontrolled] = useState<ThemePreference>(defaultValue);
  const [mounted, setMounted] = useState(false);
  const theme = value ?? uncontrolled;
  const activeIndex = Math.max(
    0,
    THEMES.findIndex((t) => t.key === theme),
  );

  const setTheme = useCallback(
    (next: ThemePreference) => {
      if (value === undefined) setUncontrolled(next);
      onChange?.(next);
    },
    [onChange, value],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const trackWidth = PAD * 2 + SLOT * THEMES.length + GAP * (THEMES.length - 1);

  if (!mounted) {
    return (
      <div
        className={`h-7 shrink-0 rounded-full bg-secondary-100 ring-1 ring-secondary-200 dark:bg-secondary-800 dark:ring-secondary-600 ${className}`}
        style={{ width: trackWidth }}
        aria-hidden
      />
    );
  }

  return (
    <div
      className={`relative isolate flex h-7 shrink-0 items-center rounded-full bg-secondary-100 ring-1 ring-secondary-200 dark:bg-secondary-800 dark:ring-secondary-600 ${className}`}
      style={{ width: trackWidth, padding: PAD, gap: GAP }}
      role="radiogroup"
      aria-label="Theme"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute rounded-full bg-white shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.34,1.3,0.64,1)] dark:bg-secondary-600"
        style={{
          top: PAD,
          left: PAD,
          width: SLOT,
          height: SLOT,
          transform: `translateX(${activeIndex * (SLOT + GAP)}px)`,
        }}
      />
      {THEMES.map(({ key, icon: Icon, label }) => {
        const isActive = theme === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={label}
            onClick={() => setTheme(key)}
            className="relative z-10 flex shrink-0 items-center justify-center rounded-full transition-colors duration-200"
            style={{ width: SLOT, height: SLOT }}
          >
            <Icon
              className={`h-3.5 w-3.5 transition-colors duration-200 ${
                isActive
                  ? 'text-secondary-900 dark:text-secondary-50'
                  : 'text-secondary-400 dark:text-secondary-500'
              }`}
              aria-hidden
            />
          </button>
        );
      })}
    </div>
  );
}
