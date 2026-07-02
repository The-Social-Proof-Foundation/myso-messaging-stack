import { bcs } from '@socialproof/bcs';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';
import { deriveObjectID } from '@socialproof/myso/utils';
import {
  clearGenesisMessagingConfigCache,
  resolveGenesisMessagingConfig,
  type ResolvedGenesisMessagingConfig,
} from '@socialproof/myso-messaging-stack';

import {
  createBaseMySoRpcClient,
  getGenesisGraphqlUrl,
  type MessagingClient,
} from './messaging-client-factory';
import {
  collectOwnedCoinRefs,
  STALE_GHOST_OBJECT_ID,
  validateListedCoinsOnRpc,
} from './resolve-gas-payment';

export { getGenesisGraphqlUrl, STALE_GHOST_OBJECT_ID };

/**
 * Type alias (not interface) so these stay assignable to the widened
 * `Record<string, string>` params of the tx-input/RPC diagnostics.
 */
export type CreateGroupObjectIds = {
  versionId: string;
  namespaceId: string;
  groupManagerId: string;
  blockListRegistryId: string;
};

/** Shared-object inputs of the paid-DM PTB (create group + `send_paid_message_digest`). */
export type PaidDmObjectIds = CreateGroupObjectIds & {
  socialGraphId: string;
  paidMessagingRegistryId: string;
};

type TransactionWithPrepare = Transaction & {
  prepareForSerialization(options: {
    client: ClientWithCoreApi;
  }): Promise<void>;
};

export function logMessagingEnv(label: string): void {
  if (!import.meta.env.DEV) return;

  console.group(`[chat-app] messaging env — ${label}`);
  console.log({
    VITE_MYSO_NETWORK: import.meta.env.VITE_MYSO_NETWORK,
    VITE_MYSO_GRAPHQL_URL: import.meta.env.VITE_MYSO_GRAPHQL_URL,
    VITE_MYSO_RPC_URL: import.meta.env.VITE_MYSO_RPC_URL,
    VITE_MYDATA_KEY_SERVER_OBJECT_IDS:
      import.meta.env.VITE_MYDATA_KEY_SERVER_OBJECT_IDS ?? '(unset)',
    VITE_MYDATA_THRESHOLD: import.meta.env.VITE_MYDATA_THRESHOLD ?? '(sdk default 2)',
    genesisGraphqlUrlPassed: getGenesisGraphqlUrl() ?? '(sdk localnet default)',
  });
  console.groupEnd();
}

const KEY_SERVER_PARENT_TYPE_SUFFIX = '::key_server::KeyServer';

function isKeyServerParentType(type: string): boolean {
  return (
    !type.includes('dynamic_field::Field') &&
    type.endsWith(KEY_SERVER_PARENT_TYPE_SUFFIX)
  );
}

