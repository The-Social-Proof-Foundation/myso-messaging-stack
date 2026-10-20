import { useRecordSignerAddress } from '../hooks/useSelfAddresses';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';

import {IosPushStack} from './IosPushStack';
import {Sidebar} from './Sidebar';
import {ChatArea} from './ChatArea';
import {CreateGroupModal} from './CreateGroupModal';
import {AgentChatEmptyState} from './agents/AgentChatEmptyState';
import {useProfileOverview} from '../hooks/agents/useProfileOverview';
import {AgentListView} from './agents/AgentListView';
import {CreateRoomDialog, type CreateRoomRequest} from './agents/CreateRoomDialog';
import {RoomVerifyPanel} from './agents/RoomVerifyPanel';
import {RoomsPanel} from './agents/RoomsPanel';
import {UnreadCountsProvider} from '../contexts/UnreadCountsContext';
import {CreateAgentDialog} from './agents/CreateAgentDialog';
import {CreateOrganizationDialog} from './agents/CreateOrganizationDialog';
import {OrganizationChartPane} from './agents/OrganizationChartPane';
import {useGroupDiscovery} from '../hooks/useGroupDiscovery';
import {usePaidDmRequests} from '../hooks/usePaidDmRequests';
import {useGroupActivityOrder} from '../hooks/useGroupActivityOrder';
import {useUserFeed} from '../hooks/useUserFeed';
import {useRegisterCreateMessageHandler} from '../contexts/CreateMessageContext';
import {useMobileChatNav} from '../contexts/MobileChatNavContext';
import {useAuthenticatedAddress, useMySocialAuth} from '../contexts/MySocialAuthContext';
import {useIsMobileNav} from '../hooks/useMediaQuery';
import {AgentDevSendPanel} from './AgentDevSendPanel';
import {useSubAgentByObjectId, useSubAgents} from '../hooks/agents/useSubAgents';
import {useCreateAgentChat, useOpenAgentChat} from '../hooks/agents/useAgentChatActions';
import {findAgentChatRef, useAgentChatIndex} from '../hooks/agents/useAgentChats';
import {useMemoryAccount} from '../hooks/agents/useMemoryAccount';
import type {AgentRoomInfo, SubAgentRow} from '../lib/agents/social-api';
import {AGENT_ROOM_KIND} from '../lib/agents/rooms';
import {writeSelectedAgent} from '../lib/agents/selected-agent-store';
import {
  getSelectedGroupKey,
  getSelectedOrganizationId,
  setSelectedGroupKey,
  setSelectedOrganizationId as persistSelectedOrganizationId,
} from '../lib/group-store';
import {CHAT_LIST_WIDTH_PX} from '../lib/chat-layout';
import {
  failChatProgress,
  finishChatProgress,
  startChatProgress,
  updateChatProgress,
} from '../lib/agents/chat-progress';
import {classifyAgentChatError} from '../lib/agents/format-agent-chat-error';
import {agentCountLabel} from '../lib/agents/profile-graphql';
import {AGENT_CHAT_STAGE_LABEL} from '../hooks/agents/useAgentChatActions';

interface AuthenticatedAppProps {
  isUsingDevMessengerSigner: boolean;
}

type ListView = 'chats' | 'agents' | 'rooms';

const LIST_LEVEL: Record<ListView, number> = {
  chats: 0,
  agents: 1,
  rooms: 2,
};

