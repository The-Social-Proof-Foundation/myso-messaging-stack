import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  useGraphQLClient,
  useRequiredMessagingClient,
} from '../../contexts/MessagingClientContext';
import {
  annotatePeersBlocked,
  checkEitherBlocked,
} from '../../lib/block-check';
import {
  type RecipientPeer,
  normalizeMysoWalletQuery,
  peerCapsuleLabel,
  searchProfiles,
} from '../../lib/recipient-picker';
import {
  PROFILE_FULL_QUERY,
  mapGraphqlProfile,
} from '../../lib/wallet-profile';
import { BlockedPeerBadge } from '../BlockedPeerBadge';
import { RecipientPickerRows } from '../RecipientPickerRows';

interface PermType {
  key: string;
  value: string;
}

interface AddMemberFormProps {
  newAddress: string;
  selectedPerms: string[];
  adding: boolean;
  addError: string | null;
  messagingPermTypes: PermType[];
  /** Wallets already in the group (excluded from search results). */
  existingMemberAddresses?: readonly string[];
  onAddressChange: (address: string) => void;
  onTogglePerm: (permValue: string) => void;
  onSelectAllPerms: () => void;
  onSubmit: (e: React.SyntheticEvent) => void;
  /** When true, parent should refuse submit. */
  onBlockedChange?: (blocked: boolean) => void;
}

export function AddMemberForm({
  newAddress,
  selectedPerms,
  adding,
  addError,
  messagingPermTypes,
  existingMemberAddresses = [],
  onAddressChange,
  onTogglePerm,
  onSelectAllPerms,
  onSubmit,
  onBlockedChange,
}: Readonly<AddMemberFormProps>) {
  const { signer } = useRequiredMessagingClient();
  const graphqlClient = useGraphQLClient();
  const selfWallet = signer.toMySoAddress().toLowerCase();

  const excludeKeys = useMemo(() => {
    const set = new Set(
      existingMemberAddresses.map((a) => a.toLowerCase()).filter(Boolean),
    );
    set.add(selfWallet);
    return set;
  }, [existingMemberAddresses, selfWallet]);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecipientPeer[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<RecipientPeer | null>(null);
  const [addressBlocked, setAddressBlocked] = useState(false);

  // Parent clears `newAddress` after a successful add — drop the tag too.
  useEffect(() => {
    if (!newAddress.trim()) {
      setSelectedPeer(null);
    }
  }, [newAddress]);

  // Debounced search / wallet resolve — never load a following list.
  useEffect(() => {
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
            if (excludeKeys.has(wallet)) {
              if (!cancelled) setSearchResults([]);
              return;
            }
            let peers: RecipientPeer[];
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
              if (mapped) {
                peers = [
                  {
                    wallet: mapped.owner_address.toLowerCase(),
                    username: mapped.username,
                    displayName: mapped.display_name,
                    photoURL: mapped.profile_photo,
                    isCardless: false,
                  },
                ];
              } else {
                peers = [
                  {
                    wallet,
                    username: null,
                    displayName: null,
                    photoURL: null,
                    isCardless: true,
                  },
                ];
              }
            } catch {
              peers = [
                {
                  wallet,
                  username: null,
                  displayName: null,
                  photoURL: null,
                  isCardless: true,
                },
              ];
            }
            const annotated = await annotatePeersBlocked(selfWallet, peers);
            if (!cancelled) setSearchResults(annotated);
            return;
          }
          const found = await searchProfiles(trimmed);
          const filtered = found.filter(
            (p) => !excludeKeys.has(p.wallet.toLowerCase()),
          );
          const annotated = await annotatePeersBlocked(selfWallet, filtered);
          if (!cancelled) setSearchResults(annotated);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, selfWallet, graphqlClient, excludeKeys]);

  useEffect(() => {
    const address = newAddress.trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(address)) {
      setAddressBlocked(false);
      onBlockedChange?.(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const blocked = await checkEitherBlocked(selfWallet, address);
      if (cancelled) return;
      setAddressBlocked(blocked);
      onBlockedChange?.(blocked);
    })();
    return () => {
      cancelled = true;
    };
  }, [newAddress, selfWallet, onBlockedChange]);

  function pickPeer(peer: RecipientPeer) {
    if (peer.blocked) return;
    const key = peer.wallet.toLowerCase();
    if (excludeKeys.has(key)) return;
    setSelectedPeer({ ...peer, wallet: key });
    onAddressChange(key);
    setQuery('');
    setSearchResults([]);
  }

  function clearSelected() {
    setSelectedPeer(null);
    onAddressChange('');
    setAddressBlocked(false);
    onBlockedChange?.(false);
  }

  const submitDisabled =
    adding || addressBlocked || !/^0x[a-fA-F0-9]{64}$/.test(newAddress.trim());

  const showSearchPanel = Boolean(query.trim()) && (searching || searchResults.length > 0);

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Add Member
      </h4>

      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, @username, or 0x…"
          disabled={adding}
          className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-1.5 text-xs text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100"
        />

        {showSearchPanel && (
          <div className="max-h-48 overflow-y-auto">
            {searching && searchResults.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-secondary-500">
                Searching…
              </p>
            ) : searchResults.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-secondary-500">
                No matches
              </p>
            ) : (
              <RecipientPickerRows
                peers={searchResults}
                busy={adding}
                onAdd={pickPeer}
              />
            )}
          </div>
        )}

        {selectedPeer && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-medium text-secondary-800 dark:bg-secondary-700 dark:text-secondary-100">
              {selectedPeer.photoURL ? (
                <img
                  src={selectedPeer.photoURL}
                  alt=""
                  className="h-5 w-5 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary-300 text-[10px] dark:bg-secondary-600">
                  {(peerCapsuleLabel(selectedPeer)[0] ?? '?').toUpperCase()}
                </span>
              )}
              <span className="max-w-[160px] truncate">
                {peerCapsuleLabel(selectedPeer)}
              </span>
              <button
                type="button"
                onClick={clearSelected}
                disabled={adding}
                aria-label={`Remove ${peerCapsuleLabel(selectedPeer)}`}
                className="rounded-full p-0.5 text-secondary-500 hover:bg-secondary-200 hover:text-secondary-900 disabled:opacity-50 dark:hover:bg-secondary-600 dark:hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
            {addressBlocked && <BlockedPeerBadge />}
          </div>
        )}

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-secondary-600 dark:text-secondary-400">
            <input
              type="checkbox"
              checked={selectedPerms.length === messagingPermTypes.length}
              onChange={onSelectAllPerms}
              disabled={adding || addressBlocked}
              className="rounded"
            />
            <span className="font-medium">Select All</span>
          </label>
          {messagingPermTypes.map((perm) => (
            <label
              key={perm.key}
              className="flex items-center gap-2 text-xs text-secondary-600 dark:text-secondary-400"
            >
              <input
                type="checkbox"
                checked={selectedPerms.includes(perm.value)}
                onChange={() => onTogglePerm(perm.value)}
                disabled={adding || addressBlocked}
                className="rounded"
              />
              {perm.key}
            </label>
          ))}
        </div>

        {addressBlocked && (
          <p className="text-xs text-danger-500">
            You cannot add this user (blocked).
          </p>
        )}
        {addError && <p className="text-xs text-danger-500">{addError}</p>}

        <button
          type="submit"
          disabled={submitDisabled}
          className="w-full rounded-lg bg-primary-500 py-1.5 text-xs font-medium text-white hover:bg-primary-600 disabled:opacity-50"
        >
          {adding ? 'Adding...' : 'Add Member'}
        </button>
      </form>
    </section>
  );
}
