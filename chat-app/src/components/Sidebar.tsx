import type { StoredGroup } from '../lib/group-store';
import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { useOwnWalletProfile } from '../hooks/useOwnWalletProfile';
import { useSidebarGroupMembers } from '../hooks/useSidebarGroupMembers';
import { useSidebarMessagePreviews } from '../hooks/useSidebarMessagePreviews';
import { useWalletAvatarMap } from '../hooks/useWalletAvatarMap';
import {
  conversationDisplayTitle,
  dmPeerAddress,
  selfGroupNameLabels,
} from '../lib/wallet-profile';
import { ConversationAvatar } from './ConversationAvatar';
import { SidebarPromo } from './SidebarPromo';

interface SidebarProps {
  groups: StoredGroup[];
  selectedUuid: string | null;
  unreadCounts?: Record<string, number>;
  /** Latest message order per group — refreshes last-message previews. */
  latestOrders?: Record<string, number>;
  /** Groups whose unread messages are paid-DM requests (reply claims escrow). */
  paidDmGroupIds?: Set<string>;
  onSelectGroup: (uuid: string) => void;
  loading?: boolean;
}

export function Sidebar({
  groups,
  selectedUuid,
  unreadCounts = {},
  latestOrders = {},
  paidDmGroupIds,
  onSelectGroup,
  loading = false,
}: Readonly<SidebarProps>) {
  const address = useAuthenticatedAddress();
  const { profile } = useOwnWalletProfile();
  const selfLabels = useMemo(
    () => selfGroupNameLabels(address, profile),
    [address, profile],
  );

  const groupIds = useMemo(() => groups.map((g) => g.groupId), [groups]);
  const membersByGroup = useSidebarGroupMembers(groupIds);
  const previews = useSidebarMessagePreviews(groups, latestOrders);
  // membersByGroup is seeded from persisted peers before getMembers returns.
  const profileAddresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const members of membersByGroup.values()) {
      for (const m of members) {
        if (address && m.toLowerCase() === address.toLowerCase()) continue;
        addrs.add(m);
      }
    }
    return [...addrs];
  }, [membersByGroup, address]);
  const profiles = useWalletAvatarMap(profileAddresses);

  return (
    <aside className="flex h-full min-h-0 w-full flex-1 flex-col border-r border-secondary-200/80 bg-white dark:border-secondary-700 dark:bg-secondary-900">
      {/* Group list */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-secondary-400 dark:text-secondary-500">
            {loading ? (
              'Discovering groups...'
            ) : (
              <>
                No groups yet.
                <br />
                Create or join one!
              </>
            )}
          </div>
        ) : (
          <ul>
            {groups.map((group) => {
              const unread = unreadCounts[group.groupId] ?? 0;
              const isPaidRequest = paidDmGroupIds?.has(group.groupId) ?? false;
              const selected =
                (selectedUuid === group.uuid ||
                  selectedUuid === group.groupId) &&
                !!selectedUuid;
              const members = membersByGroup.get(group.groupId) ?? [];
              const peer = dmPeerAddress(members, address);
              const title = conversationDisplayTitle({
                officialName: group.name,
                selfLabels,
                memberAddresses: members,
                selfAddress: address,
                peerLabel: peer ? profiles.labelFor(peer) : null,
              });
              const preview = previews.get(group.groupId) ?? '';
              return (
                <li
                  key={group.uuid || group.groupId}
                  className="border-b border-secondary-200 dark:border-secondary-700"
                >
                  <button
                    type="button"
                    onClick={() => onSelectGroup(group.uuid || group.groupId)}
                    className={`w-full px-2 py-3 text-left transition-colors ${
                      selected
                        ? 'bg-bubble-sent/10 text-secondary-900 dark:bg-secondary-700 dark:text-secondary-50'
                        : 'text-secondary-700 hover:bg-secondary-50 dark:text-secondary-300 dark:hover:bg-secondary-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <ConversationAvatar
                        memberAddresses={members}
                        selfAddress={address}
                        profiles={profiles}
                      />
                      <div className="min-w-0 flex-1 pt-px">
                        <p className="translate-y-px truncate text-sm font-medium leading-tight">
                          {title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug tracking-tight text-secondary-400 dark:text-secondary-500">
                          {preview || 'No messages yet'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 self-center">
                        {unread > 0 &&
                          (isPaidRequest ? (
                            <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold leading-none text-white">
                              PAID
                            </span>
                          ) : (
                            <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-bubble-sent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white dark:bg-bubble-sent-dark">
                              {unread > 99 ? '99+' : unread}
                            </span>
                          ))}
                        <ChevronRight
                          className="h-4 w-4 text-secondary-400 dark:text-secondary-500"
                          strokeWidth={2}
                          aria-hidden
                        />
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <SidebarPromo />
    </aside>
  );
}
