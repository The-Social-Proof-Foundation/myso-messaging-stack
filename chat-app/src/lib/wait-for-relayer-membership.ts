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

/**
 * True for the relayer's "not a member yet" 403: the on-chain grant exists (or is landing) but
 * the relayer's checkpoint sync has not caught up. Transient, unlike any other failure.
 */
export function isRelayerMembershipPending(err: unknown): boolean {
  if (err instanceof RelayerTransportError) {
    return err.code === 'NOT_GROUP_MEMBER' || err.status === 403;
  }
  if (err instanceof Error) {
    return err.message.includes('is not a member of group');
  }
  return false;
}

const MAX_INTERVAL_MS = 4_000;
/** One wait per group: concurrent openers share it instead of each polling the relayer. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Waits until the relayer membership cache allows reading the group (MessagingReader).
 * Probes via getMessages; NOT_GROUP_MEMBER means sync is still in progress. Probes back off
 * (500ms growing to 4s) so a group that never syncs costs about a dozen requests, not sixty.
 */
export function waitForRelayerMembership(
  options: WaitForRelayerMembershipOptions,
): Promise<void> {
  const key = `${options.uuid}:${options.signer.toMySoAddress().toLowerCase()}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = probeRelayerMembership(options).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function probeRelayerMembership(
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
  let delay = intervalMs;

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

    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * 1.6), MAX_INTERVAL_MS);
  }

  throw new Error(
    'This chat is not readable yet: the relayer has not recognized your access to the group. Try again in a moment.',
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

export interface WaitForAgentChatReadyOptions {
  client: MessagingClient;
  signer: Signer;
  groupId: string;
  uuid: string;
  /** The human principal owner of the agent that created the group. */
  principalAddress: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Readiness for an **agent-created** group.
 *
 * `waitForGroupReady` probes `MessagingSender`, which the human principal never receives on
 * an agent group (`create_agent_group` grants them `MessagingReader` + `PermissionsAdmin`
 * and explicitly revokes the agent's admin caps). Probing the sender permission there would
 * always time out, so agent chats wait on `MessagingReader` instead.
 */
export async function waitForAgentChatReady(
  options: WaitForAgentChatReadyOptions,
): Promise<void> {
  const { client, signer, groupId, uuid, principalAddress, timeoutMs, signal } = options;

  await waitForMembership({
    messaging: client.messaging,
    groupId,
    memberAddress: principalAddress,
    permission: 'MessagingReader',
    timeoutMs,
    signal,
  });

  await waitForRelayerMembership({ client, signer, groupId, uuid, timeoutMs, signal });
}
