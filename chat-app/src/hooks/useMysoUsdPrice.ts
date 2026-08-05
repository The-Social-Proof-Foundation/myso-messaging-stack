import { useQuery } from '@tanstack/react-query';

/** Same feed mysocial-frontend proxies via `/api/token-price/mysocial`. */
const DEFAULT_PRICE_URL = 'https://api.testnet.dripdrop.social/price/mysocial';
const REFRESH_MS = 60_000;

type TokenPriceResponse = {
  token: string;
  priceUsd: number;
  percentChange24h: number | null;
  updatedAt: string;
};

function priceEndpoint(): string {
  const fromEnv = import.meta.env.VITE_MYSO_USD_PRICE_URL?.trim();
  return fromEnv || DEFAULT_PRICE_URL;
}

async function fetchMysoUsdPrice(): Promise<number> {
  const response = await fetch(priceEndpoint(), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`MySo price fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as TokenPriceResponse;
  if (!Number.isFinite(data.priceUsd) || data.priceUsd <= 0) {
    throw new Error('MySo price response missing priceUsd');
  }
  return data.priceUsd;
}

/**
 * Live MySo → USD spot price (shared cache, 60s refresh).
 */
export function useMysoUsdPrice(): {
  priceUsd: number | null;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ['myso-usd-price', priceEndpoint()],
    queryFn: fetchMysoUsdPrice,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    retry: 2,
  });

  return {
    priceUsd: query.data ?? null,
    isLoading: query.isLoading,
  };
}

/** Approximate USD for a MySo amount; `~$0.00` when price/amount unknown. */
export function formatApproxMysoUsd(
  mysoAmount: number | null,
  priceUsd: number | null,
): string {
  if (
    mysoAmount == null ||
    priceUsd == null ||
    !Number.isFinite(mysoAmount) ||
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0
  ) {
    return '~$0.00';
  }
  const usd = mysoAmount * priceUsd;
  if (!Number.isFinite(usd) || usd <= 0) return '~$0.00';
  if (usd < 0.01) return '~<$0.01';
  return `~$${usd.toFixed(2)}`;
}
