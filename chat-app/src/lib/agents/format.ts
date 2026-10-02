import {mistToMyso, mysoToMist} from '../mys-coin';

/** Numeric MySo amount, without the unit. `—` when the mist value is missing. */
export function formatMistAmount(mist: number | bigint | null | undefined): string {
  if (mist == null) return '—';
  try {
    const value = typeof mist === 'bigint' ? mist : BigInt(Math.trunc(mist));
    if (value < 0n) return '—';
    return mistToMyso(value);
  } catch {
    return '—';
  }
}

export function formatMistAsMyso(mist: number | bigint | null | undefined): string {
  const amount = formatMistAmount(mist);
  return amount === '—' ? amount : `${amount} MySo`;
}

export function parseMysoToMist(raw: string): bigint | null {
  try {
    return mysoToMist(raw);
  } catch {
    return null;
  }
}

export function truncateAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function formatRelativeMs(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
