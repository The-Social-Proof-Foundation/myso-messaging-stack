import { Plus } from 'lucide-react';
import type { RecipientPeer } from '../lib/recipient-picker';
import { peerRowTitle } from '../lib/recipient-picker';
import { BlockedPeerBadge } from './BlockedPeerBadge';
import { ReservationNavAvatar } from './ReservationNavAvatar';

/** Match New Message search-field density (taller than Members rows). */
const PICKER_AVATAR_SIZE = 34;

interface RecipientPickerRowsProps {
  peers: readonly RecipientPeer[];
  busy?: boolean;
  onAdd: (peer: RecipientPeer) => void;
}

/**
 * Peer rows for New Message / Add Member — same fill as the search bar
 * (`bg-white` / `dark:bg-secondary-700`), thicker than Members list rows.
 */
export function RecipientPickerRows({
  peers,
  busy = false,
  onAdd,
}: Readonly<RecipientPickerRowsProps>) {
  return (
    <ul className="overflow-hidden rounded-xl border border-secondary-300 dark:border-secondary-600">
      {peers.map((peer) => {
        const blocked = Boolean(peer.blocked);
        const title = peerRowTitle(peer);
        const walletShort =
          peer.wallet.length > 16
            ? `${peer.wallet.slice(0, 8)}…${peer.wallet.slice(-8)}`
            : peer.wallet;
        const subtitle = peer.isCardless
          ? 'No profile — wallet only'
          : peer.displayName && peer.username
            ? `@${peer.username.replace(/^@/, '')}`
            : walletShort;
        const showSubtitle = Boolean(subtitle) && subtitle !== title;
        const isWalletTitle = !peer.displayName && !peer.username;
        return (
          <li
            key={peer.wallet}
            className="border-b border-secondary-300 last:border-b-0 dark:border-secondary-600"
          >
            <button
              type="button"
              onClick={() => onAdd(peer)}
              disabled={busy || blocked}
              title={peer.wallet}
              className="flex w-full items-center gap-3 bg-white px-3 py-2.5 text-left transition-colors hover:bg-secondary-50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-secondary-700 dark:hover:bg-secondary-600"
            >
              <ReservationNavAvatar
                address={peer.wallet}
                imageSrc={peer.photoURL}
                size={PICKER_AVATAR_SIZE}
                className="shrink-0"
              />
              <span className="min-w-0 flex-1 text-left">
                <span
                  className={`block truncate text-sm font-medium text-secondary-900 dark:text-secondary-100 ${
                    isWalletTitle ? 'font-mono' : ''
                  }`}
                >
                  {title}
                </span>
                {showSubtitle && (
                  <span className="block truncate text-xs text-secondary-500 dark:text-secondary-400">
                    {subtitle}
                  </span>
                )}
              </span>
              {blocked ? (
                <BlockedPeerBadge />
              ) : (
                <Plus
                  className="h-4 w-4 shrink-0 text-secondary-400"
                  aria-hidden
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
