import {
  PaymentRequiredError,
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
