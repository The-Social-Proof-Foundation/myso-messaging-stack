import { Link } from 'react-router-dom';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { ProfileDropdown } from './ProfileDropdown';
import { ThemeToggleButton } from './ThemeToggleButton';

export function AppHeader() {
  const { auth, session, login } = useMySocialAuth();

  return (
    <header className="flex items-center justify-between border-b border-secondary-200 bg-white px-6 py-3 dark:border-secondary-700 dark:bg-secondary-900">
      <Link
        to="/"
        className="font-chakra flex items-center gap-3.5 text-xl font-normal tracking-wide text-primary-900 hover:opacity-90 dark:text-primary-50"
      >
        <img
          src="/myso-logo.webp"
          alt="Messaging"
          width={28}
          height={28}
          className="h-7 w-7 shrink-0 invert dark:invert-0"
        />
        <span className="hidden sm:inline">Messaging</span>
      </Link>
      <div className="flex items-center gap-3">
        <ThemeToggleButton />
        {session ? (
          <ProfileDropdown />
        ) : auth ? (
          <button
            type="button"
            onClick={login}
            className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700"
          >
            Sign in with MySocial
          </button>
        ) : null}
      </div>
    </header>
  );
}
