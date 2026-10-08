import type { TokenTransferPayload } from '@socialproof/myso-messaging-stack';

/**
 * A transfer that executed on-chain but whose chat message failed to post (network drop,
 * tab closed). Persisted per browser and retried when the thread reopens. Posting is
 * idempotent per (sender, digest), so a retry can never create a second message.
 */
export interface PendingTransfer {
  groupUuid: string;
  digest: string;
  payload: TokenTransferPayload;
  requestMessageId?: string;
  senderWallet?: string;
  savedAt: number;
}

const KEY = 'chat.pendingTransfers.v1';

function readAll(): PendingTransfer[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingTransfer[]) : [];
  } catch {
    return [];
  }
}

function writeAll(items: PendingTransfer[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode / quota): best effort only.
  }
}

export function savePendingTransfer(item: PendingTransfer): void {
  const rest = readAll().filter((p) => p.digest !== item.digest);
  writeAll([...rest, item]);
}

export function removePendingTransfer(digest: string): void {
  writeAll(readAll().filter((p) => p.digest !== digest));
}

export function pendingTransfersForGroup(groupUuid: string): PendingTransfer[] {
  return readAll().filter((p) => p.groupUuid === groupUuid);
}
