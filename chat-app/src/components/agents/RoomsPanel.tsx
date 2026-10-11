import {ChevronLeft, ChevronRight, Plus} from 'lucide-react';

import type {AgentRoomInfo} from '../../lib/agents/social-api';
import {roomKindLabel, roomTaskLink, roomTitle} from '../../lib/agents/rooms';
import {truncateAddress} from '../../lib/agents/format';
import {useAgentRooms} from '../../hooks/agents';
import {Button} from '../Button';
import {sidebarShellClass} from '../SidebarShell';
import {ListError, LoadMoreRow} from './ListStates';

interface RoomsPanelProps {
  selectedGroupId: string | null;
  onBack: () => void;
  onSelectRoom: (room: AgentRoomInfo) => void;
  onNewRoom: () => void;
}

/** Rooms sidebar: one row per agent room created by the signed-in principal's agents. */
export function RoomsPanel({
  selectedGroupId,
  onBack,
  onSelectRoom,
  onNewRoom,
}: Readonly<RoomsPanelProps>) {
  const rooms = useAgentRooms();

  return (
    <aside className={sidebarShellClass}>
      <div className="flex shrink-0 items-center gap-1 border-b border-secondary-200 px-2 py-2 dark:border-secondary-700">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-secondary-600 transition-colors hover:bg-secondary-100 dark:text-secondary-300 dark:hover:bg-secondary-700"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
          Chats
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
            return (
              <li key={room.groupId} className="border-b border-secondary-200 dark:border-secondary-700">
                <button
                  type="button"
                  onClick={() => onSelectRoom(room)}
                  disabled={!room.groupUuid}
                  title={room.groupUuid ? undefined : 'Room not indexed yet'}
                  className={`flex w-full items-center gap-2 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'bg-secondary-100 dark:bg-secondary-800'
                      : 'hover:bg-secondary-50 dark:hover:bg-secondary-700/50'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-secondary-900 dark:text-secondary-50">
                      {roomTitle(room)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-secondary-500 dark:text-secondary-400">
                      {roomKindLabel(room.roomKind)}
                      {task ? ` · task ${truncateAddress(task)}` : ''}
                      {room.groupUuid ? '' : ' · not indexed yet'}
                    </span>
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-secondary-400 dark:text-secondary-500"
                    strokeWidth={2}
                    aria-hidden
                  />
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
