import { useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { CreateGroupModal } from './components/CreateGroupModal';
import { useGroupDiscovery } from './hooks/useGroupDiscovery';
import {
  useMessagingClientInitError,
  useMessagingClientLoading,
} from './contexts/MessagingClientContext';
import {
  useAuthenticatedAddress,
  useMySocialAuth,
} from './contexts/MySocialAuthContext';

function App() {
  const {
    auth,
    session,
    keypair,
    connectedAddress,
    configError,
    walletOnlyBlocked,
    isUsingDevMessengerSigner,
    deriveKeyError,
    derivingKeypair,
    signInError,
    login,
    logout,
  } = useMySocialAuth();

  const messagingClientInitError = useMessagingClientInitError();
  const messagingClientLoading = useMessagingClientLoading();

  const address = useAuthenticatedAddress();

  const {
    groups,
    loading: discoveryLoading,
    refresh: refreshGroups,
  } = useGroupDiscovery(address);

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

  const connected = Boolean(session && keypair);

  return (
    <div className="flex h-screen flex-col bg-secondary-50 dark:bg-secondary-900">
      <header className="flex items-center justify-between border-b border-secondary-200 bg-white px-6 py-3 dark:border-secondary-700 dark:bg-secondary-800">
        <h1 className="text-lg font-semibold text-primary-600 dark:text-primary-400">
          MySo Messaging Chat
        </h1>
        <div className="flex items-center gap-3">
          {session && connectedAddress && (
            <span
              className="max-w-[10rem] truncate text-xs text-secondary-500 dark:text-secondary-400"
              title={connectedAddress}
            >
              {connectedAddress.slice(0, 8)}…{connectedAddress.slice(-6)}
            </span>
          )}
          {session ? (
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              className="rounded-lg border border-secondary-300 px-3 py-1.5 text-sm font-medium text-secondary-700 hover:bg-secondary-50 dark:border-secondary-600 dark:text-secondary-200 dark:hover:bg-secondary-700"
            >
              Sign out
            </button>
          ) : auth ? (
            <button
              type="button"
              onClick={login}
              className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700"
            >
              Sign in with MySocial
            </button>
          ) : null}
        </div>
      </header>

      {configError && (
        <main className="flex flex-1 items-center justify-center px-8">
          <div className="max-w-md text-center text-sm text-danger-500">
            {configError}
          </div>
        </main>
      )}

      {!configError && auth && !session && (
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
          <p className="text-center text-secondary-600 dark:text-secondary-400">
            Sign in with your MySocial account to open your wallet and use
            messaging.
          </p>
          {signInError && (
            <p className="text-center text-sm text-danger-500">{signInError}</p>
          )}
        </main>
      )}

      {!configError &&
        auth &&
        session &&
        walletOnlyBlocked &&
        !keypair && (
        <main className="flex flex-1 items-center justify-center px-8">
          <p className="max-w-md text-center text-sm text-secondary-600 dark:text-secondary-400">
            This login is wallet-only. Use full MySocial sign-in (OAuth) so the
            app can derive your signing key, or set{' '}
            <code className="rounded bg-secondary-100 px-1 dark:bg-secondary-800">
              VITE_DEV_UNBLOCK_MESSAGING_UI=true
            </code>{' '}
            for a local dev signer.
          </p>
        </main>
      )}

      {!configError && auth && session && !walletOnlyBlocked && derivingKeypair && (
        <main className="flex flex-1 flex-col items-center justify-center gap-2">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <p className="text-sm text-secondary-500">Preparing signing key…</p>
        </main>
      )}

      {!configError &&
        auth &&
        session &&
        !walletOnlyBlocked &&
        !derivingKeypair &&
        deriveKeyError &&
        !keypair && (
          <main className="flex flex-1 items-center justify-center px-8">
            <div className="max-w-md text-center text-sm text-danger-500">
              {deriveKeyError}
            </div>
          </main>
        )}

      {!configError && connected && messagingClientLoading && (
        <main className="flex flex-1 flex-col items-center justify-center gap-2">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <p className="text-sm text-secondary-500">Initializing messaging client…</p>
        </main>
      )}

      {!configError && connected && messagingClientInitError && (
        <main className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto px-8">
          <p className="text-center text-sm font-medium text-danger-600">
            Messaging client failed to initialize (this often caused a blank page
            before; the error is shown below).
          </p>
          <pre className="max-h-[40vh] max-w-2xl overflow-auto whitespace-pre-wrap break-words rounded-lg border border-danger-200 bg-danger-50/80 p-4 text-left text-xs text-danger-900 dark:border-danger-800 dark:bg-danger-950/40 dark:text-danger-100">
            {messagingClientInitError}
          </pre>
          <p className="max-w-xl text-center text-xs text-secondary-600 dark:text-secondary-400">
            Genesis package IDs (0x2 / 0xe110 / 0x50c1) are resolved automatically.
            Check{' '}
            <code className="rounded bg-secondary-200 px-1 dark:bg-secondary-700">
              VITE_MYSO_RPC_URL
            </code>{' '}
            and{' '}
            <code className="rounded bg-secondary-200 px-1 dark:bg-secondary-700">
              VITE_MYSO_GRAPHQL_URL
            </code>{' '}
            point at a v112 genesis network with social bootstrap completed.
          </p>
        </main>
      )}

      {!configError &&
        connected &&
        !messagingClientLoading &&
        !messagingClientInitError && (
        <>
          {isUsingDevMessengerSigner && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              Dev signer: using a local ephemeral keypair (not your MySocial
              wallet salt key). On-chain actions use this address/fund it on
              localnet as needed.
            </div>
          )}
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
          {showCreateModal && (
            <CreateGroupModal
              open
              onClose={() => setShowCreateModal(false)}
              onGroupCreated={handleGroupCreated}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
