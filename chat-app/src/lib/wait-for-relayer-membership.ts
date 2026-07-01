import {
  RelayerTransportError,
  waitForMembership,
} from '@socialproof/myso-messaging-stack';
import type { Signer } from '@socialproof/myso/cryptography';

import type { MessagingClient } from './messaging-client-factory';

export interface WaitForRelayerMembershipOptions {
  client: MessagingClient;
  signer: Signer;
  groupId: string;
  uuid: string;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('waitForRelayerMembership aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('waitForRelayerMembership aborted'));
      },
      { once: true },
    );
  });
}

function isRelayerMembershipPending(err: unknown): boolean {
  if (err instanceof RelayerTransportError) {
    return err.code === 'NOT_GROUP_MEMBER' || err.status === 403;
  }
  if (err instanceof Error) {
    return err.message.includes('is not a member of group');
  }
  return false;
}

/**
 * Waits until the relayer membership cache allows reading the group (MessagingReader).
 * Probes via getMessages; NOT_GROUP_MEMBER means sync is still in progress.
 */
export async function waitForRelayerMembership(
  options: WaitForRelayerMembershipOptions,
): Promise<void> {
  const {
    client,
    signer,
    uuid,
    timeoutMs = 30_000,
    intervalMs = 500,
    signal,
  } = options;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('waitForRelayerMembership aborted');
    }

    try {
      await client.messaging.getMessages({
        signer,
        groupRef: { uuid },
        limit: 1,
        mydataApproveContext: undefined,
      });
      return;
    } catch (err) {
      if (!isRelayerMembershipPending(err)) {
        throw err;
      }
    }

    await sleep(intervalMs, signal);
  }

  throw new Error(
    'Timed out waiting for the relayer to sync group membership. Restart the relayer or retry in a moment.',
  );
}

export interface WaitForGroupReadyOptions {
  client: MessagingClient;
  signer: Signer;
  groupId: string;
  uuid: string;
  memberAddress: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** On-chain permission check, then relayer cache sync. */
export async function waitForGroupReady(
  options: WaitForGroupReadyOptions,
): Promise<void> {
  const { client, signer, groupId, uuid, memberAddress, timeoutMs, signal } =
    options;

  await waitForMembership({
    messaging: client.messaging,
    groupId,
    memberAddress,
    permission: 'MessagingSender',
    timeoutMs,
    signal,
  });

  await waitForRelayerMembership({
    client,
    signer,
    groupId,
    uuid,
    timeoutMs,
    signal,
  });
}
