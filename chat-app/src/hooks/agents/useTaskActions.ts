import {useCallback} from 'react';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {Transaction} from '@socialproof/myso/transactions';

import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {resolveAgentChainIds} from '../../lib/agents/chain-ids';
import {executeAsAgent, executeAsHuman} from '../../lib/agents/execute';
import type {AgentTaskInfo, SubAgentRow} from '../../lib/agents/social-api';
import {hexToBytes} from '../../lib/agents/tasks';
import {
  acceptRefundTx,
  acceptTaskTx,
  cancelOfferTx,
  createTaskTx,
  declineTaskTx,
  expireOfferTx,
  markTaskDeliveredTx,
  proposeRefundTx,
  refundTaskTx,
  rejectRefundTx,
  releaseTaskTx,
  reviewBuyerAgentTx,
  reviewBuyerPrincipalTx,
  reviewSellerTx,
  settleTaskTx,
  withdrawRefundTx,
  type CreateTaskArgs,
} from '../../lib/agents/tx';
import {useInvalidateAgents} from './useInvalidateAgents';
import {useMemoryAccount} from './useMemoryAccount';
import {useAnyPlatformId} from './useTasks';

export type ReviewSide = 'buyer' | 'seller';

/**
 * Task market writes, signed by the human principal through the app's smart-gas path. The
 * contract accepts the principal for every step except delivery, which only the seller agent's
 * own key may sign; `deliverTask` unlocks that key from the vault.
 */
