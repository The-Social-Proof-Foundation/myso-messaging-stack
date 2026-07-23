import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { X } from 'lucide-react';
import { MYSO_CLOCK_OBJECT_ID } from '@socialproof/myso/utils';
import { createPaidMessagingClient } from '@socialproof/myso-messaging-stack';
import {
  useGraphQLClient,
  useRequiredMessagingClient,
} from '../contexts/MessagingClientContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { addStoredGroup } from '../lib/group-store';
import { formatCreateGroupError } from '../lib/format-create-group-error';
import { grantDefaultPeerPermissions } from '../lib/grant-default-peer-permissions';
import { waitForGroupReady } from '../lib/wait-for-relayer-membership';
import {
  assertMemoryRegistryConfigured,
  expectedCreateGroupObjectIds,
  expectedPaidDmObjectIds,
  fetchAndLogGenesisConfig,
  logClientDeriveIds,
  logCreateGroupTxInputs,
  logFullGenesisClientMismatch,
  logMyDataKeyServers,
  logSignerGasCoins,
  STALE_GHOST_OBJECT_ID,
  verifyCreateGroupObjectsOnRpc,
} from '../lib/messaging-genesis-debug';
import {
  PROFILE_FULL_QUERY,
  buildAutoGroupName,
  dedupeAddresses,
  groupNameLabelForRecipient,
  mapGraphqlProfile,
} from '../lib/wallet-profile';
import {
  type RecipientPeer,
  fetchFollowingProfiles,
  normalizeMysoWalletQuery,
  peerCapsuleLabel,
  peerRowSubtitle,
  peerRowTitle,
  searchProfiles,
} from '../lib/recipient-picker';
import { PaymentConfirmDialog } from './PaymentConfirmDialog';

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onGroupCreated: (uuid: string) => void;
}

/** New 1:1 DM waiting on the user to confirm the paid-messaging escrow. */
interface PendingPaidDm {
  recipient: string;
  minCost: bigint;
  name: string;
}

