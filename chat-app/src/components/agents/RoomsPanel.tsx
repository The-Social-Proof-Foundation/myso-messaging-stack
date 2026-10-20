import {useCallback, useMemo} from 'react';
import {ChevronLeft, ChevronRight, Plus} from 'lucide-react';

import type {AgentRoomInfo} from '../../lib/agents/social-api';
import {roomKindLabel, roomTaskLink, roomTitle} from '../../lib/agents/rooms';
import {truncateAddress} from '../../lib/agents/format';
import {isKnownAgentAddress, knownAgentAddressSet} from '../../lib/agents/agent-display-name';
import {useAgentRooms, useOrganizationRooms} from '../../hooks/agents';
import {useAgentNamesByAddress} from '../../hooks/agents/useSubAgents';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {useMessagingMemberAddress} from '../../contexts/MessagingClientContext';
import {useSidebarGroupMembers} from '../../hooks/useSidebarGroupMembers';
import {useSidebarMessagePreviews} from '../../hooks/useSidebarMessagePreviews';
import {agentReplyPreview, useAgentReplyClock} from '../../lib/agents/agent-reply-sessions';
import type {StoredGroup} from '../../lib/group-store';
import {useWalletAvatarMap} from '../../hooks/useWalletAvatarMap';
import {Button} from '../Button';
import {ConversationAvatar} from '../ConversationAvatar';
import {sidebarShellClass} from '../SidebarShell';
import {UnreadCountBadge, unreadCountFor, useUnreadCounts} from '../../contexts/UnreadCountsContext';
import {ListError, LoadMoreRow} from './ListStates';

interface RoomsPanelProps {
  selectedGroupId: string | null;
  onBack: () => void;
  /** Label on the back control. Organization rooms return to the org list. */
  backLabel?: string;
  /** When set, the list is this organization's rooms instead of every room. */
  organizationId?: string | null;
  onSelectRoom: (room: AgentRoomInfo) => void;
  onNewRoom: () => void;
}

/** Rooms sidebar: one row per room, either for one organization or for the signed-in principal. */
function roomFaces(members: readonly string[] | undefined, creatorActor: string): string[] {
  if (members && members.length > 0) return [...members];
  return creatorActor ? [creatorActor] : [];
}

export function RoomsPanel({
  selectedGroupId,
  onBack,
  backLabel = 'Chats',
  organizationId = null,
  onSelectRoom,
  onNewRoom,
}: Readonly<RoomsPanelProps>) {
  const principalRooms = useAgentRooms({enabled: !organizationId});
  const organizationRooms = useOrganizationRooms(organizationId);
  const rooms = organizationId ? organizationRooms : principalRooms;
  const address = useAuthenticatedAddress();
  const messagingAddress = useMessagingMemberAddress();
  const selfAddresses = useMemo(() => [messagingAddress, address], [messagingAddress, address]);
  const groupIds = useMemo(() => rooms.rooms.map((room) => room.groupId), [rooms.rooms]);
  const membersByGroup = useSidebarGroupMembers(groupIds);
  const previewGroups = useMemo<StoredGroup[]>(
    () =>
      rooms.rooms.flatMap((room) =>
        room.groupUuid
          ? [{uuid: room.groupUuid, name: roomTitle(room), groupId: room.groupId, createdAt: room.createdAtMs}]
          : [],
      ),
    [rooms.rooms],
  );
  const previews = useSidebarMessagePreviews(previewGroups, {});
  useAgentReplyClock();
  const unread = useUnreadCounts();
  const profileAddresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const members of membersByGroup.values()) {
      for (const member of members) {
        if (selfAddresses.some((self) => self && member.toLowerCase() === self.toLowerCase())) continue;
        addrs.add(member);
      }
    }
    for (const room of rooms.rooms) {
      if (room.creatorActor) addrs.add(room.creatorActor);
    }
    return [...addrs];
  }, [membersByGroup, rooms.rooms, selfAddresses]);
  const profiles = useWalletAvatarMap(profileAddresses);
  const agentNames = useAgentNamesByAddress();
  const knownAgents = useMemo(
    () => knownAgentAddressSet([...agentNames.keys()], rooms.rooms.map((room) => room.creatorActor)),
    [agentNames, rooms.rooms],
  );
  const isAgentAddress = useCallback(
    (member: string) => isKnownAgentAddress(member, knownAgents),
    [knownAgents],
  );

  return (
    <aside className={sidebarShellClass}>
      <div className="shrink-0 border-b border-secondary-200 py-1.5 dark:border-secondary-700">
        <p className="text-center text-[11px] font-medium tracking-wide text-secondary-900 dark:text-white">
          Rooms
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-secondary-200 px-2 py-2 dark:border-secondary-700">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-secondary-600 transition-colors hover:bg-secondary-100 dark:text-secondary-300 dark:hover:bg-secondary-700"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
          {backLabel}
        </button>
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewRoom}
          title="New room"
          aria-label="New room"
          className="shrink-0 gap-1"
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          New
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rooms.isInitialLoading ? (
          <p className="px-4 py-3 text-xs text-secondary-500 dark:text-secondary-400">Loading…</p>
        ) : null}
        {rooms.isError ? <ListError error={rooms.error} onRetry={rooms.refetch} /> : null}
        {rooms.isEmpty && !rooms.isError ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-secondary-500 dark:text-secondary-400">No rooms yet.</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onNewRoom}>
              Create a room
            </Button>
          </div>
        ) : null}
        <ul>
          {rooms.rooms.map((room) => {
            const selected = selectedGroupId?.toLowerCase() === room.groupId.toLowerCase();
            const task = roomTaskLink(room);
            const preview = previews.get(room.groupId);
            return (
              <li key={room.groupId} className="border-b border-secondary-200 dark:border-secondary-700">
                <button
                  type="button"
                  onClick={() => onSelectRoom(room)}
                  disabled={!room.groupUuid}
                  title={room.groupUuid ? undefined : 'Room not indexed yet'}
                  className={`w-full py-3 pl-[13px] pr-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'bg-bubble-sent/10 text-secondary-900 dark:bg-secondary-700 dark:text-secondary-50'
                      : 'text-secondary-700 hover:bg-secondary-50 dark:text-secondary-300 dark:hover:bg-secondary-700/50'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <ConversationAvatar
                      memberAddresses={roomFaces(membersByGroup.get(room.groupId), room.creatorActor)}
                      selfAddress={selfAddresses}
                      profiles={profiles}
                      isAgentAddress={isAgentAddress}
                    />
                    <span className="min-w-0 flex-1 pt-px">
                      <span className="block translate-y-px truncate text-sm font-medium leading-tight text-secondary-900 dark:text-secondary-50">
                        {roomTitle(room)}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-xs font-medium leading-snug tracking-tight text-secondary-400 dark:text-secondary-500">
                        {agentReplyPreview(room.groupId, preview ?? '') || (
                          <>
                            {roomKindLabel(room.roomKind)}
                            {task ? ` · task ${truncateAddress(task)}` : ''}
                            {room.groupUuid ? '' : ' · not indexed yet'}
                          </>
                        )}
                      </span>
                    </span>
                    <UnreadCountBadge count={unreadCountFor(unread, room.groupId)} />
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                      strokeWidth={2}
                      aria-hidden
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        <LoadMoreRow list={rooms} showCompleteCount={false} />
      </div>
    </aside>
  );
}
