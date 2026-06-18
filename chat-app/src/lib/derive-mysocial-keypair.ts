import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

async function sha256Utf8(message: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(message);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

export interface DeriveMySocialKeypairParams {
  saltUrl: string;
  accessToken: string;
  /** Stable derivation id from session (typically OAuth provider sub). */
  sub: string;
  expectedAddress: string;
}

export interface DeriveFromSaltParams {
  sub: string;
  salt: string;
  expectedAddress: string;
}

/** Derives Ed25519 signing keypair: SHA256(sub + '_' + salt), first 32 bytes as seed. */
export async function deriveKeypairFromSubAndSalt({
  sub,
  salt,
  expectedAddress,
}: DeriveFromSaltParams): Promise<Ed25519Keypair> {
  const hash = await sha256Utf8(`${sub}_${salt}`);
  const seed = hash.slice(0, 32);
  const keypair = Ed25519Keypair.fromSecretKey(seed);

  const derived = keypair.toMySoAddress();
  const want = expectedAddress.trim();
  if (derived.toLowerCase() !== want.toLowerCase()) {
    throw new Error(
      'Derived keypair address does not match the session wallet address.',
    );
  }

  return keypair;
}

/** @deprecated Prefer getSaltFromSession + deriveKeypairFromSubAndSalt */
export async function deriveKeypairFromSaltService({
  saltUrl,
  accessToken,
  sub,
  expectedAddress,
}: DeriveMySocialKeypairParams): Promise<Ed25519Keypair> {
  const saltRes = await fetch(saltUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!saltRes.ok) {
    const text = await saltRes.text().catch(() => '');
    throw new Error(
      `Salt service returned ${saltRes.status}: ${text.slice(0, 240)}`,
    );
  }

  const body = (await saltRes.json()) as { salt?: unknown };
  const salt =
    typeof body.salt === 'string' ? body.salt : String(body.salt ?? '');
  if (!salt) {
    throw new Error('Salt service returned an empty salt.');
  }

  return deriveKeypairFromSubAndSalt({ sub, salt, expectedAddress });
}
