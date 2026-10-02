import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, X } from 'lucide-react';
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
  fetchFollowingProfiles,
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
  onPermsChange: (permValues: string[]) => void;
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
  onPermsChange,
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
  // People the user follows — shown as a browsable list before a search/selection.
  const [suggestions, setSuggestions] = useState<RecipientPeer[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(true);

  // Load recommended (following) peers once the picker mounts. Stays lazy on
  // re-runs (loading already starts true) so a refetch never flashes the list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const peers = await fetchFollowingProfiles(selfWallet);
      const filtered = peers.filter(
        (p) => !excludeKeys.has(p.wallet.toLowerCase()),
      );
      const annotated = await annotatePeersBlocked(selfWallet, filtered);
      if (cancelled) return;
      setSuggestions(annotated);
      setLoadingSuggestions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selfWallet, excludeKeys]);

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

  // Before a search or a pick, fill the dialog with people to choose from.
  const showSuggestions = !query.trim() && !selectedPeer;

  const permsDisabled = adding || addressBlocked;
  const allPermValues = messagingPermTypes.map((p) => p.value);
  const allPermsSelected =
    messagingPermTypes.length > 0 &&
    selectedPerms.length === messagingPermTypes.length;
  const permsSummary =
    selectedPerms.length === 0
      ? 'No permissions selected'
      : allPermsSelected
        ? `All ${messagingPermTypes.length} permissions`
        : `${selectedPerms.length} of ${messagingPermTypes.length} permissions`;

  function togglePerm(permValue: string) {
    onPermsChange(
      selectedPerms.includes(permValue)
        ? selectedPerms.filter((p) => p !== permValue)
        : [...selectedPerms, permValue],
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, @username, or 0x…"
        disabled={adding}
        className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-1.5 text-xs text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100"
      />

      {showSuggestions && (
        // Fixed floor keeps the dialog a useful height with nothing selected.
        <div className="min-h-[15rem]">
          {loadingSuggestions ? (
            <p className="px-3 py-16 text-center text-xs text-secondary-500">
              Loading people…
            </p>
          ) : suggestions.length === 0 ? (
            <p className="px-4 py-16 text-center text-xs text-secondary-600 dark:text-secondary-500">
              Search for a username, name, or wallet address
            </p>
          ) : (
            <>
              <p className="mb-1.5 text-xs font-medium text-secondary-500 dark:text-secondary-400">
                Recommended
              </p>
              <div className="max-h-72 overflow-y-auto">
                <RecipientPickerRows
                  peers={suggestions}
                  busy={adding}
                  onAdd={pickPeer}
                />
              </div>
            </>
          )}
        </div>
      )}

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

      {selectedPeer && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild disabled={permsDisabled}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-secondary-300 bg-white px-3 py-1.5 text-left text-xs text-secondary-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100"
            >
              <span className="truncate">{permsSummary}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-secondary-400" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-[60] max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
            >
              <DropdownMenu.CheckboxItem
                checked={allPermsSelected}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() =>
                  onPermsChange(allPermsSelected ? [] : allPermValues)
                }
                className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-secondary-700 outline-none data-[highlighted]:bg-secondary-100 dark:text-secondary-200 dark:data-[highlighted]:bg-secondary-700"
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary-600 dark:text-primary-400">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span>Select all</span>
              </DropdownMenu.CheckboxItem>

              <DropdownMenu.Separator className="my-1 h-px bg-secondary-200 dark:bg-secondary-700" />

              {messagingPermTypes.map((perm) => (
                <DropdownMenu.CheckboxItem
                  key={perm.key}
                  checked={selectedPerms.includes(perm.value)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => togglePerm(perm.value)}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-xs text-secondary-600 outline-none data-[highlighted]:bg-secondary-100 dark:text-secondary-400 dark:data-[highlighted]:bg-secondary-700"
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary-600 dark:text-primary-400">
                    <DropdownMenu.ItemIndicator>
                      <Check className="h-3.5 w-3.5" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="truncate">{perm.key}</span>
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

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
  );
}
