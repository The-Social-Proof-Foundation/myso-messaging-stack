import { useState, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { CreateGroupModal } from './CreateGroupModal';
import { useGroupDiscovery } from '../hooks/useGroupDiscovery';
import { usePaidDmRequests } from '../hooks/usePaidDmRequests';
import { useGroupActivityOrder } from '../hooks/useGroupActivityOrder';
import { useUserFeed } from '../hooks/useUserFeed';
import { useAuthenticatedAddress, useMySocialAuth } from '../contexts/MySocialAuthContext';
import { AgentConversationsPanel } from './AgentConversationsPanel';
import { PaidMessagingSettings } from './PaidMessagingSettings';
import { AgentDevSendPanel } from './AgentDevSendPanel';
import { useAgentConversations } from '../hooks/useAgentConversations';

interface AuthenticatedAppProps {
  isUsingDevMessengerSigner: boolean;
}

export function AuthenticatedApp({
  isUsingDevMessengerSigner,
}: Readonly<AuthenticatedAppProps>) {
  const address = useAuthenticatedAddress();
  const { keypair } = useMySocialAuth();

  const agentConversations = useAgentConversations();

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

  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const selectedGroup =
    groups.find(
      (g) => g.uuid === selectedUuid || g.groupId === selectedUuid,
    ) ?? null;

  // Stable view of the active conversation for user-feed handlers.
  const selectedGroupIdRef = useRef<string | null>(null);
  selectedGroupIdRef.current = selectedGroup?.groupId ?? null;

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
        setSelectedUuid(null);
      }
    },
  });

  const handleGroupCreated = useCallback(
    (uuid: string) => {
      refreshGroups();
      setSelectedUuid(uuid);
    },
    [refreshGroups],
  );

  const handleLeaveGroup = useCallback(() => {
    setSelectedUuid(null);
    refreshGroups();
  }, [refreshGroups]);

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
        <Sidebar
          groups={sortedGroups}
          selectedUuid={selectedUuid}
          unreadCounts={activity.counts}
          paidDmGroupIds={paidDmGroupIds}
          onSelectGroup={setSelectedUuid}
          onCreateGroup={() => setShowCreateModal(true)}
          loading={discoveryLoading}
          agentPanel={
            <AgentConversationsPanel
              conversations={agentConversations.conversations}
              loading={agentConversations.loading}
              error={agentConversations.error}
              onSelectGroup={(groupId) => {
                const match = groups.find((g) => g.groupId === groupId);
                setSelectedUuid(match?.uuid ?? groupId);
              }}
            />
          }
          settingsPanel={<PaidMessagingSettings />}
        />
        <ChatArea
          selectedGroup={selectedGroup}
          onLeaveGroup={handleLeaveGroup}
          onReadStateChanged={activity.markRead}
          onGroupActivity={
            selectedGroup
              ? (order) => activity.recordActivity(selectedGroup.groupId, order)
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
