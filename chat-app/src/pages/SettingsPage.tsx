import { Navigate } from 'react-router-dom';
import { PaidMessagingSettings } from '../components/PaidMessagingSettings';
import { ThemeSwitcher } from '../components/kibo-ui/theme-switcher';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { useTheme } from '../contexts/ThemeContext';

export function SettingsPage() {
  const { session, auth, configError } = useMySocialAuth();
  const { preference, setPreference } = useTheme();

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
          <h1 className="text-2xl font-semibold text-primary-900 dark:text-primary-50">
            Settings
          </h1>
          <p className="mt-1 text-sm text-secondary-500 dark:text-secondary-400">
            Manage messaging preferences for your account.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900">
          <section className="flex w-full items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">
                Appearance
              </p>
              <p className="mt-0.5 text-sm text-secondary-500 dark:text-secondary-400">
                Switch between light, dark, and system themes.
              </p>
            </div>
            <ThemeSwitcher value={preference} onChange={setPreference} />
          </section>
        </div>

        <div className="overflow-hidden rounded-xl border border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900">
          <PaidMessagingSettings />
        </div>
      </div>
    </main>
  );
}
