/**
 * Gas pool client (mysocial-frontend parity).
 * Dev: Vite proxies /api/gas-pool/* → VITE_MYSO_GAS_POOL_URL /v1/*
 * Prod: absolute VITE_MYSO_GAS_POOL_URL + /v1/*
 */

import type { ClientWithCoreApi } from '@socialproof/myso/client';

const MYSO_COIN_TYPE = '0x2::myso::MYSO';

/** Default affordability threshold — 0.001 MYSO (9 decimals). */
export const GAS_AFFORDABILITY_MIST = 1_000_000;

export interface GasReservationResponse {
  result: {
    sponsor_address: string;
    reservation_id: number;
    gas_coins: Array<{
      objectId: string;
      version: number | string;
      digest: string;
    }>;
  };
  error: null | string;
}

export interface ExecuteTransactionResponse {
  result?: {
    digest?: string;
    effects?: {
      status?: { status?: string; error?: string };
      transactionDigest?: string;
    };
    events?: unknown[];
  };
  effects?: {
    status?: { status?: string; error?: string };
    transactionDigest?: string;
  };
  digest?: string;
  error?: null | string;
}

function normalizeGasPoolBase(url: string): string {
  let base = url.trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    base = `https://${base}`;
  }
  return base.replace(/\/$/, '');
}

function gasPoolEndpoints(): { reserve: string; execute: string } {
  if (import.meta.env.DEV) {
    return {
      reserve: '/api/gas-pool/reserve',
      execute: '/api/gas-pool/execute',
    };
  }

  const raw = import.meta.env.VITE_MYSO_GAS_POOL_URL as string | undefined;
  if (!raw?.trim()) {
    throw new Error(
      'VITE_MYSO_GAS_POOL_URL is not configured. Sponsored gas requires a gas pool URL on testnet/mainnet.',
    );
  }
  const base = normalizeGasPoolBase(raw);
  const hasV1 = base.includes('/v1/') || base.endsWith('/v1');
  return {
    reserve: hasV1 ? `${base}/reserve_gas` : `${base}/v1/reserve_gas`,
    execute: hasV1 ? `${base}/execute_tx` : `${base}/v1/execute_tx`,
  };
}

/**
 * Sum MYSO coin balances. On RPC failure returns false (prefer sponsored on public nets).
 */
export async function canAffordGas(
  client: ClientWithCoreApi,
  address: string,
  budget: number = GAS_AFFORDABILITY_MIST,
): Promise<boolean> {
  try {
    let total = 0n;
    let cursor: string | null | undefined = undefined;
    let hasNextPage = true;

    while (hasNextPage) {
      const page = await client.core.listCoins({
        owner: address,
        coinType: MYSO_COIN_TYPE,
        ...(cursor ? { cursor } : {}),
      });
      for (const coin of page.objects) {
        total += BigInt(coin.balance);
      }
      hasNextPage = page.hasNextPage;
      cursor = page.cursor ?? undefined;
      if (!hasNextPage) break;
    }

    return total >= BigInt(budget);
  } catch (error) {
    console.warn('[SmartGas] balance check failed — treating as cannot afford:', error);
    return false;
  }
}

/**
 * Reserve gas coins from the pool.
 * Budget is only for reservation size — do not setGasBudget on the tx.
 */
export async function reserveGas(
  gasBudget: number = 10_000_000,
  reserveDurationSecs: number = 420,
): Promise<GasReservationResponse> {
  const { reserve } = gasPoolEndpoints();
  const response = await fetch(reserve, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gas_budget: gasBudget,
      reserve_duration_secs: reserveDurationSecs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gas reservation failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as GasReservationResponse;
  if (data.error) {
    throw new Error(`Gas reservation API error: ${data.error}`);
  }
  if (!data.result?.sponsor_address || !data.result.gas_coins?.length) {
    throw new Error('Invalid gas pool reserve response');
  }

  return data;
}

export async function executeSponsoredTransaction(
  reservationId: number,
  txBytes: string,
  userSig: string,
): Promise<ExecuteTransactionResponse> {
  const { execute } = gasPoolEndpoints();
  const response = await fetch(execute, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reservation_id: reservationId,
      tx_bytes: txBytes,
      user_sig: userSig,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Sponsored transaction execution failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as ExecuteTransactionResponse;
  if (data.error) {
    throw new Error(`Sponsored transaction API error: ${data.error}`);
  }

  const effects = data.result?.effects || data.effects;
  const status = effects?.status?.status;
  if (status === 'failure') {
    const errorInfo = effects?.status?.error;
    throw new Error(
      errorInfo ? `Transaction failed: ${errorInfo}` : 'Sponsored transaction failed',
    );
  }

  return data;
}

export function extractSponsoredDigest(result: ExecuteTransactionResponse): string {
  return (
    result.result?.digest ||
    result.digest ||
    result.result?.effects?.transactionDigest ||
    result.effects?.transactionDigest ||
    ''
  );
}
