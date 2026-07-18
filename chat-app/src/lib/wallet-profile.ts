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
