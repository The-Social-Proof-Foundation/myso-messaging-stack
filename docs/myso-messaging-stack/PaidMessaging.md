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

Recipients claim escrow on-chain when replying to the first paid message. The relayer delivers the message separately after the claim transaction.

```typescript
import {
  PAID_DM_MIN_REPLY_CHARS,
  PAID_MSG_NO_PLATFORM_FEE_RECIPIENT,
} from '@socialproof/myso-messaging-stack';

// Wallet paid DM (no platform): platform sentinel routes 500 bps to ecosystem treasury.
await paid.replyAndClaimSettled({
  signer: recipientKeypair,
  groupRef: { uuid },
  paidMsgSeq: 0n, // first escrow is seq 0
  charCount: 42, // must be >= PAID_DM_MIN_REPLY_CHARS (6)
  dedupeKey,
  nonce: 2n,
  platformFeeRecipient: PAID_MSG_NO_PLATFORM_FEE_RECIPIENT,
});

// Agent/platform paid DM: normal 250 bps platform + 250 bps ecosystem split.
await paid.replyAndClaimSettled({
  signer: recipientKeypair,
  groupRef: { uuid },
  paidMsgSeq: 0n,
  charCount: 42,
  dedupeKey,
  nonce: 2n,
  platformFeeRecipient: '0x…', // platform treasury payout address
});
```

Ecosystem fees are resolved on-chain from the genesis `EcosystemTreasury` shared object (`profile::get_treasury_address`). The SDK passes `ecosystemTreasuryId` from `packageConfig` (resolved via `resolveGenesisMessagingConfig`).

For unsigned PTBs (custom signing / gas resolution), use `buildReplyAndClaimSettled()`.

Senders may refund expired escrow:

```typescript
await paid.refundEscrow({
  signer: senderKeypair,
  groupRef: { uuid },
  paidMsgSeq: 0n,
});
```

## Relayer scope

The relayer indexes `PaidMessageSent` into its own `paid_message_escrows` (gate-only: non-expired existence) and exposes advisory `GET /v1/messaging/dm-gate` plus **402** on `POST /v1/messages` when payment is still required. Free-message delivery stays gated until an indexed escrow exists (or follow / reply exemptions apply). Clients still settle claim/refund on-chain via Move.

## Refund eligibility (social indexer)

Full escrow lifecycle (`escrowed` / `claimed` / `settled` / `refunded`) lives in the **social indexer** `paid_message_escrows` table (myso-core), not the relayer gate table. Clients decide whether to show **Refund expired escrow** via:

- `GET /wallets/{address}/paid-messages` — latest status per `(groupId, seq)` where the wallet is payer or recipient
- `GET /messaging/configuration` — `paymentExpirationMs` (fallback 30 days)

Show refund when status is still `escrowed`, `payer` is the caller, and `createdAtMs + paymentExpirationMs <= now`. Do not use dm-gate `paid` for this (that flag drops after expiry).

## Chat-app

Set `VITE_SOCIAL_SERVER_URL` and use the sidebar **Paid messaging** panel to set/display policy. Optional paid-DM badge in message UI can key off recipient policy via `getOnChainPolicy()`.

Reply-to-claim uses the genesis-resolved `EcosystemTreasury` shared object from SDK `packageConfig` — no fee recipient env vars are required.

## iOS

iOS keeps **local draft → first send** (not pay-on-Create Next):

1. Empty draft shows **New chat** + advisory cost from `checkDmGate`.
2. First send on a 1:1 draft with `PAYMENT_REQUIRED` → SwiftUI confirm → `MessagingPaidDmService.openPaidDm` (same-PTB create + escrow + share).
3. Free / following / multi-peer → unpaid `createAndShare`.
4. Existing thread **402** → confirm → `payDmEscrow` → retry send.
5. Follow-ons: claim banner + `replyAndClaimSettled`, Details refund gated by social-indexer paid-messages, Settings policy, inbox **PAID** badge.

See [`ClientSide-iOS.md`](./ClientSide-iOS.md) (Create Conversation + QA matrix).
