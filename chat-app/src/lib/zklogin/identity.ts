/**
 * Which messaging key a finished OAuth login should keep.
 * The zkLogin proof expires. The Ed25519 chat key must not.
 */

export type StoredMessagingIdentity = {
  secret: string;
  /** OAuth subject bound to this key, when the device has seen one. */
  sub?: string;
  /** zkLogin chain address bound to the stored proof, when there is one. */
  zkAddress?: string;
  /** Stored proof is still inside its epoch window and passes local checks. */
  proofUsable: boolean;
};

export type LoginIdentityAction = 'reuse-proof' | 'renew-proof' | 'adopt' | 'account-switch';

/**
 * `adopt` is a key this sign-in just created (no subject and no chain address yet).
 * `renew-proof` keeps that key and replaces the expired proof.
 * `account-switch` is a different person and must not inherit the key.
 */
export function loginIdentityAction(
  stored: StoredMessagingIdentity | null,
  oauthSub: string,
  zkAddress: string,
): LoginIdentityAction {
  if (!stored?.secret) return 'adopt';
  if (stored.sub) {
    if (stored.sub !== oauthSub) return 'account-switch';
    return stored.proofUsable ? 'reuse-proof' : 'renew-proof';
  }
  if (stored.zkAddress) {
    if (stored.zkAddress.toLowerCase() !== zkAddress.toLowerCase()) return 'account-switch';
    return stored.proofUsable ? 'reuse-proof' : 'renew-proof';
  }
  return 'adopt';
}

/** True when this sign-in has to generate a chat key. An existing secret is reused. */
export function shouldMintMessagingKey(hasStoredSecret: boolean): boolean {
  return !hasStoredSecret;
}

export type PendingLoginFields = {
  randomness: string;
  maxEpoch: number;
  nonce: string;
  state: string;
  clock?: { epoch: number; epochDurationMs: number; maxEpochDelta: number | null };
};

/** OAuth handoff. The chat key stays in IndexedDB; this payload has no secret. */
export function serializePendingLogin(fields: PendingLoginFields): string {
  return JSON.stringify({
    randomness: fields.randomness,
    maxEpoch: fields.maxEpoch,
    nonce: fields.nonce,
    state: fields.state,
    ...(fields.clock ? { clock: fields.clock } : {}),
  });
}

/**
 * Older tabs wrote `secretKey` into the pending handoff.
 * Returns the secret so the caller can encrypt it, and a payload with the field removed.
 */
export function stripLegacyPendingSecret(raw: string): { pending: string; secret: string | null } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const secret = typeof parsed.secretKey === 'string' && parsed.secretKey.length > 0 ? parsed.secretKey : null;
  delete parsed.secretKey;
  return { pending: JSON.stringify(parsed), secret };
}

export type LegacySessionCopy = {
  secret: string;
  address?: string;
  addressSeed?: string;
  maxEpoch?: number;
  proofPoints?: { a: string[]; b: string[][]; c: string[] };
  issBase64Details?: { value: string; indexMod4: number };
  headerBase64?: string;
  proofVersion?: number;
  sub?: string;
};

/** Reads a legacy `mysocial_zklogin_current` blob. Returns null when it holds no secret. */
export function readLegacySessionCopy(raw: string): LegacySessionCopy | null {
  try {
    const saved = JSON.parse(raw) as Partial<LegacySessionCopy> & { secretKey?: string };
    if (typeof saved.secretKey !== 'string' || saved.secretKey.length === 0) return null;
    return {
      secret: saved.secretKey,
      address: saved.address,
      addressSeed: saved.addressSeed,
      maxEpoch: saved.maxEpoch,
      proofPoints: saved.proofPoints,
      issBase64Details: saved.issBase64Details,
      headerBase64: saved.headerBase64,
      proofVersion: saved.proofVersion,
      sub: saved.sub,
    };
  } catch {
    return null;
  }
}

/**
 * Popup result used for zkLogin. A `signingKey` from the auth host is ignored:
 * chat identity is the key this browser already stored.
 */
export function oauthTokenFromAuthResult(message: {
  id_token?: string;
  access_token?: string;
  session_access_token?: string;
  signingKey?: string;
}): { idToken: string; accessToken: string } | null {
  const accessToken = message.session_access_token || message.access_token;
  if (!message.id_token || !accessToken) return null;
  return { idToken: message.id_token, accessToken };
}
