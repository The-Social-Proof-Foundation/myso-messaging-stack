import { useState, useCallback } from 'react';
import { ConnectButton, useCurrentAccount } from '@socialproof/dapp-kit';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { CreateGroupModal } from './components/CreateGroupModal';
import { useGroupDiscovery } from './hooks/useGroupDiscovery';

function App() {
  const account = useCurrentAccount();

  const {
    groups,
    loading: discoveryLoading,
    refresh: refreshGroups,
  } = useGroupDiscovery(account?.address);

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
    <div className="flex h-screen flex-col bg-secondary-50 dark:bg-secondary-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-secondary-200 bg-white px-6 py-3 dark:border-secondary-700 dark:bg-secondary-800">
        <h1 className="text-lg font-semibold text-primary-600 dark:text-primary-400">
          MySo Messaging Chat
        </h1>
        <ConnectButton />
      </header>

      {/* Body */}
      {account ? (
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            groups={groups}
            selectedUuid={selectedUuid}
            onSelectGroup={setSelectedUuid}
            onCreateGroup={() => setShowCreateModal(true)}
            loading={discoveryLoading}
          />
          <ChatArea selectedGroup={selectedGroup} onLeaveGroup={handleLeaveGroup} />
        </div>
      ) : (
        <main className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-secondary-500 dark:text-secondary-400">
              Connect your wallet to get started.
            </p>
          </div>
        </main>
      )}

      {/* Create group modal */}
      {account && (
        <CreateGroupModal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onGroupCreated={handleGroupCreated}
        />
      )}
    </div>
  );
}

export default App;