export function AuthenticatedApp({
  isUsingDevMessengerSigner,
}: Readonly<AuthenticatedAppProps>) {
  const address = useAuthenticatedAddress();
  const { keypair } = useMySocialAuth();
  // Each sign-in signs with a new key; remember it so the next sign-in still knows these messages are mine.
  useRecordSignerAddress();
  const location = useLocation();
  const navigate = useNavigate();

  const {
    groups,
    loading: discoveryLoading,
    refresh: refreshGroups,
    handleDiscovered,
    handleHidden,
  } = useGroupDiscovery(address);

  const activity = useGroupActivityOrder(groups);
  const paidDmGroupIds = usePaidDmRequests(groups, activity.counts);
  const receiptApplyRef = useRef<
    | ((event: {
        groupId: string;
        member: string;
        deliveredUpto: number;
        readUpto: number;
      }) => void)
    | null
  >(null);

  const sortedGroups = useMemo(
    () =>
      [...groups].sort((a, b) => {
        const ao = activity.latestOrders[a.groupId] ?? 0;
        const bo = activity.latestOrders[b.groupId] ?? 0;
        if (bo !== ao) return bo - ao;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      }),
    [groups, activity.latestOrders],
  );

  const [selectedUuid, setSelectedUuid] = useState<string | null>(() =>
    getSelectedGroupKey(address),
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const openCreateModal = useCallback(() => setShowCreateModal(true), []);
  useRegisterCreateMessageHandler(openCreateModal);

  // --- Agents view state ---------------------------------------------------
  // Reload returns to what was open: the last chat, or else the last organization.
  const restoredOrganizationId = () =>
    getSelectedGroupKey(address) ? null : getSelectedOrganizationId(address);
  const [listView, setListView] = useState<ListView>(() =>
    restoredOrganizationId() ? 'agents' : 'chats',
  );
  /** Organization whose rooms are showing. Null is the principal-wide rooms list. */
  const [roomsOrganizationId, setRoomsOrganizationId] = useState<string | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(
    restoredOrganizationId,
  );
  const [showNewOrganization, setShowNewOrganization] = useState(false);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [selectedAgentObjectId, setSelectedAgentObjectId] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  useEffect(()=>{
    const replace=()=>{setSelectedOrganizationId(null);setShowNewAgent(true);};
    window.addEventListener('agent:create-replacement',replace);
    return()=>window.removeEventListener('agent:create-replacement',replace);
  },[]);

  const agentsEnabled = Boolean(selectedAgentObjectId);
  const agentList = useSubAgents(false, { enabled: agentsEnabled });
  const localAgentMatch = useMemo(
    () =>
      agentList.items.find((agent) => agent.agent_object_id === selectedAgentObjectId) ?? null,
    [agentList.items, selectedAgentObjectId],
  );
  // Only ask the server for a single agent when the paged list has not reached it.
  const agentById = useSubAgentByObjectId(localAgentMatch ? null : selectedAgentObjectId);
  const selectedAgentRow = localAgentMatch ?? agentById.data ?? null;

  const create = useCreateAgentChat();
  const openChat = useOpenAgentChat();
  const chatIndex = useAgentChatIndex(groups);
  const agentCreatorActors = useMemo(
    () => chatIndex.refs.map((ref) => ref.creatorActor),
    [chatIndex.refs],
  );
  const memoryAccount = useMemoryAccount();

  const selectGroup = useCallback(
    (key: string | null) => {
      setSelectedUuid(key);
      setSelectedGroupKey(address, key);
      if (key) setSelectedOrganizationId(null);
    },
    [address],
  );

  const selectOrganization = useCallback(
    (organizationId: string) => {
      setSelectedOrganizationId(organizationId);
      setSelectedUuid(null);
      setSelectedGroupKey(address, null);
      setSelectedAgentObjectId(null);
    },
    [address],
  );

  const openOrganizationRooms = useCallback(
    (organizationId: string) => {
      setRoomsOrganizationId(organizationId);
      setListView('rooms');
      selectOrganization(organizationId);
    },
    [selectOrganization],
  );

  // Show the create flow's current step on the Chat button that started it.
  useEffect(() => {
    if (create.stage) updateChatProgress(AGENT_CHAT_STAGE_LABEL[create.stage]);
  }, [create.stage]);

  const startAgentChat = useCallback(
    async (agent: SubAgentRow) => {
      startChatProgress(agent.agent_object_id, 'Opening chat…');
      try {
        const existing = await findAgentChatRef(agent, chatIndex.refs);
        if (existing) updateChatProgress('Checking chat access…');
        const hydrated = existing
          ? await openChat(existing)
          : await create.createChat(agent);
        if (existing && memoryAccount.data?.account_id) {
          writeSelectedAgent({
            agentObjectId: agent.agent_object_id,
            derivedAddress: agent.derived_address,
            memoryAccountId: memoryAccount.data.account_id,
            label: agent.label,
            organizationId: agent.organization_id,
          });
        }
        refreshGroups();
        chatIndex.refresh();
        selectGroup(hydrated.uuid);
        finishChatProgress();
      } catch (error) {
        failChatProgress(agent.agent_object_id, classifyAgentChatError(error).message);
        setSelectedOrganizationId(null);
        setSelectedAgentObjectId(agent.agent_object_id);
      }
    },
    [chatIndex, create, memoryAccount.data?.account_id, openChat, refreshGroups, selectGroup],
  );

  const openRoom = useCallback(
    async (room: AgentRoomInfo) => {
      // An un-indexed room has no uuid yet, so there is nothing to open.
      if (!room.groupUuid) return;
      try {
        const hydrated = await openChat({
          groupId: room.groupId,
          uuid: room.groupUuid,
          name: room.groupName,
          agentObjectId: null,
          creatorActor: room.creatorActor,
          creatorPrincipal: room.creatorPrincipal,
          organizationId: room.organizationId,
          createdAt: room.createdAtMs,
          source: 'chain',
        });
        refreshGroups();
        chatIndex.refresh();
        selectGroup(hydrated.uuid);
      } catch (error) {
        console.warn('[chat-app] could not open room:', error);
      }
    },
    [chatIndex, openChat, refreshGroups, selectGroup],
  );

  const createRoom = useCallback(
    async (request: CreateRoomRequest) => {
      const hydrated = await create.createChat(request.agent, {
        name: request.name,
        room: {kind: AGENT_ROOM_KIND, taskId: request.taskId},
      });
      refreshGroups();
      chatIndex.refresh();
      setListView('rooms');
      selectGroup(hydrated.uuid);
    },
    [chatIndex, create, refreshGroups, selectGroup],
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'rooms') {
      setRoomsOrganizationId(null);
      setListView('rooms');
      params.delete('view');
      const nextRooms = params.toString();
      navigate(
        {pathname: location.pathname, search: nextRooms ? `?${nextRooms}` : ''},
        {replace: true},
      );
      return;
    }
    if (params.get('view') !== 'organizations') return;
    setListView('agents');
    params.delete('view');
    const next = params.toString();
    navigate(
      {pathname: location.pathname, search: next ? `?${next}` : ''},
      {replace: true},
    );
  }, [location.search, location.pathname, navigate]);

  // `/agents` → "Chat" hands the agent over through router state.
  useEffect(() => {
    const state = location.state as { openAgentObjectId?: string; openGroupKey?: string } | null;
    if (state?.openGroupKey) {
      setListView('chats');
      selectGroup(state.openGroupKey);
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    const requested = state?.openAgentObjectId;
    if (!requested) return;
    setSelectedAgentObjectId(requested);
    setSelectedOrganizationId(null);
    setSelectedGroupKey(address, null);
    setSelectedUuid(null);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate, address, selectGroup]);

  const isMobileNav = useIsMobileNav();
  const { setHideAppHeader } = useMobileChatNav();
  // Organization rooms are a sidebar stack. On a phone, keep that list on screen
  // until a room (or another thread) is actually open.
  const mobileRoomsList =
    isMobileNav && listView === 'rooms' && !selectedUuid && !selectedAgentRow;
  const mobileChatOpen =
    isMobileNav &&
    !mobileRoomsList &&
    (Boolean(selectedUuid) || Boolean(selectedAgentRow) || Boolean(selectedOrganizationId));

  // Hide AppHeader only while a mobile chat thread is open.
  useEffect(() => {
    setHideAppHeader(mobileChatOpen);
    return () => setHideAppHeader(false);
  }, [mobileChatOpen, setHideAppHeader]);

  const locationStateRef = useRef(location.state);
  locationStateRef.current = location.state;

  // Re-hydrate the open conversation when the wallet address becomes available.
  // A restored agent must not take over the center pane.
  useEffect(() => {
    const storedChat = getSelectedGroupKey(address);
    const storedOrganization = storedChat ? null : getSelectedOrganizationId(address);
    setSelectedUuid(storedChat);
    const requested = (locationStateRef.current as {openAgentObjectId?: string} | null)
      ?.openAgentObjectId;
    if (!requested) setSelectedAgentObjectId(null);
    setSelectedOrganizationId(storedOrganization);
    restoredOrgCheckRef.current = storedOrganization;
    if (storedOrganization) setListView('agents');
  }, [address]);

  // A restored organization that no longer exists must not open an empty chart
  // (which would offer to create an agent with no organization behind it).
  const profileOverview = useProfileOverview();
  const restoredOrgCheckRef = useRef<string | null>(selectedOrganizationId);
  useEffect(() => {
    if (!selectedOrganizationId || !profileOverview.isSuccess) return;
    const restored = restoredOrgCheckRef.current;
    if (restored?.toLowerCase() !== selectedOrganizationId.toLowerCase()) return;
    restoredOrgCheckRef.current = null;
    const exists = profileOverview.data.organizations.some(
      (org) => org.organizationId.toLowerCase() === selectedOrganizationId.toLowerCase(),
    );
    if (!exists) setSelectedOrganizationId(null);
  }, [address, selectedOrganizationId, profileOverview.isSuccess, profileOverview.data]);

  // Remember the open organization (declared after the restore above so it never erases it first).
  useEffect(() => {
    if (address) persistSelectedOrganizationId(address, selectedOrganizationId);
  }, [address, selectedOrganizationId]);

  const selectedGroup =
    groups.find(
      (g) => g.uuid === selectedUuid || g.groupId === selectedUuid,
    ) ?? null;

  const roomOrganization = useMemo(() => {
    if (!selectedGroup) return null;
    const organizationId = chatIndex.refs.find(
      (ref) => ref.groupId === selectedGroup.groupId,
    )?.organizationId;
    if (!organizationId) return null;
    const org = profileOverview.data?.organizations.find(
      (row) => row.organizationId.toLowerCase() === organizationId.toLowerCase(),
    );
    return {
      id: organizationId,
      name: org?.name?.trim() || 'Untitled',
      detail: agentCountLabel(org?.statistics?.totalAgents, org?.statistics?.totalAgents),
    };
  }, [selectedGroup, chatIndex.refs, profileOverview.data]);

  // One user-feed socket per wallet drives sidebar badges, cross-device
  // read-state sync, and group discovery. Polling remains as reconciliation.
  useUserFeed(groups, {
    onGroupActivity: (groupId, latestOrder) => {
      activity.recordActivity(groupId, latestOrder);
      if (groupId !== (selectedGroup?.groupId ?? null)) {
        activity.bump(groupId);
      }
    },
    onReadStateUpdated: () => {
      activity.refresh();
    },
    onReceiptUpdated: (groupId, member, deliveredUpto, readUpto) => {
      receiptApplyRef.current?.({
        groupId,
        member,
        deliveredUpto,
        readUpto,
      });
    },
    onGroupDiscovered: (groupId) => {
      handleDiscovered(groupId);
      activity.refresh();
    },
    onGroupHidden: (groupId) => {
      handleHidden(groupId);
      if (selectedGroup?.groupId === groupId) {
        selectGroup(null);
      }
    },
  });

  const handleGroupCreated = useCallback(
    (uuid: string) => {
      refreshGroups();
      selectGroup(uuid);
    },
    [refreshGroups, selectGroup],
  );

  const handleLeaveGroup = useCallback(() => {
    selectGroup(null);
    refreshGroups();
  }, [refreshGroups, selectGroup]);

  return (
    <UnreadCountsProvider counts={activity.counts} selectedGroupId={selectedGroup?.groupId ?? null}>
    <>
      {isUsingDevMessengerSigner && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          Dev signer: using a local ephemeral keypair (not your MySocial wallet
          salt key). On-chain actions use this address/fund it on localnet as
          needed.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* List stays visible on desktop; only mobile hides it while a chat is open. */}
        <div
          className={
            isMobileNav
              ? mobileChatOpen
                ? 'hidden'
                : 'flex min-h-0 w-full flex-col'
              : 'flex min-h-0 w-72 shrink-0 flex-col overflow-hidden'
          }
        >
          <div
            className={
              isMobileNav
                ? 'flex min-h-0 w-full flex-1 flex-col'
                : 'flex h-full min-h-0 flex-col'
            }
            style={
              isMobileNav ? undefined : { width: CHAT_LIST_WIDTH_PX }
            }
          >
            <IosPushStack
              view={listView}
              level={LIST_LEVEL[listView]}
              render={(view) =>
                view === 'rooms' ? (
                  <RoomsPanel
                    selectedGroupId={selectedGroup?.groupId ?? null}
                    organizationId={roomsOrganizationId}
                    backLabel={roomsOrganizationId ? 'Organizations' : 'Chats'}
                    onBack={() => {
                      if (roomsOrganizationId) {
                        setListView('agents');
                        if (isMobileNav) setSelectedOrganizationId(null);
                        return;
                      }
                      setListView('chats');
                    }}
                    onSelectRoom={(room) => void openRoom(room)}
                    onNewRoom={() => setShowNewRoom(true)}
                  />
                ) : view === 'agents' ? (
                  <AgentListView
                    selectedOrganizationId={selectedOrganizationId}
                    onBack={() => setListView('chats')}
                    onSelectOrganization={openOrganizationRooms}
                    onNewOrganization={() => setShowNewOrganization(true)}
                  />
                ) : (
                  <Sidebar
                    groups={sortedGroups}
                    selectedUuid={selectedUuid}
                    unreadCounts={activity.counts}
                    latestOrders={activity.latestOrders}
                    paidDmGroupIds={paidDmGroupIds}
                    onSelectGroup={selectGroup}
                    loading={discoveryLoading}
                    agentCreatorActors={agentCreatorActors}
                  />
                )
              }
            />
          </div>
        </div>
        <div
          className={
            isMobileNav &&
            (mobileRoomsList ||
              (!selectedUuid && !selectedAgentRow && !selectedOrganizationId))
              ? 'hidden md:flex md:min-w-0 md:flex-1 md:flex-col'
              : 'flex min-h-0 min-w-0 flex-1 flex-col'
          }
        >
          {selectedOrganizationId ? (
            <OrganizationChartPane
              organizationId={selectedOrganizationId}
              onCreateAgent={() => setShowNewAgent(true)}
              onChat={(agent) => void startAgentChat(agent)}
              onOpenChat={(uuid) => {
                setListView('chats');
                selectGroup(uuid);
              }}
              onMobileBack={isMobileNav ? () => setSelectedOrganizationId(null) : undefined}
            />
          ) : !selectedGroup && selectedAgentRow ? (
            <AgentChatEmptyState
              agent={selectedAgentRow}
              canChat={create.canChat(selectedAgentRow)}
              stage={create.stage}
              error={create.error}
              onStartChat={() => void startAgentChat(selectedAgentRow)}
              onEnableMessaging={() => void create.enableMessaging(selectedAgentRow)}
            />
          ) : (
            <ChatArea
              selectedGroup={selectedGroup}
              onLeaveGroup={handleLeaveGroup}
              onReadStateChanged={activity.markRead}
              onGroupActivity={
                selectedGroup
                  ? (order) =>
                      activity.recordActivity(selectedGroup.groupId, order)
                  : undefined
              }
              receiptApplyRef={receiptApplyRef}
              onMobileBack={
                isMobileNav ? () => selectGroup(null) : undefined
              }
              agentCreatorActors={agentCreatorActors}
              organization={roomOrganization}
              onOpenOrganization={
                roomOrganization
                  ? () => openOrganizationRooms(roomOrganization.id)
                  : undefined
              }
              roomVerifier={
                selectedGroup &&
                chatIndex.refs.some((ref) => ref.groupId === selectedGroup.groupId)
                  ? (messages, { labelFor, onSelectMessage }) => (
                      <RoomVerifyPanel
                        groupId={selectedGroup.groupId}
                        messages={messages}
                        labelFor={labelFor}
                        onSelectMessage={onSelectMessage}
                      />
                    )
                  : undefined
              }
              devAgentPanel={
                keypair && selectedGroup ? (
                  <AgentDevSendPanel
                    humanSigner={keypair}
                    groupUuid={selectedGroup.uuid}
                  />
                ) : null
              }
            />
          )}
        </div>
      </div>
      {showCreateModal && (
        <CreateGroupModal
          open
          onClose={() => setShowCreateModal(false)}
          onGroupCreated={handleGroupCreated}
        />
      )}
      <CreateOrganizationDialog
        open={showNewOrganization}
        onClose={() => setShowNewOrganization(false)}
        onCreated={(organizationId) => {
          setListView('agents');
          selectOrganization(organizationId);
        }}
      />
      <CreateRoomDialog
        open={showNewRoom}
        onClose={() => setShowNewRoom(false)}
        onCreate={createRoom}
        stage={create.stage}
        error={create.error}
      />
      <CreateAgentDialog
        key={selectedOrganizationId ?? 'none'}
        open={showNewAgent}
        defaultOrganizationId={selectedOrganizationId}
        onClose={() => setShowNewAgent(false)}
      />
    </>
    </UnreadCountsProvider>
  );
}
