import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCreateMessage } from '../contexts/CreateMessageContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { CalloutButton } from './CalloutButton';
import { ProfileDropdown } from './ProfileDropdown';

export function AppHeader() {
  const { auth, session, login } = useMySocialAuth();
  const { canCreateMessage, openCreateMessage } = useCreateMessage();

  return (
    <header className="flex items-center justify-between border-b border-secondary-200 bg-white px-6 py-3 dark:border-secondary-700 dark:bg-secondary-900">
      <Link
        to="/"
        className="font-chakra flex items-center gap-3.5 text-xl font-normal tracking-wide text-primary-900 hover:opacity-90 dark:text-primary-50"
      >
        <img
          src="/myso-logo.webp"
          alt="Messaging"
          width={32}
          height={32}
          className="h-8 w-8 shrink-0 invert dark:invert-0"
        />
        <span className="hidden sm:inline">Messaging</span>
      </Link>
      <div className="flex items-center gap-3">
        {canCreateMessage ? (
          <button
            type="button"
            onClick={openCreateMessage}
            className="inline-flex h-9 shrink-0 items-center rounded-md border border-secondary-300 bg-white px-4 text-xs font-medium text-secondary-700 transition-none hover:bg-secondary-100 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-200 dark:hover:bg-secondary-700"
          >
            <span aria-hidden="true">+</span>
            <span className="ml-1.5">New</span>
          </button>
        ) : null}
        {session ? (
          <ProfileDropdown />
        ) : auth ? (
          <CalloutButton
            type="button"
            className="h-9 px-4 group/btn lg:inline-flex lg:size-auto lg:px-10 lg:py-2"
            borderOpacity={false}
            onClick={login}
          >
            <div className="flex items-center gap-2 px-1.5 sm:px-2">
              <span className="font-chakra">Sign In</span>
              <ArrowRight className="h-4 w-4 shrink-0 stroke-current" />
            </div>
          </CalloutButton>
        ) : null}
      </div>
    </header>
  );
}
