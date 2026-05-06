# Extending

## Contents

- [Custom MyData Policy](#custom-mydata-policy)
- [Token-Gated Groups (Paid Join Rule)](#token-gated-groups-paid-join-rule)
- [Custom RelayerTransport](#custom-relayertransport)
- [Custom Attachment StorageAdapter](#custom-attachment-storageadapter)
- [Custom RecoveryTransport](#custom-recoverytransport)

---

The messaging layer is itself an extension of `@socialproof/myso-groups` (see the [MySo Groups Extending guide](https://github.com/the-social-proof-foundation/myso-groups) for foundational patterns). You can extend it further at four levels:

| Extension point | What it controls | Interface |
|-----------------|-----------------|-----------|
| **MyData policy** | Who can decrypt messages | `MyDataPolicy<TApproveContext>` |
| **Relayer transport** | How messages are delivered and stored | `RelayerTransport` |
| **Attachment storage** | Where file attachments are stored | `StorageAdapter` |
| **Recovery transport** | Where messages are recovered from | `RecoveryTransport` |

## Custom MyData Policy

The default MyData policy (`DefaultMyDataPolicy`) gates decryption on `MessagingReader` permission via the `mydata_approve_reader` Move function. To implement custom access control (subscription-based, token-gated, NFT-gated), you write a custom Move `mydata_approve` function and a TypeScript `MyDataPolicy` implementation.

### The MyDataPolicy interface

```typescript
interface MyDataPolicy<TApproveContext = void> {
  /** Package ID used as the MyData encryption namespace. */
  readonly packageId: string;

  /**
   * Build a mydata_approve transaction thunk for MyData decryption.
   * Called lazily at decrypt time.
   */
  mydataApproveThunk(
    identityBytes: Uint8Array,
    groupId: string,
    encryptionHistoryId: string,
    ...context: TApproveContext extends void ? [] : [context: TApproveContext]
  ): (tx: Transaction) => TransactionResult;
}
```

The `TApproveContext` generic lets you pass runtime context (e.g., subscription object IDs) through `sendMessage`, `getMessages`, and other SDK methods that trigger encryption or decryption.

### Example: Subscription-based access (Move)

From [custom_mydata_policy.move](../../move/packages/example_app/sources/custom_mydata_policy.move):

```move
/// A subscription service that gates access to encrypted content.
public struct Service<phantom Token> has key {
    id: UID,
    group_id: ID,
    fee: u64,
    ttl: u64,       // Time-to-live in milliseconds
    owner: address,  // Receives payments
}

/// A time-limited subscription to a Service.
public struct Subscription<phantom Token> has key {
    id: UID,
    service_id: ID,
    created_at: u64,
}

/// Custom mydata_approve: validates identity bytes + checks subscription.
entry fun mydata_approve<Token: drop>(
    id: vector<u8>,
    sub: &Subscription<Token>,
    service: &Service<Token>,
    group: &PermissionedGroup<Messaging>,
    encryption_history: &EncryptionHistory,
    clock: &Clock,
    ctx: &TxContext,
) {
    // Standard identity format validation
    messaging::mydata_policies::validate_identity(group, encryption_history, id);
    // Custom checks: subscription validity, service match, membership
    assert!(check_policy(sub, service, group, clock, ctx), ENoAccess);
}
```

Key design points:
- No wrapper around `PermissionedGroup` is needed. The custom policy references the group by ID.
- Identity bytes always use the standard format (`[groupId][keyVersion]`), enforced by `validate_identity()`.
- This package's ID becomes the MyData encryption namespace (instead of the messaging package).

### Example: Subscription-based access (TypeScript)

```typescript
import type { MyDataPolicy } from '@socialproof/myso-messaging-stack';
import { Transaction, type TransactionResult } from '@socialproof/myso/transactions';

const CUSTOM_PKG = '0xYOUR_CUSTOM_MYDATA_POLICY_PKG';

interface SubContext {
  serviceId: string;
  subscriptionId: string;
}

class SubscriptionMyDataPolicy implements MyDataPolicy<SubContext> {
  readonly packageId = CUSTOM_PKG;

  mydataApproveThunk(
    identityBytes: Uint8Array,
    groupId: string,
    encryptionHistoryId: string,
    context: SubContext,
  ) {
    return (tx: Transaction): TransactionResult => {
      return tx.moveCall({
        target: `${CUSTOM_PKG}::custom_mydata_policy::mydata_approve`,
        typeArguments: ['0x2::myso::MYSO'],
        arguments: [
          tx.pure.vector('u8', identityBytes),
          tx.object(context.subscriptionId),
          tx.object(context.serviceId),
          tx.object(groupId),
          tx.object(encryptionHistoryId),
          tx.object('0x6'), // Clock
        ],
      });
    };
  }
}
```

Wire it up at client creation:

```typescript
const client = createMessagingGroupsClient<SubContext>(baseClient, {
  encryption: {
    sessionKey: { signer: keypair },
    mydataPolicy: new SubscriptionMyDataPolicy(),
  },
  relayer: { relayerUrl: '...' },
});

// TApproveContext flows through to messaging methods
await client.messaging.sendMessage({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  text: 'Hello!',
  approveContext: { serviceId: '0x...', subscriptionId: '0x...' },
});
```

## Token-Gated Groups (Paid Join Rule)

This example uses the actor object pattern from `@socialproof/myso-groups` to implement payment-gated membership. See the [MySo Groups Extending guide](https://github.com/the-social-proof-foundation/myso-groups) for the actor pattern fundamentals.

### Move side

From [paid_join_rule.move](../../move/packages/example_app/sources/paid_join_rule.move):

```move
/// Permission to withdraw accumulated funds.
public struct FundsManager() has drop;

/// Actor that enables paid self-service group joining.
public struct PaidJoinRule<phantom Token> has key {
    id: UID,
    group_id: ID,
    fee: u64,
    balance: Balance<Token>,
}

/// User pays fee, gains MessagingReader permission.
public fun join<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &mut PermissionedGroup<Messaging>,
    payment: &mut Coin<Token>,
    ctx: &TxContext,
) {
    assert!(rule.group_id == object::id(group));
    let fee = coin::split(payment, rule.fee, ctx);
    rule.balance.join(fee.into_balance());
    permissioned_group::object_grant_permission<Messaging, MessagingReader>(
        group, &rule.id, ctx.sender(),
    );
}

/// Withdraw accumulated fees (requires FundsManager permission).
public fun withdraw<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &PermissionedGroup<Messaging>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Token> {
    group.assert_has_permission<Messaging, FundsManager>(ctx.sender());
    coin::from_balance(rule.balance.split(amount), ctx)
}
```

### Setup flow

```move
// 1. Create group
let (mut group, encryption_history) = messaging::messaging::create_group(...);

// 2. Create paid join rule (1 MYSO fee)
let rule = paid_join_rule::new<MYSO>(object::id(&group), 1_000_000_000, ctx);
let rule_address = object::id(&rule).to_address();

// 3. Grant the rule actor ExtensionPermissionsAdmin so it can add members
group.grant_permission<Messaging, ExtensionPermissionsAdmin>(rule_address, ctx);

// 4. Grant FundsManager to a treasurer
group.grant_permission<Messaging, FundsManager>(treasurer, ctx);

// 5. Share both objects
transfer::share_object(group);
transfer::share_object(rule);
```

### TypeScript side

```typescript
const tx = new Transaction();

// Call join with a payment coin
tx.moveCall({
  target: `${EXAMPLE_PKG}::paid_join_rule::join`,
  typeArguments: ['0x2::myso::MYSO'],
  arguments: [
    tx.object(ruleId),
    tx.object(groupId),
    tx.object(paymentCoinId),
  ],
});

await keypair.signAndExecuteTransaction({ transaction: tx, client });
```

## Custom RelayerTransport

Implement `RelayerTransport` to replace the built-in HTTP polling transport with any delivery backend:

```typescript
interface RelayerTransport {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult>;
  fetchMessage(params: FetchMessageParams): Promise<RelayerMessage>;
  updateMessage(params: UpdateMessageParams): Promise<void>;
  deleteMessage(params: DeleteMessageParams): Promise<void>;
  subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage>;
  disconnect(): void;
}
```

Provide your implementation via config:

```typescript
const client = createMessagingGroupsClient(baseClient, {
  encryption: { sessionKey: { signer: keypair } },
  relayer: { transport: myCustomTransport },
});
```

Use cases for custom transports:
- WebSocket or SSE for lower-latency subscriptions
- On-chain message storage for applications that prefer full verifiability over cost/speed
- Custom backend with application-specific routing or filtering logic

See [Relayer](./Relayer.md) for the full type definitions of all parameter and result types.

## Custom Attachment StorageAdapter

The `StorageAdapter` interface controls where **file attachments** are stored. This is separate from the relayer's File Storage Sync (which handles message archival) and the file-storage-discovery-indexer (which handles message recovery). See [Attachments](./Attachments.md) for the full attachment encryption flow.

Implement `StorageAdapter` to replace the built-in File Storage adapter:

```typescript
interface StorageAdapter {
  /** Upload one or more entries as a batch. */
  upload(entries: StorageEntry[]): Promise<StorageUploadResult>;
  /** Download a single entry by its ID. */
  download(id: string): Promise<Uint8Array>;
  /** Optional: delete entries by ID. */
  delete?(ids: string[]): Promise<void>;
}
```

The adapter is encryption-unaware: data arrives already encrypted by the SDK. Provide your implementation via config:

```typescript
import { FileStorageHttpStorageAdapter } from '@socialproof/myso-messaging-stack';

// Built-in File Storage adapter
const client = createMessagingGroupsClient(baseClient, {
  // ...
  attachments: {
    storageAdapter: new FileStorageHttpStorageAdapter({
      publisherUrl: 'https://publisher.file-storage-testnet.mysocial.network',
      aggregatorUrl: 'https://aggregator.file-storage-testnet.mysocial.network',
      epochs: 5,
    }),
  },
});

// Or a custom adapter (e.g., IPFS, S3)
const client = createMessagingGroupsClient(baseClient, {
  // ...
  attachments: {
    storageAdapter: myIpfsAdapter,
  },
});
```

## Custom RecoveryTransport

Implement `RecoveryTransport` to enable message recovery from an alternative storage backend (e.g., File Storage):

```typescript
interface RecoveryTransport {
  recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult>;
}
```

When provided, the client exposes a `recoverMessages()` method for fetching messages from the recovery backend. Recovery is read-only and does not require a signer. See [Archive & Recovery](./ArchiveRecovery.md) for the full recovery pipeline.

```typescript
const client = createMessagingGroupsClient(baseClient, {
  // ...
  recovery: myFileStorageRecoveryTransport,
});

// Recover messages from File Storage
const result = await client.messaging.recoverMessages({
  groupRef: { uuid: 'my-group' },
});
```
