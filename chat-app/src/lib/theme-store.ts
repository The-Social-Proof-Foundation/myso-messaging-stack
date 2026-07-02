/**
 * localStorage-backed store for the user's theme preference.
 *
 * The preference is one of 'system' | 'light' | 'dark'. When it is 'system',
 * the resolved theme is derived from the OS `prefers-color-scheme` media query
 * and tracked live. The resolved theme drives the `.dark` class on <html>,
 * which activates the Tailwind `dark:` variants across the app.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'chat-app-theme';

/** Cycle order used by the toggle button: System -> Light -> Dark -> System. */
export const THEME_CYCLE: ThemePreference[] = ['system', 'light', 'dark'];

/** True when the OS prefers a dark color scheme (false if unavailable). */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
}

/** Resolve a stored preference to the concrete theme that should render. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/** Read the stored preference, defaulting to 'system' when unset or invalid. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // ignore (e.g. private mode / disabled storage)
  }
  return 'system';
}

/** Persist the user's theme preference. */
export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ignore
  }
}
