/**
 * Passkey PRF for the message backup (E2EE M8). Same `mysocial.network` passkey as the rest of the
 * app (iOS `ContraPasskey` uses the same relying party and per-wallet user id), evaluated with the
 * backup salt `SHA-256("mysocial/messaging-backup-prf/v1")`, independent of the wallet-vault PRF.
 * Only the PRF output is used (no server verifies this assertion), so no ceremony is needed.
 */

import { backupPrfSalt } from '@socialproof/myso-messaging-stack';

/** Relying party of the shared passkey. The page must be on it or a subdomain. */
export const BACKUP_PASSKEY_RP_ID = import.meta.env.VITE_PASSKEY_RP_ID || 'mysocial.network';

export function backupPasskeyAvailable(): boolean {
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials) return false;
  const host = location.hostname;
  return host === BACKUP_PASSKEY_RP_ID || host.endsWith(`.${BACKUP_PASSKEY_RP_ID}`);
}

type PrfResults = { prf?: { results?: { first?: ArrayBuffer }; enabled?: boolean } };

function prfOutput(credential: PublicKeyCredential | null): Uint8Array | null {
  const first = (credential?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  return first && first.byteLength === 32 ? new Uint8Array(first) : null;
}

/** Same user id iOS uses (`SHA-256(wallet)`): one passkey per wallet across devices. */
async function userIdFor(wallet: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wallet.trim().toLowerCase())));
}

const challenge = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * The backup PRF from an existing passkey, or (with `allowCreate`) from a new one created for this
 * wallet if none exists. Throws a user-facing error when the passkey can't do PRF.
 */
export async function getBackupPrf(wallet: string, options: { allowCreate?: boolean } = {}): Promise<Uint8Array> {
  if (!backupPasskeyAvailable()) {
    throw new Error(`Message backup uses your MySocial passkey, which works on ${BACKUP_PASSKEY_RP_ID}.`);
  }
  const salt = (await backupPrfSalt()) as Uint8Array<ArrayBuffer>;
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        rpId: BACKUP_PASSKEY_RP_ID,
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const prf = prfOutput(credential);
    if (prf) return prf;
    if (credential) throw new Error('This passkey can’t protect a backup (no PRF support). Try another passkey or device.');
  } catch (err) {
    if (!options.allowCreate || !(err instanceof DOMException) || err.name !== 'NotAllowedError') throw err;
  }
  if (!options.allowCreate) throw new Error('No passkey selected.');
  // No passkey yet (or none picked): create the account's passkey, then evaluate it.
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: challenge(),
      rp: { id: BACKUP_PASSKEY_RP_ID, name: 'MySocial' },
      user: { id: await userIdFor(wallet), name: wallet.toLowerCase(), displayName: 'MySocial' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const fromCreate = prfOutput(created);
  if (fromCreate) return fromCreate;
  // Some authenticators only return PRF on assertion.
  const asserted = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge(),
      rpId: BACKUP_PASSKEY_RP_ID,
      userVerification: 'required',
      allowCredentials: created ? [{ type: 'public-key', id: created.rawId }] : [],
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const prf = prfOutput(asserted);
  if (!prf) throw new Error('This passkey can’t protect a backup (no PRF support). Try another passkey or device.');
  return prf;
}
