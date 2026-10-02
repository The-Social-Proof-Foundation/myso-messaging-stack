import {
  parseSerializedSignature,
  type Signer,
} from '@socialproof/myso/cryptography';
import { toHex } from '@socialproof/myso/utils';

/**
 * Metadata-only conversation report.
 * The signed body is who, which chat, and a reason. The server stamps when.
 * Message plaintext and ciphertext are not fields on this payload.
 */

export const REPORT_REASONS = ['spam', 'harassment', 'scam', 'other'] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_NOTE_MAX_CHARS = 200;

const CONTENT_KEYS = [
  'message',
  'messages',
  'text',
  'body',
  'ciphertext',
  'encrypted_text',
  'plaintext',
  'content',
] as const;

export interface ReportFieldsInput {
  groupId: string;
  /** 1:1 peer. Omit for a group report. */
  reportedWallet: string | null;
  reason: ReportReason;
  note?: string;
}

/** 1:1 threads offer Report + Block. Groups offer Report + Leave. */
export function threadSafetyActions(peerAddress: string | null): {
  report: true;
  block: boolean;
  leave: boolean;
} {
  if (peerAddress) {
    return { report: true, block: true, leave: false };
  }
  return { report: true, block: false, leave: true };
}

/** Fields the client is allowed to send before wallet-auth adds sender and time. */
export function buildReportFields(input: ReportFieldsInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    group_id: input.groupId.trim().toLowerCase(),
    reason: input.reason,
  };
  const peer = input.reportedWallet?.trim().toLowerCase();
  if (peer) {
    fields.reported_wallet = peer;
  }
  if (input.reason === 'other') {
    const note = input.note?.trim() ?? '';
    if (note) {
      fields.note = Array.from(note).slice(0, REPORT_NOTE_MAX_CHARS).join('');
    }
  }
  for (const key of CONTENT_KEYS) {
    if (key in fields) {
      throw new Error('reports cannot include message content');
    }
  }
  return fields;
}

function relayerBase(): string {
  return (import.meta.env.VITE_RELAYER_URL || 'http://localhost:3003').replace(
    /\/+$/,
    '',
  );
}

/**
 * Wallet-auth POST body. The signature covers the exact JSON bytes that are sent.
 * Matches relayer `createBodyAuth`: payload, then sender_address, then timestamp.
 */
async function signedReportBody(
  signer: Signer,
  payload: Record<string, unknown>,
): Promise<{ bodyStr: string; headers: Record<string, string> }> {
  const body: Record<string, unknown> = {
    ...payload,
    sender_address: signer.toMySoAddress().toLowerCase(),
    timestamp: Math.floor(Date.now() / 1000),
  };
  const bodyStr = JSON.stringify(body);
  const { signature } = await signer.signPersonalMessage(
    new TextEncoder().encode(bodyStr),
  );
  const parsed = parseSerializedSignature(signature);
  if (!parsed.signature) {
    throw new Error('Unsupported signature scheme for report auth.');
  }
  return {
    bodyStr,
    headers: {
      'x-signature': toHex(parsed.signature),
      'x-public-key': toHex(signer.getPublicKey().toMySoBytes()),
    },
  };
}

export async function submitConversationReport(
  signer: Signer,
  input: ReportFieldsInput,
): Promise<void> {
  const payload = buildReportFields(input);
  const { bodyStr, headers } = await signedReportBody(signer, payload);
  const res = await fetch(`${relayerBase()}/v1/reports`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: bodyStr,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      message = parsed.error ?? text;
    } catch {
      // non-JSON body
    }
    throw new Error(message || `Report failed (${res.status}).`);
  }
}
