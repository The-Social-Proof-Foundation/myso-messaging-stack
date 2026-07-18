import { Link, Navigate } from 'react-router-dom';
import { PaidMessagingSettings } from '../components/PaidMessagingSettings';
import { ThemeToggleButton } from '../components/ThemeToggleButton';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { type ThemePreference } from '../lib/theme-store';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function SettingsPage() {
  const { session, auth, configError } = useMySocialAuth();
  const { preference } = useTheme();

  if (configError) {
    return (
      <main className="flex flex-1 items-center justify-center px-8">
        <div className="max-w-md text-center text-sm text-danger-500 dark:text-danger-400">
          {configError}
        </div>
      </main>
    );
  }

  if (auth && !session) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-xl space-y-6">
        <div>
          <Link
            to="/"
            className="text-sm text-secondary-500 hover:text-secondary-800 dark:text-secondary-400 dark:hover:text-secondary-200"
          >
            ← Messaging
          </Link>
          <h1 className="mt-3 text-2xl font-semibold text-primary-900 dark:text-primary-50">
            Settings
          </h1>
          <p className="mt-1 text-sm text-secondary-500 dark:text-secondary-400">
            Manage messaging preferences for your account.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900">
          <section className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
              Appearance
            </h3>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">
                  Theme
                </p>
                <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">
                  Current: {THEME_LABEL[preference]}. Click to cycle System →
                  Light → Dark.
                </p>
              </div>
              <ThemeToggleButton />
            </div>
          </section>
        </div>

        <div className="overflow-hidden rounded-xl border border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900">
          <PaidMessagingSettings />
        </div>
      </div>
    </main>
  );
}
