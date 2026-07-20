import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { CreateGroupModal } from './CreateGroupModal';
import { useGroupDiscovery } from '../hooks/useGroupDiscovery';
import { usePaidDmRequests } from '../hooks/usePaidDmRequests';
import { useGroupActivityOrder } from '../hooks/useGroupActivityOrder';
import { useUserFeed } from '../hooks/useUserFeed';
import { useRegisterCreateMessageHandler } from '../contexts/CreateMessageContext';
import { useMobileChatNav } from '../contexts/MobileChatNavContext';
import { useAuthenticatedAddress, useMySocialAuth } from '../contexts/MySocialAuthContext';
import { useIsMobileNav } from '../hooks/useMediaQuery';
import { AgentDevSendPanel } from './AgentDevSendPanel';
import {
  getSelectedGroupKey,
  setSelectedGroupKey,
} from '../lib/group-store';

interface AuthenticatedAppProps {
  isUsingDevMessengerSigner: boolean;
}

export function AuthenticatedApp({
  isUsingDevMessengerSigner,
}: Readonly<AuthenticatedAppProps>) {
  const address = useAuthenticatedAddress();
  const { keypair } = useMySocialAuth();

  const {
    groups,
    loading: discoveryLoading,
    refresh: refreshGroups,
    handleDiscovered,
    handleHidden,
  } = useGroupDiscovery(address);

  const activity = useGroupActivityOrder(groups);
  const paidDmGroupIds = usePaidDmRequests(groups, activity.counts);

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

  const isMobileNav = useIsMobileNav();
  const { setHideAppHeader } = useMobileChatNav();
  const mobileChatOpen = isMobileNav && Boolean(selectedUuid);

  // Hide AppHeader only while a mobile chat thread is open.
  useEffect(() => {
    setHideAppHeader(mobileChatOpen);
    return () => setHideAppHeader(false);
  }, [mobileChatOpen, setHideAppHeader]);

  // Re-hydrate selection when the wallet address becomes available / changes.
  useEffect(() => {
    const cached = getSelectedGroupKey(address);
    setSelectedUuid(cached);
  }, [address]);

  const selectedGroup =
    groups.find(
      (g) => g.uuid === selectedUuid || g.groupId === selectedUuid,
    ) ?? null;

  // Stable view of the active conversation for user-feed handlers.
  const selectedGroupIdRef = useRef<string | null>(null);
  selectedGroupIdRef.current = selectedGroup?.groupId ?? null;

  const selectGroup = useCallback(
    (key: string | null) => {
      setSelectedUuid(key);
      setSelectedGroupKey(address, key);
    },
    [address],
  );

  // Persist preferred uuid once the group list resolves a cached groupId match.
  useEffect(() => {
    if (!selectedGroup || !address) return;
    const preferred = selectedGroup.uuid || selectedGroup.groupId;
    if (preferred && preferred !== selectedUuid) {
      setSelectedUuid(preferred);
    }
    setSelectedGroupKey(address, preferred);
  }, [selectedGroup, address, selectedUuid]);

  // One user-feed socket per wallet drives sidebar badges, cross-device
  // read-state sync, and group discovery. Polling remains as reconciliation.
  useUserFeed(groups, {
    onGroupActivity: (groupId, latestOrder) => {
      activity.recordActivity(groupId, latestOrder);
      if (groupId !== selectedGroupIdRef.current) {
        activity.bump(groupId);
      }
    },
    onReadStateUpdated: () => {
      activity.refresh();
    },
    onGroupDiscovered: (groupId) => {
      handleDiscovered(groupId);
      activity.refresh();
    },
    onGroupHidden: (groupId) => {
      handleHidden(groupId);
      if (selectedGroupIdRef.current === groupId) {
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
    <>
      {isUsingDevMessengerSigner && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          Dev signer: using a local ephemeral keypair (not your MySocial wallet
          salt key). On-chain actions use this address/fund it on localnet as
          needed.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <div
          className={
            mobileChatOpen
              ? 'hidden md:flex md:w-72 md:shrink-0 md:flex-col'
              : 'flex min-h-0 w-full flex-col md:w-72 md:shrink-0'
          }
        >
          <Sidebar
            groups={sortedGroups}
            selectedUuid={selectedUuid}
            unreadCounts={activity.counts}
            latestOrders={activity.latestOrders}
            paidDmGroupIds={paidDmGroupIds}
            onSelectGroup={selectGroup}
            loading={discoveryLoading}
          />
        </div>
        <div
          className={
            isMobileNav && !selectedUuid
              ? 'hidden md:flex md:min-w-0 md:flex-1 md:flex-col'
              : 'flex min-h-0 min-w-0 flex-1 flex-col'
          }
        >
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
            onMobileBack={
              isMobileNav ? () => selectGroup(null) : undefined
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
        </div>
      </div>
      {showCreateModal && (
        <CreateGroupModal
          open
          onClose={() => setShowCreateModal(false)}
          onGroupCreated={handleGroupCreated}
        />
      )}
    </>
  );
}
