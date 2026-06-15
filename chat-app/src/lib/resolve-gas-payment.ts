import type { ClientWithCoreApi, MySoClientTypes } from '@socialproof/myso/client';

/** Known stale ghost coin from prior localnet regenesis (indexer/listCoins). */
export const STALE_GHOST_OBJECT_ID =
  '0xe807a2b5ffafeaa5db7916d0b81689e70bf3d588f7dde866c9b838d5fb63797e';

const MYSO_COIN_TYPE = '0x2::myso::MYSO';
const MYSO_COIN_STRUCT = `0x2::coin::Coin<${MYSO_COIN_TYPE}>`;

/** Minimum address balance (MIST) to attempt address-balance gas without coin objects. */
const MIN_ADDRESS_BALANCE_MIST = 1_000_000n;

export type GasCoinRef = {
  objectId: string;
  digest: string;
  version: string;
};

export type ResolvedGasPayment =
  | { kind: 'coins'; refs: GasCoinRef[]; ghostIds: string[] }
  | { kind: 'addressBalance'; ghostIds: string[] };

export type CoinRpcCheck = {
  objectId: string;
  digest: string;
  version: string;
  source: 'listCoins' | 'listOwnedObjects';
  existsOnRpc: boolean;
};

/**
 * Validate listCoins entries against live RPC. Returns refs for coins that exist.
 */
export async function validateListedCoinsOnRpc(
  client: ClientWithCoreApi,
  listed: Array<{ objectId: string; digest: string; version: string }>,
  source: 'listCoins' | 'listOwnedObjects',
): Promise<{ refs: GasCoinRef[]; checks: CoinRpcCheck[] }> {
  if (listed.length === 0) {
    return { refs: [], checks: [] };
  }

  const { objects } = await client.core.getObjects({
    objectIds: listed.map((c) => c.objectId),
  });

  const refs: GasCoinRef[] = [];
  const checks: CoinRpcCheck[] = [];

  for (let i = 0; i < listed.length; i++) {
    const coin = listed[i]!;
    const result = objects[i];
    const existsOnRpc = !(result instanceof Error);
    checks.push({
      objectId: coin.objectId,
      digest: coin.digest,
      version: coin.version,
      source,
      existsOnRpc,
    });
    if (existsOnRpc) {
      refs.push({
        objectId: coin.objectId,
        digest: coin.digest,
        version: coin.version,
      });
    }
  }

  return { refs, checks };
}

async function collectValidatedListCoins(
  client: ClientWithCoreApi,
  owner: string,
): Promise<{ refs: GasCoinRef[]; ghostIds: string[]; checks: CoinRpcCheck[] }> {
  const allListed: Array<{ objectId: string; digest: string; version: string }> =
    [];
  let cursor: string | null | undefined = undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const page = await client.core.listCoins({
      owner,
      coinType: MYSO_COIN_TYPE,
      ...(cursor ? { cursor } : {}),
    });
    for (const coin of page.objects) {
      allListed.push({
        objectId: coin.objectId,
        digest: coin.digest,
        version: coin.version,
      });
    }
    hasNextPage = page.hasNextPage;
    cursor = page.cursor ?? undefined;
    if (!hasNextPage) break;
  }

  const { refs, checks } = await validateListedCoinsOnRpc(
    client,
    allListed,
    'listCoins',
  );
  const ghostIds = checks.filter((c) => !c.existsOnRpc).map((c) => c.objectId);
  return { refs, ghostIds, checks };
}

export async function collectOwnedCoinRefs(
  client: ClientWithCoreApi,
  owner: string,
): Promise<{ refs: GasCoinRef[]; checks: CoinRpcCheck[] }> {
  const listed: Array<{ objectId: string; digest: string; version: string }> =
    [];
  let cursor: string | null | undefined = undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const request: MySoClientTypes.ListOwnedObjectsOptions = cursor
      ? { owner, type: MYSO_COIN_STRUCT, limit: 50, cursor }
      : { owner, type: MYSO_COIN_STRUCT, limit: 50 };
    const page: MySoClientTypes.ListOwnedObjectsResponse =
      await client.core.listOwnedObjects(request);
    for (const obj of page.objects) {
      listed.push({
        objectId: obj.objectId,
        digest: obj.digest,
        version: obj.version,
      });
    }
    hasNextPage = page.hasNextPage;
    cursor = page.cursor ?? undefined;
    if (!hasNextPage) break;
  }

  return validateListedCoinsOnRpc(client, listed, 'listOwnedObjects');
}

function formatGhostGasError(
  owner: string,
  ghostIds: string[],
  totalBalance: string,
): string {
  const ghostList = ghostIds.length > 0 ? ghostIds.join(', ') : '(none listed)';
  return (
    `No RPC-verified gas coins for ${owner}. ` +
    `listCoins returned stale object(s): ${ghostList}. ` +
    `Balance on RPC: ${totalBalance} MIST. ` +
    'Compare with `myso client gas ' +
    owner +
    '` — if CLI shows a real coin, the browser indexer listing is stale. ' +
    'Fund via `myso client faucet ' +
    owner +
    '` or restart localnet with a clean indexer.'
  );
}

/**
 * Resolve gas payment before transaction build so the SDK does not trust stale
 * listCoins entries (e.g. ghost 0xe807 after regenesis).
 */
export async function resolveGasPaymentForSigner(
  client: ClientWithCoreApi,
  owner: string,
): Promise<ResolvedGasPayment> {
  const { refs: listCoinRefs, ghostIds } =
    await collectValidatedListCoins(client, owner);

  if (listCoinRefs.length > 0) {
    return { kind: 'coins', refs: listCoinRefs, ghostIds };
  }

  const { refs: ownedRefs, checks: ownedChecks } =
    await collectOwnedCoinRefs(client, owner);

  if (ownedRefs.length > 0) {
    const allGhostIds = [
      ...ghostIds,
      ...ownedChecks.filter((c) => !c.existsOnRpc).map((c) => c.objectId),
    ];
    return {
      kind: 'coins',
      refs: ownedRefs,
      ghostIds: [...new Set(allGhostIds)],
    };
  }

  const { balance } = await client.core.getBalance({
    owner,
    coinType: MYSO_COIN_TYPE,
  });
  const addressBalance = BigInt(balance.addressBalance ?? '0');
  const totalBalance = balance.balance ?? '0';

  if (addressBalance >= MIN_ADDRESS_BALANCE_MIST) {
    return { kind: 'addressBalance', ghostIds };
  }

  throw new Error(formatGhostGasError(owner, ghostIds, totalBalance));
}