export function CreateGroupModal({
  open,
  onClose,
  onGroupCreated,
}: Readonly<CreateGroupModalProps>) {
  const { signer, createFreshMessagingClient } = useRequiredMessagingClient();
  const graphqlClient = useGraphQLClient();
  const selfWallet = signer.toMySoAddress().toLowerCase();

  const [selected, setSelected] = useState<RecipientPeer[]>([]);
  const [query, setQuery] = useState('');
  const [following, setFollowing] = useState<RecipientPeer[]>([]);
  const [searchResults, setSearchResults] = useState<RecipientPeer[]>([]);
  const [loadingFollowing, setLoadingFollowing] = useState(false);
  const [searching, setSearching] = useState(false);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pendingPaidDm, setPendingPaidDm] = useState<PendingPaidDm | null>(null);
  const [payingDm, setPayingDm] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const selectedKeys = useMemo(
    () => new Set(selected.map((p) => p.wallet.toLowerCase())),
    [selected],
  );

  const resetPicker = useCallback(() => {
    setSelected([]);
    setQuery('');
    setSearchResults([]);
    setError(null);
    setPendingPaidDm(null);
    setPayError(null);
  }, []);

  // Load following when opened.
  useEffect(() => {
    if (!open) return;
    resetPicker();
    let cancelled = false;
    setLoadingFollowing(true);
    void (async () => {
      const peers = await fetchFollowingProfiles(selfWallet);
      if (cancelled) return;
      setFollowing(
        peers.filter((p) => p.wallet.toLowerCase() !== selfWallet),
      );
      setLoadingFollowing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selfWallet, resetPicker]);

  // Debounced search / wallet resolve (~450ms, iOS parity).
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const wallet = normalizeMysoWalletQuery(trimmed);
          if (wallet) {
            if (wallet === selfWallet) {
              if (!cancelled) setSearchResults([]);
              return;
            }
            try {
              const result = await graphqlClient.query({
                query: PROFILE_FULL_QUERY as unknown as Parameters<
                  typeof graphqlClient.query
                >[0]['query'],
                variables: { address: wallet },
              });
              const data = result.data as
                | { profile?: Record<string, unknown> | null }
                | undefined;
              const mapped = mapGraphqlProfile(data?.profile ?? null);
              if (cancelled) return;
              if (mapped) {
                setSearchResults([
                  {
                    wallet: mapped.owner_address.toLowerCase(),
                    username: mapped.username,
                    displayName: mapped.display_name,
                    photoURL: mapped.profile_photo,
                    isCardless: false,
                  },
                ]);
              } else {
                setSearchResults([
                  {
                    wallet,
                    username: null,
                    displayName: null,
                    photoURL: null,
                    isCardless: true,
                  },
                ]);
              }
            } catch {
              if (!cancelled) {
                setSearchResults([
                  {
                    wallet,
                    username: null,
                    displayName: null,
                    photoURL: null,
                    isCardless: true,
                  },
                ]);
              }
            }
            return;
          }
          const found = await searchProfiles(trimmed);
          if (cancelled) return;
          setSearchResults(
            found.filter((p) => p.wallet.toLowerCase() !== selfWallet),
          );
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, selfWallet, graphqlClient]);

  // Escape to dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !loading && !syncing && !payingDm) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, syncing, payingDm, onClose]);

  const listPeers = useMemo(() => {
    const source = query.trim() ? searchResults : following;
    return source.filter((p) => !selectedKeys.has(p.wallet.toLowerCase()));
  }, [query, searchResults, following, selectedKeys]);

  function addPeer(peer: RecipientPeer) {
    const key = peer.wallet.toLowerCase();
    if (key === selfWallet || selectedKeys.has(key)) return;
    setSelected((prev) => [...prev, { ...peer, wallet: key }]);
    setQuery('');
    setSearchResults([]);
    setError(null);
  }

  function removePeer(wallet: string) {
    const key = wallet.toLowerCase();
    setSelected((prev) => prev.filter((p) => p.wallet.toLowerCase() !== key));
  }

  async function resolveGroupName(addresses: string[]): Promise<string> {
    const labels = await Promise.all(
      addresses.map(async (address) => {
        try {
          const result = await graphqlClient.query({
            query: PROFILE_FULL_QUERY as unknown as Parameters<
              typeof graphqlClient.query
            >[0]['query'],
            variables: { address },
          });
          const data = result.data as
            | { profile?: Record<string, unknown> | null }
            | undefined;
          const mapped = mapGraphqlProfile(data?.profile ?? null);
          return groupNameLabelForRecipient(address, mapped);
        } catch {
          return groupNameLabelForRecipient(address, null);
        }
      }),
    );
    return buildAutoGroupName(labels);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const initialMembers = selected.map((p) => p.wallet.toLowerCase());
    if (initialMembers.length === 0) {
      setError('Add at least one recipient.');
      return;
    }

    setLoading(true);

    try {
      const sender = signer.toMySoAddress();
      const groupName = await resolveGroupName(
        dedupeAddresses([...initialMembers, sender]),
      );
      const uuid = crypto.randomUUID();

      const client = await createFreshMessagingClient({
        bypassGenesisCache: true,
      });

      const freshGenesis = await fetchAndLogGenesisConfig(
        client,
        'create-group (fresh client + graphql)',
        { bypassCache: true },
      );
      const expectedObjects = expectedCreateGroupObjectIds(freshGenesis);
      assertMemoryRegistryConfigured('create-group', freshGenesis);

      logClientDeriveIds('create-group (fresh client)', client.messaging.derive, uuid);
      logFullGenesisClientMismatch('create-group', freshGenesis, client);
      await verifyCreateGroupObjectsOnRpc('create-group', expectedObjects, client);
      await logMyDataKeyServers('create-group', client);
      await logSignerGasCoins('create-group', client, signer);

      if (initialMembers.length === 1) {
        const recipient = initialMembers[0]!;
        try {
          const gate = await client.messaging.checkDmGate({
            signer,
            recipient,
          });
          if (gate.blocked) {
            setError('You cannot message this user.');
            return;
          }
          if (gate.reason === 'PAYMENT_REQUIRED' && gate.minCost !== null) {
            setPayError(null);
            setPendingPaidDm({
              recipient,
              minCost: gate.minCost,
              name: groupName,
            });
            return;
          }
        } catch (gateErr) {
          console.warn('[chat-app] dm-gate pre-check unavailable:', gateErr);
        }
      }

      let resolvedMemoryAccountId: string | null | undefined;
      if (import.meta.env.DEV) {
        resolvedMemoryAccountId =
          await client.messaging.view.memoryAccountIdForOwner({ owner: sender });
      }

      const tx = client.messaging.tx.createAndShareGroup({
        uuid,
        name: groupName,
        sender,
        initialMembers,
      });

      await logCreateGroupTxInputs(
        'create-group (pre-sign)',
        tx,
        client,
        expectedObjects,
        { resolvedMemoryAccountId },
      );

      await signAndExecuteTransactionAndWait(client, signer, tx);

      const groupId = client.messaging.derive.groupId({ uuid });

      setSyncing(true);
      await waitForGroupReady({
        client,
        signer,
        groupId,
        uuid,
        memberAddress: sender,
      });

      await grantDefaultPeerPermissions({
        client,
        signer,
        groupId,
        peers: initialMembers.filter(
          (addr) => addr.toLowerCase() !== sender.toLowerCase(),
        ),
      });

      addStoredGroup({
        uuid,
        name: groupName,
        groupId,
        createdAt: Date.now(),
      });

      resetPicker();
      onGroupCreated(uuid);
      onClose();
    } catch (err) {
      console.error('Failed to create group:', err);
      if (
        err instanceof Error &&
        err.message.includes(STALE_GHOST_OBJECT_ID)
      ) {
        console.error(
          `[chat-app] create-group failed on stale object ${STALE_GHOST_OBJECT_ID}. ` +
            'Check "[chat-app] create-group tx inputs" and "[chat-app] messaging genesis" above.',
        );
      }
      setError(formatCreateGroupError(err));
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }

  async function handleConfirmPaidDm() {
    if (!pendingPaidDm) return;

    setPayingDm(true);
    setPayError(null);

    try {
      const client = await createFreshMessagingClient({
        bypassGenesisCache: true,
      });
      const paid = createPaidMessagingClient({ messaging: client.messaging });

      const freshGenesis = await fetchAndLogGenesisConfig(
        client,
        'open-paid-dm (fresh client + graphql)',
        { bypassCache: true },
      );
      const expectedObjects = expectedPaidDmObjectIds(freshGenesis);
      assertMemoryRegistryConfigured('open-paid-dm', freshGenesis);

      const uuid = crypto.randomUUID();
      logClientDeriveIds('open-paid-dm (fresh client)', client.messaging.derive, uuid);
      logFullGenesisClientMismatch('open-paid-dm', freshGenesis, client);
      await verifyCreateGroupObjectsOnRpc('open-paid-dm', expectedObjects, client);
      await logMyDataKeyServers('open-paid-dm', client);
      await logSignerGasCoins('open-paid-dm', client, signer);

      const sender = signer.toMySoAddress();

      let resolvedMemoryAccountId: string | null | undefined;
      if (import.meta.env.DEV) {
        resolvedMemoryAccountId =
          await client.messaging.view.memoryAccountIdForOwner({ owner: sender });
      }

      const { transaction, groupId } = paid.buildOpenPaidDm({
        sender,
        recipient: pendingPaidDm.recipient,
        escrowAmount: pendingPaidDm.minCost,
        name: pendingPaidDm.name,
        uuid,
        creatorMemoryAccountId: resolvedMemoryAccountId ?? undefined,
      });

      await logCreateGroupTxInputs(
        'open-paid-dm (pre-sign)',
        transaction,
        client,
        {
          ...expectedObjects,
          clockId: MYSO_CLOCK_OBJECT_ID,
        },
        { resolvedMemoryAccountId },
      );

      await signAndExecuteTransactionAndWait(client, signer, transaction);

      setSyncing(true);
      await waitForGroupReady({
        client,
        signer,
        groupId,
        uuid,
        memberAddress: sender,
      });

      await grantDefaultPeerPermissions({
        client,
        signer,
        groupId,
        peers: [pendingPaidDm.recipient],
      });

      addStoredGroup({
        uuid,
        name: pendingPaidDm.name,
        groupId,
        createdAt: Date.now(),
      });

      resetPicker();
      setPendingPaidDm(null);
      onGroupCreated(uuid);
      onClose();
    } catch (err) {
      console.error('Failed to open paid DM:', err);
      if (
        err instanceof Error &&
        err.message.includes(STALE_GHOST_OBJECT_ID)
      ) {
        console.error(
          `[chat-app] open-paid-dm failed on stale object ${STALE_GHOST_OBJECT_ID}. ` +
            'Check "[chat-app] create-group tx inputs — open-paid-dm (pre-sign)" and ' +
            '"[chat-app] messaging genesis" above.',
        );
      }
      setPayError(formatCreateGroupError(err));
    } finally {
      setPayingDm(false);
      setSyncing(false);
    }
  }

  if (!open) return null;

  const busy = loading || syncing || payingDm;
  const emptyQuery = !query.trim();
  const listEmptyLabel = emptyQuery
    ? loadingFollowing
      ? 'Loading…'
      : 'Search for a username, name, or wallet address to start'
    : searching
      ? 'Searching…'
      : 'No people found';
  const isIdleEmptyHint = emptyQuery && !loadingFollowing && listPeers.length === 0;

  function onBackdropClick() {
    if (!busy) onClose();
  }

  function onDialogKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-message-title"
      >
        <div className="relative mb-4 flex items-center justify-center">
          <h2
            id="new-message-title"
            className="font-chakra text-lg font-semibold tracking-wide text-secondary-900 dark:text-secondary-100"
          >
            New Message
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-secondary-500 hover:bg-secondary-100 hover:text-secondary-800 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700 dark:hover:text-secondary-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div>
            {/* <label
              htmlFor="recipient-search"
              className="mb-1 block text-sm font-medium text-secondary-700 dark:text-secondary-300"
            >
              Recipients <span className="text-danger-500">*</span>
            </label> */}
            <input
              id="recipient-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search username, name, or address"
              disabled={busy}
              autoComplete="off"
              className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500"
            />
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selected.map((peer) => (
                <span
                  key={peer.wallet}
                  className="inline-flex items-center gap-1.5 rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-medium text-secondary-800 dark:bg-secondary-700 dark:text-secondary-100"
                >
                  {peer.photoURL ? (
                    <img
                      src={peer.photoURL}
                      alt=""
                      className="h-5 w-5 rounded-full object-cover"
                    />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary-300 text-[10px] dark:bg-secondary-600">
                      {(peerCapsuleLabel(peer)[0] ?? '?').toUpperCase()}
                    </span>
                  )}
                  <span className="max-w-[140px] truncate">
                    {peerCapsuleLabel(peer)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removePeer(peer.wallet)}
                    disabled={busy}
                    aria-label={`Remove ${peerCapsuleLabel(peer)}`}
                    className="rounded-full p-0.5 text-secondary-500 hover:bg-secondary-200 hover:text-secondary-900 disabled:opacity-50 dark:hover:bg-secondary-600 dark:hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div
            className={
              listPeers.length === 0
                ? 'mb-6 max-h-72 overflow-y-auto'
                : 'mb-6 max-h-72 min-h-[12rem] overflow-y-auto rounded-lg border border-secondary-200 dark:border-secondary-600'
            }
          >
            {listPeers.length === 0 ? (
              <p
                className={
                  isIdleEmptyHint
                    ? 'px-4 py-16 text-center text-xs text-secondary-600 dark:text-secondary-500'
                    : 'px-3 py-16 text-center text-sm text-secondary-600 dark:text-secondary-500'
                }
              >
                {listEmptyLabel}
              </p>
            ) : (
              <ul className="divide-y divide-secondary-200 dark:divide-secondary-600">
                {listPeers.map((peer) => (
                  <li key={peer.wallet}>
                    <button
                      type="button"
                      onClick={() => addPeer(peer)}
                      disabled={busy}
                      className="flex w-full items-center gap-3 bg-secondary-100 px-3 py-3.5 text-left hover:bg-secondary-200/80 disabled:opacity-50 dark:bg-secondary-600 dark:hover:bg-secondary-500/70"
                    >
                      {peer.photoURL ? (
                        <img
                          src={peer.photoURL}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-200 text-xs font-medium text-secondary-700 dark:bg-secondary-500 dark:text-secondary-100">
                          {(peerRowTitle(peer)[0] ?? '?').toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-secondary-900 dark:text-secondary-100">
                          {peerRowTitle(peer)}
                        </span>
                        <span className="block truncate text-xs text-secondary-500 dark:text-secondary-300">
                          {peer.isCardless
                            ? 'No profile — wallet only'
                            : peerRowSubtitle(peer)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <p className="mb-3 text-sm text-danger-500">{error}</p>}

          <button
            type="submit"
            disabled={busy || selected.length === 0}
            className="w-full rounded-lg bg-primary-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
          >
            {syncing
              ? 'Syncing membership…'
              : loading
                ? 'Creating…'
                : 'Create'}
          </button>
        </form>
      </div>

      <PaymentConfirmDialog
        open={pendingPaidDm !== null}
        recipient={pendingPaidDm?.recipient ?? null}
        minCost={pendingPaidDm?.minCost ?? null}
        busy={payingDm || syncing}
        error={payError}
        onConfirm={() => void handleConfirmPaidDm()}
        onCancel={() => {
          setPendingPaidDm(null);
          setPayError(null);
        }}
      />
    </div>
  );
}
