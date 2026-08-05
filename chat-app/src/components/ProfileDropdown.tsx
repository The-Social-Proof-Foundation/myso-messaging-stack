import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpen, Check, ChevronRight, Copy, Settings } from 'lucide-react';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import { useOwnWalletProfile } from '../hooks/useOwnWalletProfile';
import { getMySocialProfileUrl } from '../lib/wallet-profile';
import { HoldSignOutButton } from './HoldSignOutButton';
import { ReservationNavAvatar } from './ReservationNavAvatar';

export function ProfileDropdown() {
  const { session, connectedAddress, logout } = useMySocialAuth();
  const { profile, showRing, ringPercent } = useOwnWalletProfile();
  const [open, setOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  if (!session || !connectedAddress) return null;

  const displayName = profile?.display_name?.trim() || 'Anonymous User';
  const username = profile?.username?.trim() || null;
  const profileUrl = getMySocialProfileUrl(connectedAddress);
  const truncated = `${connectedAddress.slice(0, 8)}...${connectedAddress.slice(-8)}`;

  const handleCopyWalletAddress = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(connectedAddress).then(() => {
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 2000);
    });
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open profile menu"
          className="inline-flex shrink-0 items-center justify-center overflow-visible rounded-full border-0 bg-transparent p-0 outline-none ring-0 transition-transform duration-150 ease-out active:scale-[0.97] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 [-webkit-tap-highlight-color:transparent]"
        >
          <ReservationNavAvatar
            address={connectedAddress}
            imageSrc={profile?.profile_photo}
            size="md"
            showRing={showRing}
            ringPercent={ringPercent}
            interactive
            className="rounded-full"
          />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(100vw-1.5rem,330px)] overflow-hidden rounded-lg border border-secondary-200 bg-white p-0 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
        >
          <DropdownMenu.Item asChild>
            <a
              href={profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex w-full cursor-pointer select-none items-center gap-3 px-3 py-2 outline-none hover:bg-secondary-50 focus:bg-secondary-50 dark:hover:bg-secondary-800 dark:focus:bg-secondary-800"
            >
              <ReservationNavAvatar
                address={connectedAddress}
                imageSrc={profile?.profile_photo}
                size="navDropdown"
                showRing={showRing}
                ringPercent={ringPercent}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-base font-medium text-secondary-900 dark:text-secondary-50">
                    {displayName}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-secondary-400" />
                </div>
                {username && (
                  <span className="truncate text-sm text-secondary-500 dark:text-secondary-400">
                    @{username}
                  </span>
                )}
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleCopyWalletAddress}
                    className="inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 outline-none"
                    aria-label="Copy wallet address"
                  >
                    {addressCopied ? (
                      <Check className="h-2.5 w-2.5 text-green-500" />
                    ) : (
                      <Copy className="h-2.5 w-2.5 text-secondary-400" />
                    )}
                  </button>
                  <span className="truncate text-xs text-secondary-500 dark:text-secondary-400">
                    {truncated}
                  </span>
                </div>
              </div>
            </a>
          </DropdownMenu.Item>

          <div className="border-t border-secondary-200 dark:border-secondary-700" />

          <DropdownMenu.Item asChild>
            <a
              href="https://docs.mysocial.network/mysocial/blockchain/overview"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="group flex w-full cursor-pointer select-none items-center gap-2 px-2 py-2 text-sm text-secondary-500 outline-none transition-colors hover:bg-secondary-50 hover:text-secondary-900 focus:bg-secondary-50 focus:text-secondary-900 dark:text-secondary-400 dark:hover:bg-secondary-800 dark:hover:text-secondary-50 dark:focus:bg-secondary-800 dark:focus:text-secondary-50"
            >
              <BookOpen className="mx-2 h-4 w-4 shrink-0" />
              <span>How does messaging work?</span>
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </a>
          </DropdownMenu.Item>

          <div className="border-t border-secondary-200 dark:border-secondary-700" />

          <DropdownMenu.Item asChild>
            <Link
              to="/settings"
              onClick={() => setOpen(false)}
              className="group flex w-full cursor-pointer select-none items-center gap-2 px-2 py-2 text-sm text-secondary-500 outline-none transition-colors hover:bg-secondary-50 hover:text-secondary-900 focus:bg-secondary-50 focus:text-secondary-900 dark:text-secondary-400 dark:hover:bg-secondary-800 dark:hover:text-secondary-50 dark:focus:bg-secondary-800 dark:focus:text-secondary-50"
            >
              <Settings className="mx-2 h-4 w-4 shrink-0" />
              <span>Settings</span>
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" />
            </Link>
          </DropdownMenu.Item>

          <div className="border-t border-secondary-200 dark:border-secondary-700" />

          <DropdownMenu.Item
            asChild
            onSelect={(e) => {
              e.preventDefault();
            }}
          >
            <div className="p-0">
              <HoldSignOutButton
                className="flex cursor-pointer select-none items-center gap-2 rounded-none border-none bg-transparent px-2 py-2 text-sm text-[var(--destructive)] outline-none hover:bg-secondary-50 dark:hover:bg-secondary-800"
                progressBarClassName="bg-[var(--destructive-foreground)]"
                onConfirm={() => {
                  setOpen(false);
                  void logout();
                }}
              />
            </div>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
