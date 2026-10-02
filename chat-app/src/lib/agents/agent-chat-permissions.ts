import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Signer} from '@socialproof/myso/cryptography';
import type {Transaction} from '@socialproof/myso/transactions';

import {signAndExecuteTransactionAndWait} from '../sign-and-wait';

/** Minimal surface used from the messaging stack client (same shape the group flows use). */
type GrantClient = ClientWithCoreApi & {
  messaging: {
    bcs: {
      MessagingSender: {name: string};
    };
  };
  groups: {
    bcs: {
      ExtensionPermissionsAdmin: {name: string};
      PermissionsAdmin: {name: string};
    };
    view: {
      hasPermission: (opts: {
        groupId: string;
        member: string;
        permissionType: string;
      }) => Promise<boolean>;
    };
    tx: {
      grantPermission: (opts: {
        transaction?: Transaction;
        groupId: string;
        member: string;
        permissionType: string;
      }) => Transaction;
    };
  };
};

/**
 * Core permissions are the four types declared in `permissioned_group`.
 * Messaging Send/Read/Edit live in another package, so they are extension permissions.
 */
export function isCoreGroupPermission(permissionType: string): boolean {
  return permissionType.includes('::permissioned_group::');
}

/**
 * `PermissionsAdmin` can grant `ExtensionPermissionsAdmin`, and only
 * `ExtensionPermissionsAdmin` can grant Send. The extension-admin grant has to
 * be the earlier command so the Send grant sees it.
 */
export function extensionAwareGrantTypes(options: {
  permissionType: string;
  signerHasExtensionAdmin: boolean;
  extensionAdminType: string;
}): string[] {
  const {permissionType, signerHasExtensionAdmin, extensionAdminType} = options;
  if (
    signerHasExtensionAdmin ||
    isCoreGroupPermission(permissionType) ||
    permissionType === extensionAdminType
  ) {
    return [permissionType];
  }
  return [extensionAdminType, permissionType];
}

async function readPermission(
  client: GrantClient,
  groupId: string,
  member: string,
  permissionType: string,
): Promise<boolean | null> {
  try {
    return await client.groups.view.hasPermission({groupId, member, permissionType});
  } catch {
    return null;
  }
}

/**
 * Grants `permissionType` to `member`.
 *
 * When that type is an extension permission and the signer does not already
 * hold `ExtensionPermissionsAdmin`, the same transaction grants it to the
 * signer first. `PermissionsAdmin` is allowed to grant that core permission.
 */
export async function grantMessagingPermission(options: {
  client: GrantClient;
  signer: Signer;
  groupId: string;
  member: string;
  permissionType: string;
}): Promise<void> {
  const {client, signer, groupId, member, permissionType} = options;
  const signerAddress = signer.toMySoAddress();
  const extensionAdminType = client.groups.bcs.ExtensionPermissionsAdmin.name;
  const signerHasExtensionAdmin = await readPermission(
    client,
    groupId,
    signerAddress,
    extensionAdminType,
  );

  if (signerHasExtensionAdmin === false && !isCoreGroupPermission(permissionType)) {
    const signerIsAdmin = await readPermission(
      client,
      groupId,
      signerAddress,
      client.groups.bcs.PermissionsAdmin.name,
    );
    if (signerIsAdmin === false) {
      throw new Error('Admin is required before Send can be granted on this chat.');
    }
  }

  const types = extensionAwareGrantTypes({
    permissionType,
    signerHasExtensionAdmin: signerHasExtensionAdmin === true,
    extensionAdminType,
  });

  let tx = client.groups.tx.grantPermission({
    groupId,
    member: types.length > 1 ? signerAddress : member,
    permissionType: types[0],
  });
  if (types[1]) {
    tx = client.groups.tx.grantPermission({
      transaction: tx,
      groupId,
      member,
      permissionType: types[1],
    });
  }

  await signAndExecuteTransactionAndWait(client, signer, tx);
}

/** Already repaired this group in this session, so opening a chat does not re-check. */
const repairedGroups = new Set<string>();

/**
 * Makes sure `member` can send in an agent-created group.
 *
 * `create_agent_and_share_group` grants the human principal only `MessagingReader`
 * and `PermissionsAdmin`. Send is an extension permission, so Admin alone cannot
 * grant it. This grants `ExtensionPermissionsAdmin` to the signer, then
 * `MessagingSender`, in one transaction.
 *
 * Returns whether a grant was submitted.
 */
export async function ensureAgentChatSendPermission(options: {
  client: GrantClient;
  signer: Signer;
  groupId: string;
  member: string;
}): Promise<boolean> {
  const {client, signer, groupId, member} = options;
  const senderType = client.messaging.bcs.MessagingSender.name;
  const alreadyCanSend = await readPermission(client, groupId, member, senderType);
  if (alreadyCanSend === true) {
    repairedGroups.add(groupId);
    return false;
  }
  if (repairedGroups.has(groupId)) return false;

  await grantMessagingPermission({
    client,
    signer,
    groupId,
    member,
    permissionType: senderType,
  });
  repairedGroups.add(groupId);
  return true;
}

/**
 * Fire-and-forget repair for an existing agent chat.
 *
 * Failures are swallowed: the chat is still readable, and blocking the open on a grant
 * abort would be worse than a chat the user cannot yet reply in.
 */
export function repairAgentChatSendPermissionOnce(options: {
  client: GrantClient;
  signer: Signer;
  groupId: string;
  member: string;
}): void {
  if (repairedGroups.has(options.groupId)) return;
  void ensureAgentChatSendPermission(options).catch((error: unknown) => {
    console.warn('[chat-app] could not grant send permission on agent chat:', error);
  });
}

/** Test seam: forget the session-scoped repair cache. */
export function resetAgentChatRepairCache(): void {
  repairedGroups.clear();
}
