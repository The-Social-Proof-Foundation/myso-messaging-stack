/**
 * Either-direction block checks via social-server (messaging DM-gate parity).
 * Fail-open on errors so search stays usable; submit-time checkDmGate is the hard gate.
 */

function socialServerBase(): string {
  return (import.meta.env.VITE_SOCIAL_SERVER_URL || '').replace(/\/+$/, '');
}

const eitherCache = new Map<string, boolean>();

function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** `GET /blocklist/check/either/{a}/{b}` — true if either direction is blocked. */
export async function checkEitherBlocked(
  selfWallet: string,
  peerWallet: string,
): Promise<boolean> {
  const self = selfWallet.trim().toLowerCase();
  const peer = peerWallet.trim().toLowerCase();
  if (!self || !peer || self === peer) return false;

  const base = socialServerBase();
  if (!base) return false;

  const key = pairKey(self, peer);
  const cached = eitherCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const url = `${base}/blocklist/check/either/${encodeURIComponent(self)}/${encodeURIComponent(peer)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.warn('[block-check] either failed:', res.status, self, peer);
      return false;
    }
    const body = (await res.json()) as { blocked?: boolean };
    const blocked = Boolean(body.blocked);
    eitherCache.set(key, blocked);
    return blocked;
  } catch (err) {
    console.warn('[block-check] either error:', err);
    return false;
  }
}

/** Annotate peers with `blocked` in parallel (session cache). */
export async function annotatePeersBlocked<T extends { wallet: string }>(
  selfWallet: string,
  peers: readonly T[],
): Promise<Array<T & { blocked: boolean }>> {
  const self = selfWallet.trim().toLowerCase();
  if (!self || peers.length === 0) {
    return peers.map((p) => ({ ...p, blocked: false }));
  }
  return Promise.all(
    peers.map(async (p) => {
      const blocked = await checkEitherBlocked(self, p.wallet);
      return { ...p, blocked };
    }),
  );
}

/** Clear in-memory cache (e.g. when closing New Message). */
export function clearEitherBlockCache(): void {
  eitherCache.clear();
}
