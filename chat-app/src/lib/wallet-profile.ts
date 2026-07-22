/**
 * ProfileFull GraphQL + mappers — mirrored from mysocial-frontend
 * (`lib/graphql/profile-full.ts`, `lib/wallet-profile-graphql.ts`).
 */

export const PROFILE_FULL_QUERY = `
  query ProfileFull($address: MySoAddress!) {
    profile(address: $address) {
      id
      address
      username
      displayName
      bio
      profilePhoto
      coverPhoto
      website
      createdAt
      updatedAt
      profileId
      followersCount
      followingCount
      postCount
      birthdate
      location
      xUsername
      blockListAddress
      socialProofTokenAddress
      reservationPoolAddress
      socialProofToken {
        totalReserved
        requiredThreshold
        reservationPercentage
      }
    }
  }
`;

export type WalletProfile = {
  owner_address: string;
  username: string | null;
  display_name: string | null;
  profile_photo: string | null;
  reservation_pool_address: string | null;
  social_proof_token_address: string | null;
};

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Normalize GCS / CDN profile image URLs (same spirit as frontend). */
export function normalizeExternalImageUrl(raw: unknown): string | null {
  const s = asStr(raw);
  if (!s) return null;
  if (s.startsWith('//')) return `https:${s}`;
  return s;
}

export function mapGraphqlProfile(
  profile: Record<string, unknown> | null | undefined,
): WalletProfile | null {
  if (!profile) return null;
  const ownerAddr = asStr(profile.address);
  if (!ownerAddr) return null;
  const spt = asObj(profile.socialProofToken);
  return {
    owner_address: ownerAddr,
    username: asStr(profile.username),
    display_name: asStr(profile.displayName),
    profile_photo: normalizeExternalImageUrl(profile.profilePhoto),
    reservation_pool_address:
      asStr(profile.reservationPoolAddress) ??
      asStr(spt?.reservationPoolId),
    social_proof_token_address: asStr(profile.socialProofTokenAddress),
  };
}

export function reservationPoolFillPercentFromGraphqlProfile(
  profile: Record<string, unknown> | null | undefined,
): number | null {
  const p = asObj(profile);
  if (!p) return null;
  const spt = asObj(p.socialProofToken);
  if (!spt) return null;
  const reqThresh = asNum(spt.requiredThreshold);
  const totalRes = asNum(spt.totalReserved);
  if (reqThresh > 0) {
    return (totalRes / reqThresh) * 100;
  }
  const pct = asNum(spt.reservationPercentage);
  if (pct > 0 && Number.isFinite(pct)) {
    return pct;
  }
  return null;
}

/**
 * Public MySocial profile URL for a wallet.
 * Frontend owns profiles at `/wallet?address=…` (not a `/profile` app route).
 */
export function getMySocialProfileUrl(address: string): string {
  const origin = (
    import.meta.env.VITE_MYSOCIAL_WEB_ORIGIN ||
    'https://www.mysocial.network'
  ).replace(/\/+$/, '');
  return `${origin}/wallet?address=${encodeURIComponent(address)}`;
}

/** On-chain group metadata name limit (`messaging::metadata::MAX_NAME_LENGTH`). */
export const GROUP_NAME_MAX_LENGTH = 128;

export function truncateWalletAddress(address: string): string {
  if (!address) return 'unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Sidebar / inbox header: full name, else truncated wallet (never `@username`). */
export function profileHeaderTitle(
  address: string,
  profile: { display_name?: string | null } | null | undefined,
): string {
  const display = profile?.display_name?.trim();
  if (display) return display;
  return truncateWalletAddress(address);
}

/** `@username` when reserved; otherwise null. */
export function profileHandleLabel(
  profile: { username?: string | null } | null | undefined,
): string | null {
  const username = profile?.username?.trim();
  if (!username) return null;
  return `@${username.replace(/^@/, '')}`;
}

/** Create-group label: `@username` when reserved, else abbreviated wallet. */
export function groupNameLabelForRecipient(
  address: string,
  profile: WalletProfile | null,
): string {
  const username = profile?.username?.trim();
  if (username) return `@${username.replace(/^@/, '')}`;
  return truncateWalletAddress(address);
}

/**
 * Join member labels with ", " until {@link GROUP_NAME_MAX_LENGTH}.
 * Fits as many full labels as possible; never truncates mid-label except a
 * single oversized first label.
 */
export function buildAutoGroupName(
  labels: readonly string[],
  maxLen: number = GROUP_NAME_MAX_LENGTH,
): string {
  if (labels.length === 0) return 'New Group';
  let name = labels[0]!;
  if (name.length > maxLen) return name.slice(0, maxLen);

  for (let i = 1; i < labels.length; i++) {
    const next = `${name}, ${labels[i]}`;
    if (next.length > maxLen) break;
    name = next;
  }
  return name;
}

function normalizeGroupNameLabel(label: string): string {
  return label.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Labels that identify the signed-in user in an official group name
 * (`@username` and/or abbreviated wallet).
 */
export function selfGroupNameLabels(
  address: string | null | undefined,
  profile: WalletProfile | null | undefined,
): string[] {
  if (!address) return [];
  const labels: string[] = [];
  const username = profile?.username?.trim();
  if (username) {
    labels.push(`@${username.replace(/^@/, '')}`);
  }
  labels.push(truncateWalletAddress(address));
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = normalizeGroupNameLabel(label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * UI title from the official on-chain name with the current user's segment(s)
 * removed so DMs show the other person, not yourself.
 * Falls back to `officialName` when filtering would leave an empty string
 * (legacy names that were only the viewer's label).
 */
export function displayGroupTitle(
  officialName: string,
  selfLabels: readonly string[],
): string {
  const trimmed = officialName.trim();
  if (!trimmed) return 'New Group';
  if (selfLabels.length === 0) return trimmed;

  const selfKeys = new Set(
    selfLabels.map(normalizeGroupNameLabel).filter(Boolean),
  );
  const parts = trimmed
    .split(', ')
    .map((p) => p.trim())
    .filter(Boolean);
  const others = parts.filter(
    (part) => !selfKeys.has(normalizeGroupNameLabel(part)),
  );
  if (others.length === 0) return trimmed;
  return others.join(', ');
}

/**
 * The single peer wallet in a 1:1 chat, or `null` when membership is unknown
 * or this is a multi-member group.
 */
export function dmPeerAddress(
  memberAddresses: readonly string[],
  selfAddress: string | null | undefined,
): string | null {
  if (!selfAddress || memberAddresses.length === 0) return null;
  const selfKey = selfAddress.toLowerCase();
  const others = memberAddresses.filter(
    (addr) => addr.toLowerCase() !== selfKey,
  );
  return others.length === 1 ? others[0]! : null;
}

/**
 * Sidebar / chat-header title.
 * True 1:1 dialogues always show the other member's label (profile / wallet),
 * never the logged-in user — even when the on-chain name is only self.
 * Multi-member groups keep {@link displayGroupTitle}.
 */
export function conversationDisplayTitle(options: {
  officialName: string;
  selfLabels: readonly string[];
  memberAddresses: readonly string[];
  selfAddress: string | null | undefined;
  /** Preferred peer label (`@username` / display name / truncated wallet). */
  peerLabel?: string | null;
}): string {
  const peer = dmPeerAddress(options.memberAddresses, options.selfAddress);
  if (peer) {
    const label = options.peerLabel?.trim();
    return label || truncateWalletAddress(peer);
  }
  return displayGroupTitle(options.officialName, options.selfLabels);
}

/** Deduplicate MySo addresses (case-insensitive), preserving order. */
export function dedupeAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const addr = raw.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}
