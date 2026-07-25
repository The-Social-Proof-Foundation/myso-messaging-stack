import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import { signAndExecuteTransactionAndWait } from './sign-and-wait';
import { dedupeAddresses } from './wallet-profile';

/** Minimal surface used from the messaging stack client. */
type GrantClient = ClientWithCoreApi & {
  messaging: {
    bcs: {
      MessagingSender: { name: string };
      MessagingEditor: { name: string };
      MessagingDeleter: { name: string };
      GroupHandleAdmin: { name: string };
      MetadataAdmin: { name: string };
    };
  };
  groups: {
    view: {
      hasPermission: (opts: {
        groupId: string;
        member: string;
        permissionType: string;
      }) => Promise<boolean>;
    };
    tx: {
      grantPermissions: (opts: {
        groupId: string;
        member: string;
        permissionTypes: string[];
      }) => import('@socialproof/myso/transactions').Transaction;
      grantPermission: (opts: {
        groupId: string;
        member: string;
        permissionType: string;
      }) => import('@socialproof/myso/transactions').Transaction;
    };
  };
};

/**
 * Default peer caps after create.
 * On-chain create already grants MessagingReader to initial members; we add
 * send, edit, delete (required), plus group-handle and metadata (best-effort).
 */
export function defaultPeerPermissionTypes(client: GrantClient): string[] {
  return [
    ...corePeerPermissionTypes(client),
    ...optionalPeerPermissionTypes(client),
  ];
}

function corePeerPermissionTypes(client: GrantClient): string[] {
  const bcs = client.messaging.bcs;
  return [
    bcs.MessagingSender.name,
    bcs.MessagingEditor.name,
    bcs.MessagingDeleter.name,
  ];
}

function optionalPeerPermissionTypes(client: GrantClient): string[] {
  const bcs = client.messaging.bcs;
  return [bcs.GroupHandleAdmin.name, bcs.MetadataAdmin.name];
}

async function missingPermissionTypes(
  client: GrantClient,
  groupId: string,
  member: string,
  permissionTypes: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const permissionType of permissionTypes) {
    try {
      const has = await client.groups.view.hasPermission({
        groupId,
        member,
        permissionType,
      });
      if (!has) missing.push(permissionType);
    } catch {
      // If the check fails, attempt the grant — chain will no-op/abort as needed.
      missing.push(permissionType);
    }
  }
  return missing;
}

async function grantPermissionBatch(
  client: GrantClient,
  signer: Signer,
  groupId: string,
  member: string,
  permissionTypes: readonly string[],
): Promise<void> {
  if (permissionTypes.length === 0) return;

  const tx = client.groups.tx.grantPermissions({
    groupId,
    member,
    permissionTypes: [...permissionTypes],
  });
  await signAndExecuteTransactionAndWait(client, signer, tx);
}

/** One permission per TX so a duplicate/abort on one type cannot block the rest. */
async function grantPermissionsIndividually(
  client: GrantClient,
  signer: Signer,
  groupId: string,
  member: string,
  permissionTypes: readonly string[],
): Promise<void> {
  for (const permissionType of permissionTypes) {
    try {
      const stillMissing = await missingPermissionTypes(client, groupId, member, [
        permissionType,
      ]);
      if (stillMissing.length === 0) continue;

      const tx = client.groups.tx.grantPermission({
        groupId,
        member,
        permissionType,
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
    } catch (err) {
      console.warn(
        `[chat-app] peer permission grant failed (${permissionType}) for ${member}:`,
        err,
      );
    }
  }
}

async function grantWithRetry(
  client: GrantClient,
  signer: Signer,
  groupId: string,
  member: string,
  permissionTypes: readonly string[],
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const missing = await missingPermissionTypes(
      client,
      groupId,
      member,
      permissionTypes,
    );
    if (missing.length === 0) return;

    try {
      await grantPermissionBatch(client, signer, groupId, member, missing);
      return;
    } catch (err) {
      lastError = err;
      console.warn(
        `[chat-app] peer permissions batch attempt ${attempt}/${attempts} failed for ${member}:`,
        err,
      );
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, attempt * 400));
      }
    }
  }

  // Batch kept failing (often a duplicate vec_set insert aborting the whole PTB).
  // Fall back to per-permission grants so Edit/Delete can still stick.
  console.warn(
    `[chat-app] peer permissions batch exhausted for ${member}; granting individually:`,
    lastError,
  );
  await grantPermissionsIndividually(
    client,
    signer,
    groupId,
    member,
    permissionTypes,
  );
}

/**
 * Best-effort grant of collaborative messaging permissions after group create.
 * Creator already has full caps from `create_and_share_group`.
 *
 * Failures are logged and swallowed — the group already exists; blocking the
 * create UI on a follow-up grant abort (e.g. vec_set duplicate) leaves the
 * modal stuck even though the chat is usable.
 */
export async function grantDefaultPeerPermissions(options: {
  client: GrantClient;
  signer: Signer;
  groupId: string;
  peers: readonly string[];
}): Promise<void> {
  const { client, signer, groupId, peers } = options;
  const uniquePeers = dedupeAddresses(peers);
  const core = corePeerPermissionTypes(client);
  const optional = optionalPeerPermissionTypes(client);

  for (const member of uniquePeers) {
    try {
      // Send / Edit / Delete — required for collaborative DMs (retry + individual fallback).
      await grantWithRetry(client, signer, groupId, member, core);
    } catch (err) {
      console.warn(
        `[chat-app] default peer core permissions failed for ${member} (group still created):`,
        err,
      );
    }

    // Handle / Metadata — nice-to-have; never block core caps.
    try {
      const missingOptional = await missingPermissionTypes(
        client,
        groupId,
        member,
        optional,
      );
      if (missingOptional.length > 0) {
        await grantPermissionBatch(
          client,
          signer,
          groupId,
          member,
          missingOptional,
        );
      }
    } catch (err) {
      console.warn(
        `[chat-app] optional peer permissions failed for ${member}:`,
        err,
      );
      await grantPermissionsIndividually(
        client,
        signer,
        groupId,
        member,
        optional,
      );
    }
  }
}