/** Dev helper: validate configured MyData key server object IDs on RPC. */
export async function logMyDataKeyServers(
  label: string,
  client: ClientWithCoreApi,
): Promise<void> {
  if (!import.meta.env.DEV) return;

  const raw = import.meta.env.VITE_MYDATA_KEY_SERVER_OBJECT_IDS ?? '';
  const objectIds = raw
    .split(',')
    .map((id: string) => id.trim())
    .filter(Boolean);

  console.group(`[chat-app] mydata key servers — ${label}`);
  try {
    console.log({
      VITE_MYDATA_KEY_SERVER_OBJECT_IDS: raw || '(unset)',
      configuredCount: objectIds.length,
    });

    if (objectIds.length === 0) {
      console.warn(
        '[chat-app] no MyData key servers configured — set VITE_MYDATA_KEY_SERVER_OBJECT_IDS ' +
          'to KEY_SERVER_OBJECT_ID from `myso start --with-mydata` (parent key_server::KeyServer).',
      );
      return;
    }

    for (const objectId of objectIds) {
      try {
        const { object } = await client.core.getObject({ objectId });
        const parentOk = isKeyServerParentType(object.type);
        const status = parentOk ? 'rpc ok (parent KeyServer)' : 'rpc ok (WRONG type)';
        console.log(`[mydata] ${status}`, {
          objectId,
          type: object.type,
        });
        if (!parentOk) {
          console.warn(
            `[chat-app] ${objectId} is not a parent key_server::KeyServer object. ` +
              'Use KEY_SERVER_OBJECT_ID from `myso start` (verify: `myso client object <id>` ' +
              'shows key_server::KeyServer, not dynamic_field::Field<…KeyServerV1>).',
          );
        }
      } catch (error) {
        console.error(
          `[rpc FAIL] mydata key server`,
          objectId,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    console.groupEnd();
  }
}

export function deriveGroupManagerId(namespaceId: string): string {
  const key = bcs.string().serialize('group_manager').toBytes();
  return deriveObjectID(namespaceId, '0x1::string::String', key);
}

/** Matches Move `PAID_MESSAGING_REGISTRY_DERIVATION_KEY` (`b"paid_messaging_registry"`). */
export function derivePaidMessagingRegistryId(namespaceId: string): string {
  const key = bcs.string().serialize('paid_messaging_registry').toBytes();
  return deriveObjectID(namespaceId, '0x1::string::String', key);
}

function warnIfStale(label: string, objectId: string): void {
  if (objectId === STALE_GHOST_OBJECT_ID) {
    console.warn(
      `[chat-app] ${label} matches stale ghost object ${STALE_GHOST_OBJECT_ID}`,
    );
  }
}

export function expectedCreateGroupObjectIds(
  resolved: ResolvedGenesisMessagingConfig,
): CreateGroupObjectIds {
  const { namespaceId, versionId, blockListRegistryId } = resolved.messaging;
  return {
    versionId,
    namespaceId,
    groupManagerId: deriveGroupManagerId(namespaceId),
    blockListRegistryId,
  };
}

/**
 * The paid-DM PTB references the create-group singletons plus `SocialGraph`
 * and the derived `PaidMessagingRegistry` (see `send_paid_message_digest`).
 */
export function expectedPaidDmObjectIds(
  resolved: ResolvedGenesisMessagingConfig,
): PaidDmObjectIds {
  const { namespaceId, socialGraphId } = resolved.messaging;
  return {
    ...expectedCreateGroupObjectIds(resolved),
    socialGraphId,
    paidMessagingRegistryId: derivePaidMessagingRegistryId(namespaceId),
  };
}

export function logResolvedGenesisConfig(
  label: string,
  resolved: ResolvedGenesisMessagingConfig,
): void {
  if (!import.meta.env.DEV) return;

  const expected = expectedCreateGroupObjectIds(resolved);
  const { memoryRegistryId } = resolved.messaging;

  console.group(`[chat-app] messaging genesis — ${label}`);
  console.table({
    ...expected,
    memoryRegistryId: memoryRegistryId || '(missing)',
  });

  if (!memoryRegistryId) {
    console.error(
      '[chat-app] memoryRegistryId is missing from resolved genesis config. ' +
        'memoryAccountIdForOwner cannot route wallet vs profile group creation until genesis ' +
        'includes MemoryRegistry (resolve genesis config / regenesis).',
    );
  }

  for (const [name, id] of Object.entries(expected)) {
    warnIfStale(name, id);
  }

  console.groupEnd();
}

/** Dev-only: warn when MemoryRegistry id is absent (blocks wallet/profile routing). */
export function assertMemoryRegistryConfigured(
  label: string,
  resolved: ResolvedGenesisMessagingConfig,
): void {
  if (!import.meta.env.DEV) return;

  const { memoryRegistryId } = resolved.messaging;
  if (memoryRegistryId) return;

  console.warn(
    `[chat-app] ${label}: memoryRegistryId is empty — Create Group may fail before ` +
      'wallet routing (memoryAccountIdForOwner requires MemoryRegistry in packageConfig).',
  );
}

function extractMoveCallFunction(tx: Transaction): string | undefined {
  const json = tx.getData() as {
    commands: Array<{ MoveCall?: { function?: string; module?: string } }>;
  };
  const moveCall = json.commands.find((cmd) => cmd.MoveCall)?.MoveCall;
  if (!moveCall?.function) return undefined;
  return moveCall.module ? `${moveCall.module}::${moveCall.function}` : moveCall.function;
}

export async function fetchAndLogGenesisConfig(
  client: ClientWithCoreApi,
  label: string,
  options?: { bypassCache?: boolean },
): Promise<ResolvedGenesisMessagingConfig> {
  const graphqlUrl = getGenesisGraphqlUrl();
  logMessagingEnv(label);

  if (options?.bypassCache) {
    clearGenesisMessagingConfigCache();
    console.log(`[chat-app] cleared genesis cache before ${label}`);
  }

  const resolved = await resolveGenesisMessagingConfig(client, {
    graphqlUrl,
  });
  logResolvedGenesisConfig(label, resolved);
  return resolved;
}

export function logClientDeriveIds(
  label: string,
  derive: {
    groupManagerId: () => string;
    groupId: (options: { uuid: string }) => string;
    encryptionHistoryId: (options: { uuid: string }) => string;
  },
  uuid?: string,
): void {
  if (!import.meta.env.DEV) return;

  console.group(`[chat-app] messaging derive — ${label}`);
  const groupManagerId = derive.groupManagerId();
  console.log({ groupManagerId });
  warnIfStale('client.derive.groupManagerId', groupManagerId);

  if (uuid) {
    const groupId = derive.groupId({ uuid });
    const encryptionHistoryId = derive.encryptionHistoryId({ uuid });
    console.log({ uuid, groupId, encryptionHistoryId });
    warnIfStale('client.derive.groupId', groupId);
    warnIfStale('client.derive.encryptionHistoryId', encryptionHistoryId);
  }

  console.groupEnd();
}

/** Compare fresh GraphQL singletons to what the client's derive layer implies. */
export function logFullGenesisClientMismatch(
  label: string,
  resolved: ResolvedGenesisMessagingConfig,
  client: MessagingClient,
): void {
  if (!import.meta.env.DEV) return;

  const fresh = expectedCreateGroupObjectIds(resolved);
  const clientGroupManagerId = client.messaging.derive.groupManagerId();

  const mismatches: Record<string, { fresh: string; client: string }> = {};

  if (clientGroupManagerId !== fresh.groupManagerId) {
    mismatches.groupManagerId = {
      fresh: fresh.groupManagerId,
      client: clientGroupManagerId,
    };
  }

  if (Object.keys(mismatches).length > 0) {
    console.error(
      `[chat-app] genesis mismatch — ${label}: client derive differs from fresh GraphQL`,
      {
        mismatches,
        freshNamespaceId: fresh.namespaceId,
        freshVersionId: fresh.versionId,
        freshBlockListRegistryId: fresh.blockListRegistryId,
        genesisGraphqlUrl: getGenesisGraphqlUrl() ?? '(sdk localnet default)',
      },
    );
    return;
  }

  console.log(
    `[chat-app] genesis ok — ${label}: client derive.groupManager matches fresh GraphQL`,
    {
      versionId: fresh.versionId,
      namespaceId: fresh.namespaceId,
      groupManagerId: fresh.groupManagerId,
      blockListRegistryId: fresh.blockListRegistryId,
    },
  );
}

function extractInputObjectId(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;

  if (record.$kind === 'UnresolvedObject') {
    const unresolved = record.UnresolvedObject as { objectId?: string } | undefined;
    return unresolved?.objectId ?? null;
  }

  if (record.$kind === 'Object') {
    const object = record.Object as Record<string, unknown> | undefined;
    const imm = object?.ImmOrOwnedObject as { objectId?: string } | undefined;
    const shared = object?.SharedObject as { objectId?: string } | undefined;
    return imm?.objectId ?? shared?.objectId ?? null;
  }

  return null;
}

/**
 * Resolve async thunks (DEK generation) and log PTB object inputs before full build/sign.
 */
export async function logCreateGroupTxInputs(
  label: string,
  tx: Transaction,
  client: ClientWithCoreApi,
  expected?: Record<string, string>,
  options?: {
    resolvedMemoryAccountId?: string | null;
  },
): Promise<void> {
  if (!import.meta.env.DEV) return;

  console.group(`[chat-app] create-group tx inputs — ${label}`);
  try {
    await (tx as TransactionWithPrepare).prepareForSerialization({ client });

    const moveFunction = extractMoveCallFunction(tx);
    if (moveFunction) {
      console.log('[chat-app] create-group Move entry point:', moveFunction);
    }

    if (options && 'resolvedMemoryAccountId' in options) {
      const id = options.resolvedMemoryAccountId;
      console.log(
        '[chat-app] create-group resolved MemoryAccount:',
        id ?? '(none — wallet path)',
      );
    }

    const inputs = tx.getData().inputs;
    const objectIds = inputs
      .map((input, idx) => ({
        idx,
        kind: (input as { $kind?: string }).$kind ?? 'unknown',
        objectId: extractInputObjectId(input),
      }))
      .filter((row) => row.objectId != null);

    console.table(objectIds);

    if (expected) {
      const ptbIds = new Set(objectIds.map((row) => row.objectId));
      for (const [name, id] of Object.entries(expected)) {
        if (!ptbIds.has(id)) {
          console.warn(
            `[chat-app] expected ${name} ${id} not found in PTB unresolved inputs`,
          );
        }
        warnIfStale(`tx.${name}`, id);
      }
      for (const row of objectIds) {
        if (row.objectId && !Object.values(expected).includes(row.objectId)) {
          console.warn(
            `[chat-app] unexpected PTB object input at idx ${row.idx}: ${row.objectId}`,
          );
          warnIfStale(`tx.unexpected[${row.idx}]`, row.objectId);
        }
      }
    }

    for (const row of objectIds) {
      if (row.objectId) warnIfStale(`tx.input[${row.idx}]`, row.objectId);
    }
  } finally {
    console.groupEnd();
  }
}

export async function logSignerGasCoins(
  label: string,
  client: ClientWithCoreApi,
  signer: Signer,
): Promise<void> {
  if (!import.meta.env.DEV) return;

  const owner = signer.toMySoAddress();

  console.group(`[chat-app] signer gas — ${label}`);
  try {
    console.log({ signer: owner });

    const [balance, coins] = await Promise.all([
      client.core.getBalance({ owner, coinType: '0x2::myso::MYSO' }),
      client.core.listCoins({ owner, coinType: '0x2::myso::MYSO' }),
    ]);

    console.log({
      totalBalance: balance.balance.balance,
      addressBalance: balance.balance.addressBalance,
      coinBalance: balance.balance.coinBalance,
      listCoinsCount: coins.objects.length,
    });

    const { checks: listChecks } = await validateListedCoinsOnRpc(
      client,
      coins.objects.map((c) => ({
        objectId: c.objectId,
        digest: c.digest,
        version: c.version,
      })),
      'listCoins',
    );

    for (const check of listChecks) {
      const status = check.existsOnRpc ? 'rpc ok' : 'rpc GHOST';
      console.log(`[listCoins] ${status}`, {
        objectId: check.objectId,
        digest: check.digest,
        version: check.version,
      });
      if (!check.existsOnRpc) {
        console.warn(
          `[chat-app] listCoins ghost coin (not on RPC): ${check.objectId}`,
        );
      }
      warnIfStale('signer.coin', check.objectId);
    }

    const { refs: ownedRefs, checks: ownedChecks } =
      await collectOwnedCoinRefs(client, owner);

    console.log({
      listOwnedObjectsCoinCount: ownedRefs.length,
      listOwnedObjectsCoinIds: ownedRefs.map((r) => r.objectId),
    });

    for (const check of ownedChecks) {
      const status = check.existsOnRpc ? 'rpc ok' : 'rpc GHOST';
      console.log(`[listOwnedObjects] ${status}`, {
        objectId: check.objectId,
        digest: check.digest,
        version: check.version,
      });
    }
  } catch (error) {
    console.warn('[chat-app] signer gas lookup failed:', error);
  } finally {
    console.groupEnd();
  }
}

/** Dev helper: RPC existence check for a named set of singleton object IDs. */
export async function verifyCreateGroupObjectsOnRpc(
  label: string,
  expected: Record<string, string>,
  client: ClientWithCoreApi = createBaseMySoRpcClient(),
): Promise<void> {
  if (!import.meta.env.DEV) return;

  console.group(`[chat-app] rpc object check — ${label}`);

  await Promise.all(
    Object.entries(expected).map(async ([name, objectId]) => {
      try {
        await client.core.getObject({ objectId });
        console.log(`[rpc ok] ${name}`, objectId);
      } catch (error) {
        console.error(
          `[rpc FAIL] ${name}`,
          objectId,
          error instanceof Error ? error.message : error,
        );
      }
    }),
  );

  console.groupEnd();
}
