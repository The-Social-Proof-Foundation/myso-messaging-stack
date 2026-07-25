/**
 * Inbox tip-ingest delivered ACK (sidebar / list), open-thread parity.
 * Posts `delivered_upto` only — never `read_upto`. Debounced per group.
 */

import type { ReceiptMode } from '@socialproof/myso-messaging-stack';
import type { MessagingClient } from './messaging-client-factory';

const DEBOUNCE_MS = 400;

type Signer = Parameters<
  MessagingClient['messaging']['postGroupReceipts']
>[0]['signer'];

const pendingByGroup = new Map<string, number>();
const lastSentByGroup = new Map<string, number>();
const timersByGroup = new Map<string, ReturnType<typeof setTimeout>>();
/** groupId → receipt mode (from last prefs fetch). */
const modeByGroup = new Map<string, ReceiptMode>();

function groupKey(groupId: string): string {
  return groupId.trim().toLowerCase();
}

async function resolveReceiptMode(
  client: MessagingClient,
  signer: Signer,
  uuid: string,
  groupId: string,
): Promise<ReceiptMode> {
  const key = groupKey(groupId);
  const cached = modeByGroup.get(key);
  if (cached) return cached;
  try {
    const prefs = await client.messaging.getConversationPrefs({
      signer,
      groupRef: { uuid },
    });
    modeByGroup.set(key, prefs.receiptMode);
    return prefs.receiptMode;
  } catch {
    // Fail-open: allow delivered ACK; server still strips if mode is none.
    return 'full';
  }
}

function flushGroup(
  client: MessagingClient,
  signer: Signer,
  uuid: string,
  groupId: string,
): void {
  const key = groupKey(groupId);
  const deliveredUpto = pendingByGroup.get(key) ?? 0;
  const lastSent = lastSentByGroup.get(key) ?? 0;
  if (!Number.isFinite(deliveredUpto) || deliveredUpto <= 0 || deliveredUpto <= lastSent) {
    return;
  }
  lastSentByGroup.set(key, deliveredUpto);
  void client.messaging
    .postGroupReceipts({
      signer,
      groupRef: { uuid },
      deliveredUpto,
    })
    .catch((err) => {
      if (lastSentByGroup.get(key) === deliveredUpto) {
        lastSentByGroup.set(key, lastSent);
      }
      console.warn(
        `[inbox] delivered ACK failed ${groupId.slice(0, 10)}…`,
        err,
      );
    });
}

/**
 * After a successful inbox tip fetch: schedule delivered ACK when tip is from a peer.
 */
export function scheduleInboxDeliveredAck(options: {
  client: MessagingClient;
  signer: Signer;
  groupId: string;
  uuid: string;
  tipOrder: number;
  tipSenderAddress: string;
  selfAddress: string;
  isDeleted?: boolean;
}): void {
  const {
    client,
    signer,
    groupId,
    uuid,
    tipOrder,
    tipSenderAddress,
    selfAddress,
    isDeleted,
  } = options;
  if (isDeleted) return;
  if (!Number.isFinite(tipOrder) || tipOrder <= 0) return;
  if (!uuid || !groupId) return;
  if (tipSenderAddress.toLowerCase() === selfAddress.toLowerCase()) return;

  const key = groupKey(groupId);
  const prev = pendingByGroup.get(key) ?? 0;
  pendingByGroup.set(key, Math.max(prev, tipOrder));

  const existing = timersByGroup.get(key);
  if (existing) clearTimeout(existing);

  timersByGroup.set(
    key,
    setTimeout(() => {
      timersByGroup.delete(key);
      void (async () => {
        const mode = await resolveReceiptMode(client, signer, uuid, groupId);
        if (mode === 'none') return;
        flushGroup(client, signer, uuid, groupId);
      })();
    }, DEBOUNCE_MS),
  );
}

/** Clear debounce state (logout). */
export function clearInboxDeliveredAckState(): void {
  for (const t of timersByGroup.values()) clearTimeout(t);
  timersByGroup.clear();
  pendingByGroup.clear();
  lastSentByGroup.clear();
  modeByGroup.clear();
}

/** Call when prefs change so the next ACK uses the new mode. */
export function invalidateInboxReceiptMode(groupId: string): void {
  modeByGroup.delete(groupKey(groupId));
}
