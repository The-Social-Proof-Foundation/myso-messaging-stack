import type { StoredGroup } from '../lib/group-store';
import { useCallback, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { useMessagingMemberAddress } from '../contexts/MessagingClientContext';
import { useOwnWalletProfile } from '../hooks/useOwnWalletProfile';
import { useSidebarGroupMembers } from '../hooks/useSidebarGroupMembers';
import { sidebarPreviewActivityTime, useSidebarMessagePreviews } from '../hooks/useSidebarMessagePreviews';
import { useWalletAvatarMap } from '../hooks/useWalletAvatarMap';
import { useAgentNamesByAddress } from '../hooks/agents/useSubAgents';
import { conversationPeerLabel, isKnownAgentAddress, knownAgentAddressSet } from '../lib/agents/agent-display-name';
import {
  conversationDisplayTitle,
  dmPeerAddress,
  selfGroupNameLabelsForIdentities,
} from '../lib/wallet-profile';
import { ConversationAvatar } from './ConversationAvatar';
import { SidebarPromo } from './SidebarPromo';
import { sidebarShellClass } from './SidebarShell';

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
  /** Agent-chat creator addresses, so foreign agents still get an orb. */
  agentCreatorActors?: readonly (string | null | undefined)[];
}

export function Sidebar({
  groups,
  selectedUuid,
  unreadCounts = {},
  latestOrders = {},
  paidDmGroupIds,
  onSelectGroup,
  loading = false,
  agentCreatorActors = [],
}: Readonly<SidebarProps>) {
  const address = useAuthenticatedAddress();
  const messagingAddress = useMessagingMemberAddress();
  const selfAddresses = useMemo(
    () => [messagingAddress, address],
    [messagingAddress, address],
  );
  const { profile } = useOwnWalletProfile();
  const selfLabels = useMemo(
    () => selfGroupNameLabelsForIdentities(selfAddresses, profile),
    [selfAddresses, profile],
  );

  const groupIds = useMemo(() => groups.map((g) => g.groupId), [groups]);
  const membersByGroup = useSidebarGroupMembers(groupIds);
  const previews = useSidebarMessagePreviews(groups, latestOrders);
  // Most recent message first; groups without a known time keep their incoming order.
  const orderedGroups = useMemo(
    () =>
      groups
        .map((group, index) => ({
          group,
          index,
          at: sidebarPreviewActivityTime(group.groupId),
        }))
        .sort((a, b) => b.at - a.at || a.index - b.index)
        .map((entry) => entry.group),
    // previews changes whenever the preview cache (and its times) does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, previews],
  );
  // membersByGroup is seeded from persisted peers before getMembers returns.
  const profileAddresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const members of membersByGroup.values()) {
      for (const m of members) {
        if (selfAddresses.some((self) => self && m.toLowerCase() === self.toLowerCase())) {
          continue;
        }
        addrs.add(m);
      }
    }
    return [...addrs];
  }, [membersByGroup, selfAddresses]);
  const profiles = useWalletAvatarMap(profileAddresses);
  const agentNames = useAgentNamesByAddress();
  const knownAgents = useMemo(
    () => knownAgentAddressSet([...agentNames.keys()], agentCreatorActors),
    [agentNames, agentCreatorActors],
  );
  const isAgentAddress = useCallback(
    (address: string) => isKnownAgentAddress(address, knownAgents),
    [knownAgents],
  );

  return (
    <aside className={sidebarShellClass}>
      {/* Group list */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-secondary-400 dark:text-secondary-500">
            {loading ? (
              'Discovering groups...'
            ) : (
              <>
                No chat history, yet.
              </>
            )}
          </div>
        ) : (
          <ul>
            {orderedGroups.map((group) => {
              const unread = unreadCounts[group.groupId] ?? 0;
              const isPaidRequest = paidDmGroupIds?.has(group.groupId) ?? false;
              const selected =
                (selectedUuid === group.uuid ||
                  selectedUuid === group.groupId) &&
                !!selectedUuid;
              const members = membersByGroup.get(group.groupId) ?? [];
              const peer = dmPeerAddress(members, selfAddresses);
              const peerHandle = peer ? profiles.handleFor(peer) : null;
              const title = conversationDisplayTitle({
                officialName: group.name,
                selfLabels,
                memberAddresses: members,
                selfAddress: selfAddresses,
                peerLabel: conversationPeerLabel(
                  peer,
                  agentNames,
                  peer ? profiles.headerTitleFor(peer) : null,
                ),
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
                    className={`w-full py-3 pl-[13px] pr-2 text-left transition-colors ${
                      selected
                        ? 'bg-bubble-sent/10 text-secondary-900 dark:bg-secondary-700 dark:text-secondary-50'
                        : 'text-secondary-700 hover:bg-secondary-50 dark:text-secondary-300 dark:hover:bg-secondary-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <ConversationAvatar
                        memberAddresses={members}
                        selfAddress={selfAddresses}
                        profiles={profiles}
                        isAgentAddress={isAgentAddress}
                      />
                      <div className="min-w-0 flex-1 pt-px">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <p className="translate-y-px min-w-0 truncate text-sm font-medium leading-tight">
                            {title}
                          </p>
                          {peer && isAgentAddress(peer) ? (
                            <span className="shrink-0 self-center rounded-[3px] bg-primary-500/10 px-1.5 py-[3px] text-[9px] font-semibold uppercase leading-none tracking-[0.08em] text-primary-600 ring-1 ring-inset ring-primary-500/25 dark:bg-white/[0.06] dark:text-secondary-200 dark:ring-white/15">
                              Agent
                            </span>
                          ) : null}
                          {peerHandle ? (
                            <span className="shrink-0 text-xs font-medium leading-tight tracking-tight text-secondary-500 dark:text-secondary-400">
                              {peerHandle}
                            </span>
                          ) : null}
                        </div>
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
