import {
  PaymentRequiredError,
  PAID_DM_MIN_REPLY_CHARS,
  RelayerTransportError,
} from '@socialproof/myso-messaging-stack';

import { mistToMyso } from './mys-coin';

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
      ? `This user requires a ${mistToMyso(minCost)} MYSO escrow before receiving a first message.`
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

export function formatPaidClaimError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('EReplyTooShort') || msg.includes('reply too short')) {
      return `Reply must be at least ${PAID_DM_MIN_REPLY_CHARS} characters to claim the escrow.`;
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
