import { type SyntheticEvent, useState } from 'react';
import { MYSO_CLOCK_OBJECT_ID } from '@socialproof/myso/utils';
import { createPaidMessagingClient } from '@socialproof/myso-messaging-stack';
import {
  useGraphQLClient,
  useRequiredMessagingClient,
} from '../contexts/MessagingClientContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { addStoredGroup } from '../lib/group-store';
import { formatCreateGroupError } from '../lib/format-create-group-error';
import { grantDefaultPeerPermissions } from '../lib/grant-default-peer-permissions';
import { waitForGroupReady } from '../lib/wait-for-relayer-membership';
import {
  assertMemoryRegistryConfigured,
  expectedCreateGroupObjectIds,
  expectedPaidDmObjectIds,
  fetchAndLogGenesisConfig,
  logClientDeriveIds,
  logCreateGroupTxInputs,
  logFullGenesisClientMismatch,
  logMyDataKeyServers,
  logSignerGasCoins,
  STALE_GHOST_OBJECT_ID,
  verifyCreateGroupObjectsOnRpc,
} from '../lib/messaging-genesis-debug';
import {
  PROFILE_FULL_QUERY,
  buildAutoGroupName,
  dedupeAddresses,
  groupNameLabelForRecipient,
  mapGraphqlProfile,
} from '../lib/wallet-profile';
import { PaymentConfirmDialog } from './PaymentConfirmDialog';

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onGroupCreated: (uuid: string) => void;
}

/** New 1:1 DM waiting on the user to confirm the paid-messaging escrow. */
interface PendingPaidDm {
  recipient: string;
  minCost: bigint;
  name: string;
}

