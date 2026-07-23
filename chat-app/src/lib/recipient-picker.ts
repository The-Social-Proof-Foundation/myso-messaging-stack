/**
 * Recipient picker helpers for New Message — iOS CreateConversationSheet parity.
 * Following + search via social indexer; wallet normalize for 0x… paste.
 */

import { normalizeExternalImageUrl } from './wallet-profile';

export type RecipientPeer = {
  wallet: string;
  username: string | null;
  displayName: string | null;
  photoURL: string | null;
  isCardless: boolean;
};

function socialServerBase(): string {
  return (import.meta.env.VITE_SOCIAL_SERVER_URL || 'http://127.0.0.1:9126').replace(
    /\/+$/,
    '',
  );
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * MySo address → canonical `0x` + 64 hex (iOS CreateConversationWalletDetect).
 * Rejects truncated UI pastes with ellipsis.
 */
export function normalizeMysoWalletQuery(raw: string): string | null {
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return null;
  if (raw.includes('…') || raw.includes('...')) return null;

  let hex = lowered;
  const hadPrefix = hex.startsWith('0x');
  if (hadPrefix) hex = hex.slice(2);
  hex = hex.replace(/\s/g, '');
  hex = [...hex].filter((c) => /[0-9a-f]/.test(c)).join('');
  if (!hex || hex.length > 64) return null;

  const looksLikeWallet = hadPrefix || hex.length === 64;
  if (!looksLikeWallet) return null;

  const padded = hex.padStart(64, '0');
  return `0x${padded}`;
}

export function peerCapsuleLabel(peer: RecipientPeer): string {
  if (peer.username) return `@${peer.username.replace(/^@/, '')}`;
  if (peer.displayName) return peer.displayName;
  const a = peer.wallet;
  if (a.length > 12) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a;
}

export function peerRowTitle(peer: RecipientPeer): string {
  if (peer.displayName) return peer.displayName;
  if (peer.username) return `@${peer.username.replace(/^@/, '')}`;
  return peer.isCardless ? 'Wallet address' : peerCapsuleLabel(peer);
}

export function peerRowSubtitle(peer: RecipientPeer): string {
  if (peer.username) return `@${peer.username.replace(/^@/, '')}`;
  const a = peer.wallet;
  if (a.length > 16) return `${a.slice(0, 8)}…${a.slice(-8)}`;
  return a;
}

function peerFromFollowRaw(raw: Record<string, unknown>): RecipientPeer | null {
  const p =
    raw.profile && typeof raw.profile === 'object'
      ? { ...(raw.profile as Record<string, unknown>), ...raw }
      : raw;
  const wallet = (
    asStr(p.owner_address) ??
    asStr(p.wallet_address) ??
    asStr(p.address) ??
    ''
  ).toLowerCase();
  if (!wallet) return null;
  const displayName =
    asStr(p.display_name) ??
    asStr(p.displayName) ??
    asStr(p.fullname) ??
    asStr(p.full_name) ??
    asStr(p.name);
  return {
    wallet,
    username: asStr(p.username),
    displayName,
    photoURL: normalizeExternalImageUrl(p.profile_photo ?? p.profilePhoto),
    isCardless: false,
  };
}

/** `GET /profiles/{wallet}/following` — empty list on 404 / missing indexer. */
export async function fetchFollowingProfiles(
  wallet: string,
  limit = 50,
): Promise<RecipientPeer[]> {
  const base = socialServerBase();
  if (!base || !wallet) return [];
  const encoded = encodeURIComponent(wallet.toLowerCase());
  const url = new URL(`${base}/profiles/${encoded}/following`);
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', String(limit));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const data = (await res.json()) as { profiles?: unknown };
    const raw = Array.isArray(data.profiles) ? data.profiles : [];
    return raw
      .map((p) =>
        p && typeof p === 'object'
          ? peerFromFollowRaw(p as Record<string, unknown>)
          : null,
      )
      .filter((p): p is RecipientPeer => p != null);
  } catch {
    return [];
  }
}

type SearchResultWire = {
  entity_type?: string;
  entityType?: string;
  title?: string;
  primary_field?: string;
  secondary_field?: string;
  image_url?: string;
  owner_address?: string;
  address?: string;
  username?: string;
  display_name?: string;
  displayName?: string;
  profile_photo?: string;
  profilePhoto?: string;
};

function peerFromSearchWire(r: SearchResultWire): RecipientPeer | null {
  const wallet = (
    asStr(r.owner_address) ??
    asStr(r.address) ??
    asStr(r.secondary_field) ??
    ''
  ).toLowerCase();
  if (!wallet) return null;
  return {
    wallet,
    username: asStr(r.username) ?? asStr(r.primary_field),
    displayName:
      asStr(r.display_name) ?? asStr(r.displayName) ?? asStr(r.title),
    photoURL: normalizeExternalImageUrl(
      r.profile_photo ?? r.profilePhoto ?? r.image_url,
    ),
    isCardless: false,
  };
}

/**
 * Normalize indexer `/search` payloads.
 * mysocial-frontend + iOS accept either `{ data: { results } }` or `{ profiles: [] }`.
 */
function peersFromSearchJson(json: unknown): RecipientPeer[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const data =
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : null;

  const mapResultRows = (rows: unknown[]): RecipientPeer[] =>
    rows
      .filter((r): r is SearchResultWire => !!r && typeof r === 'object')
      .filter((r) => {
        const t = (r.entity_type ?? r.entityType ?? '').toLowerCase();
        return t === 'profile' || t === '';
      })
      .map(peerFromSearchWire)
      .filter((p): p is RecipientPeer => p != null);

  const mapProfileRows = (rows: unknown[]): RecipientPeer[] =>
    rows
      .map((p) =>
        p && typeof p === 'object'
          ? peerFromFollowRaw(p as Record<string, unknown>)
          : null,
      )
      .filter((p): p is RecipientPeer => p != null);

  const resultRows = (root.results ?? data?.results) as unknown;
  const profileRows = (root.profiles ?? data?.profiles) as unknown;

  // Prefer non-empty `results`; fall back to `{ profiles: [] }` (mysocial indexer).
  if (Array.isArray(resultRows) && resultRows.length > 0) {
    return mapResultRows(resultRows);
  }
  if (Array.isArray(profileRows)) {
    return mapProfileRows(profileRows);
  }
  if (Array.isArray(resultRows)) {
    return mapResultRows(resultRows);
  }
  return [];
}

/** `GET /search?q=…&filter_types=profile` — names, usernames, and addresses. */
export async function searchProfiles(
  query: string,
  limit = 20,
): Promise<RecipientPeer[]> {
  const base = socialServerBase();
  const bare = query.trim().replace(/^@/, '');
  if (!base || !bare) return [];
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', bare);
  url.searchParams.set('filter_types', 'profile');
  url.searchParams.set('page', '1');
  url.searchParams.set('limit', String(limit));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    return peersFromSearchJson(json);
  } catch {
    return [];
  }
}
