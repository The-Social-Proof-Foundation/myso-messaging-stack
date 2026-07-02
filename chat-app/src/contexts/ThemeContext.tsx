import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  THEME_CYCLE,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme-store';

interface ThemeContextValue {
  /** The user's stored choice (system | light | dark). */
  preference: ThemePreference;
  /** The concrete theme currently rendering (light | dark). */
  resolvedTheme: ResolvedTheme;
  /** Set an explicit preference and persist it. */
  setPreference: (preference: ThemePreference) => void;
  /** Advance to the next preference in the System -> Light -> Dark cycle. */
  cyclePreference: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function ThemeProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readThemePreference(),
  );

  const applyTheme = useCallback((next: ThemePreference) => {
    const resolved = resolveTheme(next);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    return resolved;
  }, []);

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    applyTheme(readThemePreference()),
  );

  // Apply the current preference and, in 'system' mode, follow OS changes live.
  useEffect(() => {
    setResolvedTheme(applyTheme(preference));

    if (preference !== 'system') return undefined;
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = () => setResolvedTheme(applyTheme('system'));
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference, applyTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeThemePreference(next);
  }, []);

  const cyclePreference = useCallback(() => {
    setPreferenceState((current) => {
      const idx = THEME_CYCLE.indexOf(current);
      const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      writeThemePreference(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
      cyclePreference,
    }),
    [preference, resolvedTheme, setPreference, cyclePreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
