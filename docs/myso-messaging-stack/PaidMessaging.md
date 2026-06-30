# Paid Stranger DMs

Paid messaging lets wallets opt in to receive stranger 1:1 DMs backed by on-chain MYSO escrow in each group's `MessageLog`.

## Policy

Recipients configure policy in `PaidMessagingRegistry`:

```typescript
import { createPaidMessagingClient } from '@socialproof/myso-messaging-stack';

const paid = createPaidMessagingClient({ messaging: client.messaging });

await paid.setPolicy({
  signer: recipientKeypair,
  enabled: true,
  minCost: 1_000n, // minimum escrow in MYSO base units
});
```

Off-chain gating (recommended before building a PTB) uses myso-social-server:

```typescript
import { createPaidMessagingClientWithGating } from '@socialproof/myso-messaging-stack';

const paid = createPaidMessagingClientWithGating({
  messaging: client.messaging,
  socialServerUrl: 'https://social.testnet.mysocial.network',
});

await paid.assertPaidOpenAllowed({ recipient, escrowAmount: 5_000n });
```

Read policy on-chain via dev-inspect:

```typescript
const policy = await paid.getOnChainPolicy(recipientAddress);
// { enabled: true, minCost: 1000n }
```

## Open a paid DM

Creates a 1:1 group and escrows the opening payment in one transaction:

```typescript
const { groupId, uuid } = await paid.openPaidDm({
  signer: senderKeypair,
  recipient: recipientAddress,
  escrowAmount: 5_000n,
  paymentCoinId: coinObjectId,
  dedupeKey: crypto.getRandomValues(new Uint8Array(32)),
  nonce: 1n,
  name: 'Paid intro',
});
```

Agents use `openAgentPaidDm()` with `platformId` and `memoryAccountId`.

## Reply and settle

Recipients reply on-chain and claim escrow (with platform/ecosystem fee split):

```typescript
await paid.replyAndClaimSettled({
  signer: recipientKeypair,
  groupRef: { uuid },
  paidMsgSeq: 1n,
  charCount: 42,
  dedupeKey,
  nonce: 2n,
  platformFeeRecipient: '0x…',
  ecosystemFeeRecipient: '0x…',
});
```

Senders may refund expired escrow:

```typescript
await paid.refundEscrow({
  signer: senderKeypair,
  groupRef: { uuid },
  paidMsgSeq: 1n,
});
```

## Relayer scope

The relayer does **not** index paid escrow state. Clients read `MessageLog` on-chain directly; the relayer only stores encrypted message payloads and optional agent attribution metadata.

## Chat-app

Set `VITE_SOCIAL_SERVER_URL` and use the sidebar **Paid messaging** panel to set/display policy. Optional paid-DM badge in message UI can key off recipient policy via `getOnChainPolicy()`.
