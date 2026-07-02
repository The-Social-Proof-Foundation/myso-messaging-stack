import { useTheme } from '../contexts/ThemeContext';
import { type ThemePreference } from '../lib/theme-store';

const NEXT_LABEL: Record<ThemePreference, string> = {
  system: 'Light',
  light: 'Dark',
  dark: 'System',
};

const CURRENT_LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

function ThemeIcon({ preference }: Readonly<{ preference: ThemePreference }>) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    className: 'h-5 w-5',
    'aria-hidden': true,
  } as const;

  if (preference === 'light') {
    return (
      <svg {...common}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.591-4.591L5.818 18.364M3 12h2.25m.386-6.364 1.591 1.591M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"
        />
      </svg>
    );
  }

  if (preference === 'dark') {
    return (
      <svg {...common}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
        />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25"
      />
    </svg>
  );
}

/** Cycles the theme preference System -> Light -> Dark -> System on click. */
export function ThemeToggleButton() {
  const { preference, cyclePreference } = useTheme();
  const current = CURRENT_LABEL[preference];
  const next = NEXT_LABEL[preference];

  return (
    <button
      type="button"
      onClick={cyclePreference}
      title={`Theme: ${current} (click for ${next})`}
      aria-label={`Theme is ${current}. Activate to switch to ${next}.`}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-secondary-500 transition-colors hover:bg-secondary-100 hover:text-secondary-700 dark:text-secondary-400 dark:hover:bg-secondary-700 dark:hover:text-secondary-200"
    >
      <ThemeIcon preference={preference} />
    </button>
  );
}
