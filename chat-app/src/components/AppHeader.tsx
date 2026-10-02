import { ArrowRight } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useCreateMessage } from '../contexts/CreateMessageContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { CalloutButton } from './CalloutButton';
import { HeaderBalances } from './HeaderBalances';
import { ProfileDropdown } from './ProfileDropdown';

/** Shared horizontal inset on both sides of the settings divider (brand / Back). */
const DIVIDER_INSET = 'px-5';

export function AppHeader() {
  const { auth, session, login } = useMySocialAuth();
  const { canCreateMessage, openCreateMessage } = useCreateMessage();
  const { pathname } = useLocation();
  const onSettings =
    pathname === '/settings' || pathname.startsWith('/settings/');

  return (
    <header className="flex items-stretch border-b border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900">
      <div className="flex min-w-0 flex-1 items-stretch">
        <Link
          to="/"
          className={`font-chakra flex min-w-0 items-center gap-3.5 py-3 text-xl font-normal tracking-wide text-primary-900 hover:opacity-90 dark:text-primary-50 ${
            onSettings ? DIVIDER_INSET : 'px-6'
          }`}
        >
          <img
            src="/myso-logo.webp"
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 invert dark:invert-0"
          />
          <span className="hidden sm:inline">Messaging</span>
        </Link>

        {onSettings ? (
          <>
            <span
              className="w-px shrink-0 self-stretch bg-secondary-300 dark:bg-secondary-600"
              aria-hidden
            />
            {/* Back sits to the right of the brand, in its own cell past the divider. */}
            <Link
              to="/"
              className={`flex shrink-0 items-center justify-center ${DIVIDER_INSET} text-sm text-secondary-500 transition-colors hover:text-secondary-800 dark:text-secondary-400 dark:hover:text-secondary-200`}
            >
              ← Back
            </Link>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-3 px-6 py-3">
        {session ? <HeaderBalances /> : null}
        {canCreateMessage ? (
          <CalloutButton
            type="button"
            borderOpacity={false}
            onClick={openCreateMessage}
            className="h-9 shrink-0 px-4 text-secondary-700 dark:text-secondary-400"
          >
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true">+</span>
              <span className="font-chakra">Create New</span>
            </div>
          </CalloutButton>
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
