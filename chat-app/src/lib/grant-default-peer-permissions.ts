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
    tx: {
      grantPermissions: (opts: {
        groupId: string;
        member: string;
        permissionTypes: string[];
      }) => import('@socialproof/myso/transactions').Transaction;
    };
  };
};

/**
 * Default peer caps after create.
 * On-chain create already grants MessagingReader to initial members; we add
 * send, edit, delete, group-handle, and metadata (rename).
 */
export function defaultPeerPermissionTypes(client: GrantClient): string[] {
  const bcs = client.messaging.bcs;
  return [
    bcs.MessagingSender.name,
    bcs.MessagingEditor.name,
    bcs.MessagingDeleter.name,
    bcs.GroupHandleAdmin.name,
    bcs.MetadataAdmin.name,
  ];
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
  const permissionTypes = defaultPeerPermissionTypes(client);
  const uniquePeers = dedupeAddresses(peers);

  for (const member of uniquePeers) {
    try {
      const tx = client.groups.tx.grantPermissions({
        groupId,
        member,
        permissionTypes,
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
    } catch (err) {
      console.warn(
        `[chat-app] default peer permissions grant failed for ${member} (group still created):`,
        err,
      );
    }
  }
}
