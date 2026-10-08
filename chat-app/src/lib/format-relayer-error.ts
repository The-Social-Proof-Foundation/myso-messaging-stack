import {
  PaymentRequiredError,
  PAID_DM_MIN_REPLY_CHARS,
  RelayerTransportError,
} from '@socialproof/myso-messaging-stack';

import { GeneralError, InternalError } from '@socialproof/mydata';

import { mistToMyso } from './mys-coin';

/**
 * MyData key-server hiccup (500 "caller should retry", 5xx, or a dropped fetch).
 * Encrypting a message needs the group DEK, which comes from the key server, so a
 * blip there fails the send even though nothing is wrong with the message.
 */
export function isTransientMyDataError(err: unknown): boolean {
  if (err instanceof InternalError) return true;
  if (err instanceof GeneralError) return (err.status ?? 0) >= 500;
  if (err instanceof TypeError && /fetch/i.test(err.message)) return true;
  return err instanceof Error && err.message.includes('caller should retry');
}

/** Retry `run` on transient MyData failures with linear backoff. */
export async function withMyDataRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isTransientMyDataError(err) || attempt >= attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

export function isNotGroupMemberError(err: unknown): boolean {
  if (err instanceof RelayerTransportError) {
    return err.code === 'NOT_GROUP_MEMBER' || err.status === 403;
  }
  if (err instanceof Error) {
    return err.message.includes('is not a member of group');
  }
  return false;
}

/** Relayer paid-DM gate rejection (402 PAYMENT_REQUIRED). */
export function isPaymentRequiredError(
  err: unknown,
): err is PaymentRequiredError {
  return (
    err instanceof PaymentRequiredError ||
    (err instanceof RelayerTransportError &&
      (err.status === 402 || err.code === 'PAYMENT_REQUIRED'))
  );
}

export function formatRelayerError(err: unknown): string {
  if (isPaymentRequiredError(err)) {
    const minCost = err instanceof PaymentRequiredError ? err.minCost : null;
    return minCost !== null
      ? `This user requires a ${mistToMyso(minCost)} MySo escrow before receiving a first message.`
      : 'This user requires an on-chain payment before receiving a first message.';
  }

  if (isNotGroupMemberError(err)) {
    return (
      'The relayer has not synced your group membership yet. Wait a few seconds and try again. ' +
      'If this persists after regenesis, restart the relayer and reset membership tables (see relayer README).'
    );
  }

  if (err instanceof RelayerTransportError) {
    return err.message;
  }

  if (err instanceof Error) {
    return err.message;
  }

  return 'Request failed.';
}

export function formatPaidClaimError(
  err: unknown,
  minReplyChars: number = PAID_DM_MIN_REPLY_CHARS,
): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('EReplyTooShort') || msg.includes('reply too short')) {
      return `Reply must be at least ${minReplyChars} characters to claim the escrow.`;
    }
    if (msg.includes('EPaymentClaimed') || msg.includes('already claimed')) {
      return 'This escrow has already been claimed.';
    }
    if (msg.includes('EForbidden') || msg.includes('not permitted')) {
      return 'You are not allowed to claim this escrow.';
    }
    return msg;
  }
  return 'Failed to claim paid-message escrow.';
}

export function formatSendError(
  err: unknown,
  options?: { onChainCanSend?: boolean },
): string {
  if (options?.onChainCanSend && isNotGroupMemberError(err)) {
    return (
      'On-chain permissions OK — waiting for relayer sync. Try again in a few seconds.'
    );
  }
  return formatRelayerError(err);
}
