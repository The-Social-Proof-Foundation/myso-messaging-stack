/**
 * localStorage-backed sidebar chrome: previews, peer wallets, profile bits.
 * Hydrate on open so the dialogue list paints without waiting on network/decrypt.
 */

const PREVIEW_KEY = 'chat-app-sidebar-previews';
const PEER_KEY = 'chat-app-sidebar-peers';
const PROFILE_KEY = 'chat-app-sidebar-profiles';

export type StoredSidebarPreview = {
  text: string;
  order: number;
  verified: boolean;
};

export type StoredSidebarProfile = {
  photo: string | null;
  label: string;
  showRing: boolean;
  ringPercent: number;
};

function walletKey(wallet: string | null | undefined): string | null {
  if (!wallet?.trim()) return null;
  return wallet.trim().toLowerCase();
}

function readMap<T>(storageKey: string, wallet: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const root = JSON.parse(raw) as Record<string, Record<string, T>>;
    const slice = root[wallet];
    return slice && typeof slice === 'object' ? slice : {};
  } catch {
    return {};
  }
}

function writeMap<T>(
  storageKey: string,
  wallet: string,
  slice: Record<string, T>,
): void {
  try {
    const raw = localStorage.getItem(storageKey);
    const root = raw
      ? (JSON.parse(raw) as Record<string, Record<string, T>>)
      : {};
    root[wallet] = slice;
    localStorage.setItem(storageKey, JSON.stringify(root));
  } catch {
    // Quota / private mode — ignore.
  }
}

export function loadSidebarPreviews(
  wallet: string | null | undefined,
): Map<string, StoredSidebarPreview> {
  const w = walletKey(wallet);
  const out = new Map<string, StoredSidebarPreview>();
  if (!w) return out;
  const slice = readMap<StoredSidebarPreview>(PREVIEW_KEY, w);
  for (const [groupId, entry] of Object.entries(slice)) {
    if (!entry || typeof entry.order !== 'number') continue;
    out.set(groupId, {
      text: typeof entry.text === 'string' ? entry.text : '',
      order: entry.order,
      verified: Boolean(entry.verified),
    });
  }
  return out;
}

export function saveSidebarPreviews(
  wallet: string | null | undefined,
  cache: Map<string, StoredSidebarPreview>,
): void {
  const w = walletKey(wallet);
  if (!w) return;
  const slice: Record<string, StoredSidebarPreview> = {};
  for (const [groupId, entry] of cache) {
    slice[groupId] = entry;
  }
  writeMap(PREVIEW_KEY, w, slice);
}

/** groupId → peer wallet (DM other party). */
export function loadSidebarPeers(
  wallet: string | null | undefined,
): Map<string, string> {
  const w = walletKey(wallet);
  const out = new Map<string, string>();
  if (!w) return out;
  const slice = readMap<string>(PEER_KEY, w);
  for (const [groupId, peer] of Object.entries(slice)) {
    if (typeof peer === 'string' && peer.trim()) {
      out.set(groupId, peer.trim().toLowerCase());
    }
  }
  return out;
}

export function saveSidebarPeers(
  wallet: string | null | undefined,
  peers: Map<string, string>,
): void {
  const w = walletKey(wallet);
  if (!w) return;
  const slice: Record<string, string> = {};
  for (const [groupId, peer] of peers) {
    if (peer) slice[groupId] = peer.toLowerCase();
  }
  writeMap(PEER_KEY, w, slice);
}

export function upsertSidebarPeer(
  wallet: string | null | undefined,
  groupId: string,
  peerAddress: string,
): void {
  const w = walletKey(wallet);
  if (!w || !groupId || !peerAddress) return;
  const peers = loadSidebarPeers(w);
  peers.set(groupId, peerAddress.toLowerCase());
  saveSidebarPeers(w, peers);
}

export function loadSidebarProfiles(
  wallet: string | null | undefined,
): Map<string, StoredSidebarProfile> {
  const w = walletKey(wallet);
  const out = new Map<string, StoredSidebarProfile>();
  if (!w) return out;
  const slice = readMap<StoredSidebarProfile>(PROFILE_KEY, w);
  for (const [address, entry] of Object.entries(slice)) {
    if (!entry || typeof entry.label !== 'string') continue;
    out.set(address.toLowerCase(), {
      photo: entry.photo ?? null,
      label: entry.label,
      showRing: Boolean(entry.showRing),
      ringPercent:
        typeof entry.ringPercent === 'number' ? entry.ringPercent : 0,
    });
  }
  return out;
}

export function saveSidebarProfiles(
  wallet: string | null | undefined,
  cache: Map<string, StoredSidebarProfile>,
): void {
  const w = walletKey(wallet);
  if (!w) return;
  const slice: Record<string, StoredSidebarProfile> = {};
  for (const [address, entry] of cache) {
    slice[address.toLowerCase()] = entry;
  }
  writeMap(PROFILE_KEY, w, slice);
}