function parseRecipients(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function CreateGroupModal({
  open,
  onClose,
  onGroupCreated,
}: Readonly<CreateGroupModalProps>) {
  const { signer, createFreshMessagingClient } = useRequiredMessagingClient();
  const graphqlClient = useGraphQLClient();

  const [recipients, setRecipients] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paid-DM gate for new 1:1 conversations.
  const [pendingPaidDm, setPendingPaidDm] = useState<PendingPaidDm | null>(null);
  const [payingDm, setPayingDm] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  if (!open) return null;

  async function resolveGroupName(addresses: string[]): Promise<string> {
    const labels = await Promise.all(
      addresses.map(async (address) => {
        try {
          const result = await graphqlClient.query({
            query: PROFILE_FULL_QUERY as unknown as Parameters<
              typeof graphqlClient.query
            >[0]['query'],
            variables: { address },
          });
          const data = result.data as
            | { profile?: Record<string, unknown> | null }
            | undefined;
          const mapped = mapGraphqlProfile(data?.profile ?? null);
          return groupNameLabelForRecipient(address, mapped);
        } catch {
          return groupNameLabelForRecipient(address, null);
        }
      }),
    );
    return buildAutoGroupName(labels);
  }

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    setError(null);

    const initialMembers = parseRecipients(recipients);
    if (initialMembers.length === 0) {
      setError('Add at least one recipient address.');
      return;
    }

    setLoading(true);

    try {
      const sender = signer.toMySoAddress();
      // Official name: recipients first, then creator (all members), ≤128 chars.
      const groupName = await resolveGroupName(
        dedupeAddresses([...initialMembers, sender]),
      );
      const uuid = crypto.randomUUID();

      // Fresh client so packageConfig matches live genesis (not a stale init snapshot).
      const client = await createFreshMessagingClient({
        bypassGenesisCache: true,
      });

      const freshGenesis = await fetchAndLogGenesisConfig(
        client,
        'create-group (fresh client + graphql)',
        { bypassCache: true },
      );
      const expectedObjects = expectedCreateGroupObjectIds(freshGenesis);
      assertMemoryRegistryConfigured('create-group', freshGenesis);

      logClientDeriveIds('create-group (fresh client)', client.messaging.derive, uuid);
      logFullGenesisClientMismatch('create-group', freshGenesis, client);
      await verifyCreateGroupObjectsOnRpc('create-group', expectedObjects, client);
      await logMyDataKeyServers('create-group', client);
      await logSignerGasCoins('create-group', client, signer);

      // New 1:1 DM: advisory paid-DM gate pre-check. The relayer enforces
      // authoritatively on first send (402), this just avoids a doomed create.
      if (initialMembers.length === 1) {
        const recipient = initialMembers[0]!;
        try {
          const gate = await client.messaging.checkDmGate({
            signer,
            recipient,
          });
          if (gate.blocked) {
            setError('You cannot message this user.');
            return;
          }
          if (gate.reason === 'PAYMENT_REQUIRED' && gate.minCost !== null) {
            // Never reached for followed recipients — the gate reports
            // following: true and allows the DM without payment.
            setPayError(null);
            setPendingPaidDm({
              recipient,
              minCost: gate.minCost,
              name: groupName,
            });
            return;
          }
        } catch (gateErr) {
          // Advisory only — fall through to the normal create path and let
          // the relayer enforce at first send.
          console.warn('[chat-app] dm-gate pre-check unavailable:', gateErr);
        }
      }

      let resolvedMemoryAccountId: string | null | undefined;
      if (import.meta.env.DEV) {
        resolvedMemoryAccountId =
          await client.messaging.view.memoryAccountIdForOwner({ owner: sender });
      }

      const tx = client.messaging.tx.createAndShareGroup({
        uuid,
        name: groupName,
        sender,
        initialMembers,
      });

      await logCreateGroupTxInputs(
        'create-group (pre-sign)',
        tx,
        client,
        expectedObjects,
        { resolvedMemoryAccountId },
      );

      await signAndExecuteTransactionAndWait(client, signer, tx);

      const groupId = client.messaging.derive.groupId({ uuid });

      setSyncing(true);
      await waitForGroupReady({
        client,
        signer,
        groupId,
        uuid,
        memberAddress: sender,
      });

      // Peers only get MessagingReader on-chain at create — grant send/edit/
      // delete/handle/metadata so they can collaborate by default.
      await grantDefaultPeerPermissions({
        client,
        signer,
        groupId,
        peers: initialMembers.filter(
          (addr) => addr.toLowerCase() !== sender.toLowerCase(),
        ),
      });

      addStoredGroup({
        uuid,
        name: groupName,
        groupId,
        createdAt: Date.now(),
      });

      setRecipients('');
      onGroupCreated(uuid);
      onClose();
    } catch (err) {
      console.error('Failed to create group:', err);
      if (
        err instanceof Error &&
        err.message.includes(STALE_GHOST_OBJECT_ID)
      ) {
        console.error(
          `[chat-app] create-group failed on stale object ${STALE_GHOST_OBJECT_ID}. ` +
            'Check "[chat-app] create-group tx inputs" and "[chat-app] messaging genesis" above.',
        );
      }
      setError(formatCreateGroupError(err));
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }

  /**
   * Confirmed paid DM: one signed transaction creates the group and escrows
   * the payment (create_and_share_group + send_paid_message_digest). The
   * escrow is funded by splitting from gas; the contract re-validates the
   * recipient's minimum on-chain.
   *
   * Runs the same diagnostics + hardened signing as the normal create path:
   * the PTB is built via `buildOpenPaidDm` and signed through
   * `signAndExecuteTransactionAndWait`, whose gas resolution RPC-verifies
   * coins (stale local indexers after `--force-regenesis` list ghost coins
   * that otherwise become invalid PTB inputs when the escrow splits from gas).
   */
  async function handleConfirmPaidDm() {
    if (!pendingPaidDm) return;

    setPayingDm(true);
    setPayError(null);

    try {
      const client = await createFreshMessagingClient({
        bypassGenesisCache: true,
      });
      const paid = createPaidMessagingClient({ messaging: client.messaging });

      const freshGenesis = await fetchAndLogGenesisConfig(
        client,
        'open-paid-dm (fresh client + graphql)',
        { bypassCache: true },
      );
      const expectedObjects = expectedPaidDmObjectIds(freshGenesis);
      assertMemoryRegistryConfigured('open-paid-dm', freshGenesis);

      const uuid = crypto.randomUUID();
      logClientDeriveIds('open-paid-dm (fresh client)', client.messaging.derive, uuid);
      logFullGenesisClientMismatch('open-paid-dm', freshGenesis, client);
      await verifyCreateGroupObjectsOnRpc('open-paid-dm', expectedObjects, client);
      await logMyDataKeyServers('open-paid-dm', client);
      await logSignerGasCoins('open-paid-dm', client, signer);

      const sender = signer.toMySoAddress();

      let resolvedMemoryAccountId: string | null | undefined;
      if (import.meta.env.DEV) {
        resolvedMemoryAccountId =
          await client.messaging.view.memoryAccountIdForOwner({ owner: sender });
      }

      const { transaction, groupId } = paid.buildOpenPaidDm({
        sender,
        recipient: pendingPaidDm.recipient,
        escrowAmount: pendingPaidDm.minCost,
        name: pendingPaidDm.name,
        uuid,
        // Reuse the diagnostics resolution (dev); undefined lets the SDK
        // resolve wallet-vs-profile routing at build time as usual.
        creatorMemoryAccountId: resolvedMemoryAccountId ?? undefined,
      });

      await logCreateGroupTxInputs(
        'open-paid-dm (pre-sign)',
        transaction,
        client,
        {
          ...expectedObjects,
          // The group/log are same-PTB results (created then shared in this
          // transaction), so they never appear as object inputs — only the
          // singletons and the clock do.
          clockId: MYSO_CLOCK_OBJECT_ID,
        },
        { resolvedMemoryAccountId },
      );

      await signAndExecuteTransactionAndWait(client, signer, transaction);

      setSyncing(true);
      await waitForGroupReady({
        client,
        signer,
        groupId,
        uuid,
        memberAddress: sender,
      });

      await grantDefaultPeerPermissions({
        client,
        signer,
        groupId,
        peers: [pendingPaidDm.recipient],
      });

      addStoredGroup({
        uuid,
        name: pendingPaidDm.name,
        groupId,
        createdAt: Date.now(),
      });

      setRecipients('');
      setPendingPaidDm(null);
      onGroupCreated(uuid);
      onClose();
    } catch (err) {
      console.error('Failed to open paid DM:', err);
      if (
        err instanceof Error &&
        err.message.includes(STALE_GHOST_OBJECT_ID)
      ) {
        console.error(
          `[chat-app] open-paid-dm failed on stale object ${STALE_GHOST_OBJECT_ID}. ` +
            'Check "[chat-app] create-group tx inputs — open-paid-dm (pre-sign)" and ' +
            '"[chat-app] messaging genesis" above.',
        );
      }
      setPayError(formatCreateGroupError(err));
    } finally {
      setPayingDm(false);
      setSyncing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800">
        <h2 className="mb-4 text-lg font-semibold text-secondary-900 dark:text-secondary-100">
          New Message
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="recipients"
              className="mb-1 block text-sm font-medium text-secondary-700 dark:text-secondary-300"
            >
              Recipients <span className="text-danger-500">*</span>
            </label>
            <textarea
              id="recipients"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="Comma-separated MySo addresses&#10;0xabc..., 0xdef..."
              rows={3}
              disabled={loading || syncing}
              required
              className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500"
            />
          </div>

          {error && (
            <p className="text-sm text-danger-500">{error}</p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading || syncing}
              className="rounded-lg px-4 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || syncing}
              className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {syncing
                ? 'Syncing membership…'
                : loading
                  ? 'Creating...'
                  : 'Create Group'}
            </button>
          </div>
        </form>
      </div>

      {/* Paid-DM gate: recipient requires an escrow before a first message */}
      <PaymentConfirmDialog
        open={pendingPaidDm !== null}
        recipient={pendingPaidDm?.recipient ?? null}
        minCost={pendingPaidDm?.minCost ?? null}
        busy={payingDm || syncing}
        error={payError}
        onConfirm={() => void handleConfirmPaidDm()}
        onCancel={() => {
          setPendingPaidDm(null);
          setPayError(null);
        }}
      />
    </div>
  );
}