export function useTaskActions() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const account = useMemoryAccount();
  const vault = useAgentVault();
  const platform = useAnyPlatformId();
  const invalidate = useInvalidateAgents();

  const execute = useCallback(
    async (build: (ids: Awaited<ReturnType<typeof resolveAgentChainIds>>) => Transaction) => {
      if (!client || !keypair) throw new Error('Sign in before using the task market.');
      const ids = await resolveAgentChainIds();
      const digest = await executeAsHuman(client as ClientWithCoreApi, keypair, build(ids));
      await invalidate();
      return digest;
    },
    [client, keypair, invalidate],
  );

  /** Settlement and release need a `Platform` object even when the task has none bound. */
  const platformFor = useCallback(
    (task: AgentTaskInfo): string => {
      const id = task.platformId ?? platform.data;
      if (!id) {
        throw new Error('No approved platform is available, so this task cannot be settled yet.');
      }
      return id;
    },
    [platform.data],
  );

  const buyerAccountId = useCallback((): string => {
    const id = account.data?.account_id;
    if (!id) throw new Error('A memory account is required. Create a MySocial profile first.');
    return id;
  }, [account.data?.account_id]);

  return {
    createTask: (args: Omit<CreateTaskArgs, 'buyerAccountId'>) =>
      execute((ids) => createTaskTx(ids, {...args, buyerAccountId: buyerAccountId()})),

    acceptTask: (task: AgentTaskInfo) =>
      execute((ids) =>
        acceptTaskTx(ids, {
          taskId: task.taskId,
          sellerAccountId: task.sellerMemoryAccountId,
          sellerAgentId: task.sellerAgentId,
          termsDigest: hexToBytes(task.termsDigest),
        }),
      ),

    declineTask: (task: AgentTaskInfo) =>
      execute((ids) =>
        declineTaskTx(ids, {
          taskId: task.taskId,
          sellerAccountId: task.sellerMemoryAccountId,
          sellerAgentId: task.sellerAgentId,
        }),
      ),

    cancelOffer: (task: AgentTaskInfo) =>
      execute((ids) =>
        cancelOfferTx(ids, {taskId: task.taskId, buyerAccountId: task.buyerMemoryAccountId}),
      ),

    expireOffer: (task: AgentTaskInfo) =>
      execute((ids) => expireOfferTx(ids, {taskId: task.taskId})),

    /** Only the seller agent's own key can deliver, so it signs and the principal pays gas. */
    deliverTask: async (
      task: AgentTaskInfo,
      agent: SubAgentRow,
      deliverable: {digest: Uint8Array; uri: string},
    ) => {
      if (!client || !keypair) throw new Error('Sign in before using the task market.');
      if (!vault) throw new Error('Unlock agent keys first.');
      await vault.ensureUnlocked();
      const epoch = vault.generation();
      const derived = await vault.getAgent(agent);
      vault.assertCurrent(epoch);
      const ids = await resolveAgentChainIds();
      const tx = markTaskDeliveredTx(ids, {
        taskId: task.taskId,
        sellerAgentId: task.sellerAgentId,
        digest: deliverable.digest,
        uri: deliverable.uri,
      });
      const digest = await executeAsAgent(
        client as ClientWithCoreApi,
        derived.keypair,
        keypair as Ed25519Keypair,
        tx,
        derived.signal,
      );
      vault.assertCurrent(epoch);
      await invalidate();
      return digest;
    },

    /** Pays the seller. `stars` rides in the same transaction as the buyer's review. */
    settleTask: (task: AgentTaskInfo, options: {stars?: number} = {}) =>
      execute((ids) => {
        const tx = settleTaskTx(ids, {
          taskId: task.taskId,
          buyerAccountId: task.buyerMemoryAccountId,
          sellerAccountId: task.sellerMemoryAccountId,
          platformObjectId: platformFor(task),
        });
        if (options.stars) {
          reviewSellerTx(
            ids,
            {
              taskId: task.taskId,
              buyerAccountId: task.buyerMemoryAccountId,
              sellerAccountId: task.sellerMemoryAccountId,
              sellerAgentId: task.sellerAgentId,
              stars: options.stars,
            },
            tx,
          );
        }
        return tx;
      }),

    releaseTask: (task: AgentTaskInfo) =>
      execute((ids) =>
        releaseTaskTx(ids, {
          taskId: task.taskId,
          buyerAccountId: task.buyerMemoryAccountId,
          sellerAccountId: task.sellerMemoryAccountId,
          platformObjectId: platformFor(task),
        }),
      ),

    refundMissedDelivery: (task: AgentTaskInfo) =>
      execute((ids) => refundTaskTx(ids, {taskId: task.taskId})),

    proposeRefund: (task: AgentTaskInfo) =>
      execute((ids) => proposeRefundTx(ids, refundArgs(task))),
    acceptRefund: (task: AgentTaskInfo) => execute((ids) => acceptRefundTx(ids, refundArgs(task))),
    rejectRefund: (task: AgentTaskInfo) => execute((ids) => rejectRefundTx(ids, refundArgs(task))),
    withdrawRefund: (task: AgentTaskInfo) =>
      execute((ids) => withdrawRefundTx(ids, refundArgs(task))),

    /**
     * One review per direction. The buyer rates the seller agent; the seller rates a buyer agent
     * or, when the principal bought directly, the principal.
     */
    reviewTask: (task: AgentTaskInfo, side: ReviewSide, stars: number) =>
      execute((ids) => {
        if (side === 'buyer') {
          return reviewSellerTx(ids, {
            taskId: task.taskId,
            buyerAccountId: task.buyerMemoryAccountId,
            sellerAccountId: task.sellerMemoryAccountId,
            sellerAgentId: task.sellerAgentId,
            stars,
          });
        }
        return task.buyerAgentId
          ? reviewBuyerAgentTx(ids, {
              taskId: task.taskId,
              buyerAccountId: task.buyerMemoryAccountId,
              buyerAgentId: task.buyerAgentId,
              sellerAgentId: task.sellerAgentId,
              stars,
            })
          : reviewBuyerPrincipalTx(ids, {
              taskId: task.taskId,
              buyerAccountId: task.buyerMemoryAccountId,
              sellerAgentId: task.sellerAgentId,
              stars,
            });
      }),
  };
}

function refundArgs(task: AgentTaskInfo) {
  return {
    taskId: task.taskId,
    buyerAccountId: task.buyerMemoryAccountId,
    sellerAgentId: task.sellerAgentId,
  };
}
