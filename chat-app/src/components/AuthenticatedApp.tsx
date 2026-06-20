import { useState, useCallback } from 'react';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { CreateGroupModal } from './CreateGroupModal';
import { useGroupDiscovery } from '../hooks/useGroupDiscovery';
import { useUnreadCounts } from '../hooks/useUnreadCounts';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';

interface AuthenticatedAppProps {
  isUsingDevMessengerSigner: boolean;
}

export function AuthenticatedApp({
  isUsingDevMessengerSigner,
}: Readonly<AuthenticatedAppProps>) {
  const address = useAuthenticatedAddress();

  const {
    groups,
    loading: discoveryLoading,
    refresh: refreshGroups,
  } = useGroupDiscovery(address);

  const unreadCounts = useUnreadCounts(groups);

  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  const selectedGroup =
    groups.find(
      (g) => g.uuid === selectedUuid || g.groupId === selectedUuid,
    ) ?? null;

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
          groups={groups}
          selectedUuid={selectedUuid}
          unreadCounts={unreadCounts}
          onSelectGroup={setSelectedUuid}
          onCreateGroup={() => setShowCreateModal(true)}
          loading={discoveryLoading}
        />
        <ChatArea selectedGroup={selectedGroup} onLeaveGroup={handleLeaveGroup} />
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
