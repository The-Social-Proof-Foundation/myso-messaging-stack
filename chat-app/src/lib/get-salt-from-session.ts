import type { MySocialAuth, Session } from '@socialproof/mysocial-auth';

const KEYPAIR_RETRY_DELAYS_MS = [1000, 2000];

function isJwtShape(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parts = value.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

async function fetchSaltWithJwtBody(saltUrl: string, jwt: string): Promise<string> {
  const res = await fetch(saltUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jwt: jwt.trim() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Salt service returned ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = (await res.json()) as { salt?: unknown };
  const salt = typeof body.salt === 'string' ? body.salt : String(body.salt ?? '');
  if (!salt) {
    throw new Error('Salt service returned an empty salt.');
  }
  return salt;
}

async function fetchSaltWithBearer(saltUrl: string, bearerToken: string): Promise<string> {
  const res = await fetch(saltUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Salt service returned ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = (await res.json()) as { salt?: unknown };
  const salt = typeof body.salt === 'string' ? body.salt : String(body.salt ?? '');
  if (!salt) {
    throw new Error('Salt service returned an empty salt.');
  }
  return salt;
}

export async function getSaltFromSession(
  auth: MySocialAuth,
  session: Session,
  saltUrl: string,
  attempt = 0,
): Promise<string> {
  if (session.salt) {
    return session.salt;
  }

  const idToken = session.id_token?.trim();
  if (idToken && isJwtShape(idToken)) {
    try {
      return await fetchSaltWithJwtBody(saltUrl, idToken);
    } catch (jwtError) {
      console.warn('[getSaltFromSession] id_token body salt fetch failed:', jwtError);
    }
  }

  let bearerToken: string | undefined;
  if (typeof auth.getAccessTokenForApi === 'function') {
    bearerToken = await auth.getAccessTokenForApi();
  }
  bearerToken ??= session.session_access_token ?? session.access_token;

  if (bearerToken && bearerToken !== 'wallet-only' && isJwtShape(bearerToken)) {
    try {
      return await fetchSaltWithJwtBody(saltUrl, bearerToken);
    } catch (bearerJwtError) {
      console.warn('[getSaltFromSession] bearer JWT body salt fetch failed:', bearerJwtError);
    }
  }

  if (bearerToken && bearerToken !== 'wallet-only') {
    try {
      return await fetchSaltWithBearer(saltUrl, bearerToken);
    } catch (bearerError) {
      console.warn('[getSaltFromSession] Bearer salt fetch failed:', bearerError);
    }
  }

  if (attempt < KEYPAIR_RETRY_DELAYS_MS.length) {
    await new Promise((resolve) =>
      setTimeout(resolve, KEYPAIR_RETRY_DELAYS_MS[attempt] ?? 2000),
    );
    return getSaltFromSession(auth, session, saltUrl, attempt + 1);
  }

  throw new Error('Unable to retrieve salt for this session.');
}
