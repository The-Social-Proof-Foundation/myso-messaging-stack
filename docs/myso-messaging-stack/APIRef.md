# SDK API Reference

## Contents

- [Key Types](#key-types)
- [Messaging Methods](#messaging-methods)
- [Group Management Methods](#group-management-methods)
- [Metadata Methods](#metadata-methods)
- [Group handle registry](#group-handle-registry)
- [Verification](#verification)
- [View Methods](#view-methods-clientmessagingview)
- [Derive Methods](#derive-methods-clientmessagingderive)
- [Transaction Builders](#transaction-builders-tx)
- [Call Builders](#call-builders-call)
- [BCS Parsing](#bcs-parsing-bcs)
- [Encryption](#encryption-encryption)
- [Transport](#transport-transport)
- [Permission Types](#permission-types)

---

The Messaging SDK APIs follow the lifecycle of a secure communication system: create groups, manage membership, send messages, and maintain encryption state.

All methods are accessed via the `client.messaging` namespace after [setup](./Setup.md).

For permission management (grant, revoke, check membership), use `client.groups`. See the [MySo Groups API Reference](https://github.com/the-social-proof-foundation/myso-groups).

---

## Key Types

### `GroupRef`

Most methods accept a `GroupRef` to identify a group. Either form works:

```typescript
type GroupRef =
  | { uuid: string }                                        // derives both IDs
  | { groupId: string; encryptionHistoryId: string };       // explicit IDs
```

### `DecryptedMessage`

Returned by `getMessage` and `getMessages`, and carried inside `subscribe` message events:

```typescript
interface DecryptedMessage {
  messageId: string;
  groupId: string;
  order: number;
  text: string;                    // empty string for deleted or attachment-only messages
  senderAddress: string;
  createdAt: number;               // unix timestamp (seconds)
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  syncStatus?: SyncStatus;         // File Storage sync state (when relayer archives)
  attachments: AttachmentHandle[]; // lazy-download handles
  senderVerified: boolean;         // per-message signature verified
}
```

### `AttachmentHandle`

Resolved attachment with lazy download:

```typescript
interface AttachmentHandle {
  fileName: string;
  mimeType: string;
  fileSize: number;
  extras?: Record<string, unknown>;
  wire: Attachment;                // raw wire format (for edits)
  data(): Promise<Uint8Array>;    // download + decrypt on demand
}
```

### `GetMessagesResult`

```typescript
interface GetMessagesResult {
  messages: DecryptedMessage[];
  hasNext: boolean;
}
```

### `EditAttachments`

```typescript
interface EditAttachments {
  current: Attachment[];    // current attachments on the message
  remove?: string[];        // storageIds to remove
  new?: AttachmentFile[];   // new files to upload
}
```

---

## Messaging Methods

These methods handle E2EE messaging via the relayer transport. Encryption and decryption are automatic. See [Encryption](./Encryption.md) for the underlying encryption model.

### `sendMessage(options)`

Encrypt and send a message to a group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Signs the message and authenticates with the relayer |
| `groupRef` | `GroupRef` | Yes | Target group |
| `text` | `string` | No* | Message text |
| `files` | `AttachmentFile[]` | No* | Files to attach (requires attachments config) |
| `mydataApproveContext` | `TApproveContext` | Only with custom MyDataPolicy | Context for custom MyData policies |

*At least one of `text` or `files` must be provided.

**Returns:** `{ messageId: string }`

```typescript
const { messageId } = await client.messaging.sendMessage({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  text: 'Hello!',
});
```

### `getMessage(options)`

Fetch and decrypt a single message by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Authenticates with the relayer |
| `groupRef` | `GroupRef` | Yes | Target group |
| `messageId` | `string` | Yes | Message ID |

**Returns:** `DecryptedMessage`

```typescript
const msg = await client.messaging.getMessage({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  messageId: 'abc123',
});
```

### `getMessages(options)`

Fetch and decrypt a paginated list of messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Authenticates with the relayer |
| `groupRef` | `GroupRef` | Yes | Target group |
| `afterOrder` | `number` | No | Fetch messages after this order (exclusive) |
| `beforeOrder` | `number` | No | Fetch messages before this order (exclusive) |
| `limit` | `number` | No | Max messages to return |

**Returns:** `GetMessagesResult`

Messages that fail decryption (e.g., key not available) are silently skipped.

```typescript
const { messages, hasNext } = await client.messaging.getMessages({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  limit: 50,
});
```

### `editMessage(options)`

Re-encrypt and update an existing message. Only the original sender can edit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must be the original sender |
| `groupRef` | `GroupRef` | Yes | Target group |
| `messageId` | `string` | Yes | Message to edit |
| `text` | `string` | Yes | New message text |
| `attachments` | `EditAttachments` | No | Attachment changes (omit to leave unchanged) |

**Returns:** `void`

```typescript
await client.messaging.editMessage({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  messageId: 'abc123',
  text: 'Updated text',
  attachments: {
    current: originalMsg.attachments.map(a => a.wire),
    remove: ['old-storage-id'],
    new: [{ fileName: 'new.txt', mimeType: 'text/plain', data: bytes }],
  },
});
```

### `deleteMessage(options)`

Soft-delete a message. Only the original sender can delete.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must be the original sender |
| `groupRef` | `GroupRef` | Yes | Target group |
| `messageId` | `string` | Yes | Message to delete |

**Returns:** `void`

### `subscribe(options)`

Subscribe to real-time messages and reaction updates for a group. Returns an `AsyncIterable` that yields events as they arrive: message events carry a decrypted message; reaction events carry absolute state (count + reactor list) for one `(message order, emoji)` pair.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Authenticates with the relayer |
| `groupRef` | `GroupRef` | Yes | Target group |
| `afterOrder` | `number` | No | Resume message delivery from this order (exclusive) |
| `signal` | `AbortSignal` | No | Cancel the subscription |

**Returns:** `AsyncIterable<MessagingEvent>` where

```typescript
type MessagingEvent =
  | { type: 'message'; message: DecryptedMessage }
  | { type: 'reaction'; reaction: RelayerReactionEvent };
```

Messages that fail decryption are silently skipped.

```typescript
const controller = new AbortController();

for await (const event of client.messaging.subscribe({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  signal: controller.signal,
})) {
  if (event.type === 'message') {
    console.log(event.message.text, event.message.senderVerified);
  } else {
    console.log(event.reaction.emoji, event.reaction.count, event.reaction.reactors);
  }
}
```

### `disconnect()`

Disconnect the underlying transport. Active subscriptions will complete.

```typescript
client.messaging.disconnect();
```

### `recoverMessages(options)`

Recover messages from an alternative storage backend (e.g., File Storage). Requires a `RecoveryTransport` to be configured at client creation. See [Archive & Recovery](./ArchiveRecovery.md).

Unlike other messaging methods, this does not require a `signer` since recovery is read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `groupRef` | `GroupRef` | Yes | Target group |
| `afterOrder` | `number` | No | Fetch messages after this order (exclusive) |
| `beforeOrder` | `number` | No | Fetch messages before this order (exclusive) |
| `limit` | `number` | No | Max messages to return |

**Returns:** `GetMessagesResult`

Messages that fail decryption are silently dropped.

```typescript
const { messages, hasNext } = await client.messaging.recoverMessages({
  groupRef: { uuid: 'my-group' },
  limit: 50,
});
```

---

## Group Management Methods

On-chain transactions for group lifecycle. Each method signs and executes a transaction.

### `createAndShareGroup(options)`

Create a new messaging group and share both objects (PermissionedGroup and EncryptionHistory). The transaction sender becomes the creator with all permissions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Transaction sender (becomes group creator) |
| `name` | `string` | Yes | Human-readable group name |
| `uuid` | `string` | No | UUID for deterministic addressing (generated if omitted) |
| `initialMembers` | `string[]` | No | Addresses to grant `MessagingReader` on creation |

**Returns:** `{ digest: string; effects: TransactionEffects }`

```typescript
await client.messaging.createAndShareGroup({
  signer: keypair,
  name: 'My Group',
  initialMembers: ['0xAlice...', '0xBob...'],
});
```

### `rotateEncryptionKey(options)`

Rotate the DEK for a group. Generates a new MyData-encrypted DEK for the next key version. Requires `EncryptionKeyRotator` permission. See [Encryption](./Encryption.md) for key versioning details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `EncryptionKeyRotator` permission |
| `groupRef` | `GroupRef` | Yes | Target group (via uuid or explicit IDs) |

**Returns:** `{ digest: string; effects: TransactionEffects }`

### `removeMembersAndRotateKey(options)`

Atomically remove members and rotate the encryption key in a single PTB. This is the recommended way to remove members. See [Security](./Security.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have permission to remove members and rotate keys |
| `groupRef` | `GroupRef` | Yes | Target group |
| `members` | `string[]` | Yes | Addresses to remove |

**Returns:** `{ digest: string; effects: TransactionEffects }`

```typescript
await client.messaging.removeMembersAndRotateKey({
  signer: keypair,
  groupRef: { uuid: 'my-group' },
  members: ['0xAlice...'],
});
```

### `leave(options)`

Remove the transaction sender from a group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | The member leaving |
| `groupId` | `string` | Yes | PermissionedGroup object ID |

**Returns:** `{ digest: string; effects: TransactionEffects }`

**Note:** `leave()` does not rotate the encryption key. See [Security](./Security.md) for implications.

### `archiveGroup(options)`

Permanently archive a group. Pauses the group and burns the `UnpauseCap`, making it impossible to unpause. Requires `PermissionsAdmin` permission.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `PermissionsAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |

**Returns:** `{ digest: string; effects: TransactionEffects }`

---

## Metadata Methods

On-chain key-value metadata for groups. All require `MetadataAdmin` permission.

### `setGroupName(options)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `MetadataAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |
| `name` | `string` | Yes | New group name |

**Returns:** `{ digest: string; effects: TransactionEffects }`

### `insertGroupData(options)`

Insert a key-value pair into the group's on-chain metadata map.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `MetadataAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |
| `key` | `string` | Yes | Metadata key |
| `value` | `string` | Yes | Metadata value |

**Returns:** `{ digest: string; effects: TransactionEffects }`

### `removeGroupData(options)`

Remove a key-value pair from the group's metadata map.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `MetadataAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |
| `key` | `string` | Yes | Metadata key to remove |

**Returns:** `{ digest: string; effects: TransactionEffects }`

---

## Group handle registry

Register a canonical **group handle** in the on-chain `GroupHandleRegistry` (separate from profile usernames). Requires `GroupHandleAdmin` permission.

### `setGroupHandle(options)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `GroupHandleAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |
| `handle` | `string` | Yes | Canonical handle (lowercase ASCII `a-z`, `0-9`, `_`; rules match Move) |

**Returns:** `{ digest: string; effects: TransactionEffects }`

### `clearGroupHandle(options)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Signer` | Yes | Must have `GroupHandleAdmin` permission |
| `groupId` | `string` | Yes | PermissionedGroup object ID |

**Returns:** `{ digest: string; effects: TransactionEffects }`

Read-only resolution: see **View Methods** → `lookupGroupByHandle` below.

---

## Verification

### `verifyMessageSender(params)`

Verify that a message was signed by the claimed sender. Reconstructs the canonical message, rebuilds the serialized signature, and verifies against the public key.

| Parameter | Type | Description |
|-----------|------|-------------|
| `groupId` | `string` | Group ID |
| `encryptedText` | `Uint8Array` | Ciphertext |
| `nonce` | `Uint8Array` | AES-GCM nonce |
| `keyVersion` | `bigint` | Key version |
| `senderAddress` | `string` | Claimed sender |
| `signature` | `string` | Hex-encoded 64-byte raw signature |
| `publicKey` | `string` | Hex-encoded public key with scheme flag prefix |

**Returns:** `boolean`

**Note:** The SDK automatically verifies sender signatures during decryption and populates `DecryptedMessage.senderVerified`. Use this method only if you need to re-verify manually.

---

## View Methods (`client.messaging.view`)

Read-only queries that fetch on-chain state via RPC. No gas required.

### `encryptedKey(options)`

Fetch the encrypted DEK for a specific key version.

| Parameter | Type | Description |
|-----------|------|-------------|
| `encryptionHistoryId` or `uuid` | `string` | EncryptionHistory reference |
| `version` | `bigint \| number` | Key version (0-indexed) |

**Returns:** `Uint8Array`

### `currentEncryptedKey(options)`

Fetch the encrypted DEK for the latest key version. Always makes at least two RPC calls (one for current size, one for the entry).

| Parameter | Type | Description |
|-----------|------|-------------|
| `encryptionHistoryId` or `uuid` | `string` | EncryptionHistory reference |

**Returns:** `Uint8Array`

### `getCurrentKeyVersion(options)`

Return the current (latest) key version number.

| Parameter | Type | Description |
|-----------|------|-------------|
| `encryptionHistoryId` or `uuid` | `string` | EncryptionHistory reference |

**Returns:** `bigint`

### `groupsMetadata(options)`

Return multiple groups' on-chain metadata (name, uuid, creator, data map). Results are cached; pass `refresh: true` to bypass.

| Parameter | Type | Description |
|-----------|------|-------------|
| `groupIds` | `string[]` | PermissionedGroup object IDs |
| `refresh` | `boolean` | Bypass cache (optional) |

**Returns:** `Record<string, ParsedMetadata>` where each key is a group ID and value is `{ name: string; uuid: string; creator: string; data: Map<string, string> }`

### `lookupGroupByHandle(options)`

Resolve a registered handle to the `PermissionedGroup<Messaging>` object ID via dev-inspect (`myso_devInspectTransactionBlock`). No gas; requires a JSON-RPC MySo client (not GraphQL-only).

| Parameter | Type | Description |
|-----------|------|-------------|
| `handle` | `string` | Candidate handle |
| `groupHandleRegistryId` | `string` | Optional; defaults to `derive.groupHandleRegistryId()` |
| `signal` | `AbortSignal` | Optional |

**Returns:** `string | null` — group object ID, or `null` if unregistered / invalid per Move rules.

---

## Derive Methods (`client.messaging.derive`)

Pure, synchronous address derivation. No network calls.

### `groupId({ uuid })`

Derive the `PermissionedGroup<Messaging>` object ID from a UUID.

**Returns:** `string`

### `encryptionHistoryId({ uuid })`

Derive the `EncryptionHistory` object ID from a UUID.

**Returns:** `string`

### `resolveGroupRef(ref)`

Resolve a `GroupRef` to explicit `{ groupId, encryptionHistoryId }`. When a UUID is provided, both IDs are derived. When explicit IDs are provided, they pass through.

**Returns:** `{ groupId: string; encryptionHistoryId: string }`

### `groupLeaverId()`

Derive the `GroupLeaver` singleton object ID. Used internally by `leave()`.

**Returns:** `string`

### `groupManagerId()`

Derive the `GroupManager` singleton object ID. Used internally by metadata methods.

**Returns:** `string`

### `groupHandleRegistryId()`

Derive the `GroupHandleRegistry` singleton object ID from `MessagingNamespace`. Used internally by `setGroupHandle` / `clearGroupHandle`.

**Returns:** `string`

### `systemObjectAddresses()`

Return the addresses of system-level actor objects (GroupLeaver, GroupManager) that are automatically added to every group. Useful for filtering system entries from member lists in UI:

**Returns:** `Set<string>`

```typescript
const system = client.messaging.derive.systemObjectAddresses();
const humanMembers = allMembers.filter(m => !system.has(m.address));
```

---

## Transaction Builders (`tx.*`)

Return `Transaction` objects ready for signing. Same parameters as imperative methods (minus `signer`). Use these when you need to inspect or modify the transaction before signing (e.g., with dapp-kit's `signAndExecuteTransaction`).

```typescript
const tx = client.messaging.tx.createAndShareGroup({
  name: 'My Group',
  initialMembers: ['0xAlice...'],
});

const result = await keypair.signAndExecuteTransaction({ transaction: tx, client });
```

Available: `createAndShareGroup`, `rotateEncryptionKey`, `removeMembersAndRotateKey`, `archiveGroup`, `leave`, `setGroupName`, `insertGroupData`, `removeGroupData`, `setGroupHandle`, `clearGroupHandle`.

---

## Call Builders (`call.*`)

Return [transaction thunks](https://docs.mysocial.network/myso/sdk-building#transaction-thunks) for composing multiple operations into a single PTB via `tx.add()`.

```typescript
import { Transaction } from '@socialproof/myso/transactions';

const tx = new Transaction();
tx.add(client.messaging.call.createAndShareGroup({ name: 'My Group' }));
tx.add(client.groups.call.grantPermission({ groupId, member, permissionType }));
await keypair.signAndExecuteTransaction({ transaction: tx, client });
```

Available: same as `tx.*`, plus `createGroup` (returns unshared objects for manual composition with `shareGroup`), and `shareGroup` (shares the objects returned by `createGroup`).

---

## BCS Parsing (`bcs.*`)

BCS type definitions for parsing on-chain data and constructing event type strings for GraphQL queries.

**Messaging types:**
- `bcs.Messaging` -- the `Messaging` witness type
- `bcs.MessagingNamespace` -- the shared namespace object
- `bcs.EncryptionHistory` -- encryption key history
- `bcs.EncryptionHistoryCreated`, `bcs.EncryptionKeyRotated` -- encryption events
- `bcs.EncryptionHistoryTag`, `bcs.PermissionedGroupTag` -- derivation key types
- `bcs.Metadata`, `bcs.MetadataKey` -- group metadata
- `bcs.GroupManager`, `bcs.GroupLeaver` -- system actor objects

**Permission types:**
- `bcs.MessagingSender`, `bcs.MessagingReader`, `bcs.MessagingEditor`, `bcs.MessagingDeleter`
- `bcs.EncryptionKeyRotator`, `bcs.GroupHandleAdmin`, `bcs.MetadataAdmin`

Each BCS type exposes a `.name` property with the fully-qualified Move type name, useful for GraphQL event queries and permission checks.

---

## Encryption (`encryption.*`)

Low-level encryption module. Most developers will not need this directly since `sendMessage`, `getMessages`, and `subscribe` handle encryption automatically. See [Encryption](./Encryption.md) for the full encryption model.

- `encrypt(options)` -- encrypt data with a group's DEK
- `decrypt(options)` -- decrypt data with a group's DEK
- `generateGroupDEK(uuid?)` -- generate a new MyData-encrypted DEK for group creation
- `generateRotationDEK(options)` -- generate a new MyData-encrypted DEK for key rotation
- `clearCache(groupId?)` -- clear cached DEKs (all or per-group)

---

## Transport (`transport`)

Direct access to the underlying `RelayerTransport` instance. Useful for low-level operations or debugging:

```typescript
// Direct relayer access (bypasses encryption)
const raw = await client.messaging.transport.fetchMessages({ ... });
```

See [Relayer](./Relayer.md) for the `RelayerTransport` interface definition.

---

## Permission Types

The messaging package defines these permission types, accessible via `messagingPermissionTypes(packageId)`:

| Permission | Purpose |
|-----------|---------|
| `MessagingSender` | Send messages |
| `MessagingReader` | Decrypt messages (controls DEK access via MyData) |
| `MessagingEditor` | Edit own messages |
| `MessagingDeleter` | Delete own messages |
| `EncryptionKeyRotator` | Rotate the group's DEK |
| `GroupHandleAdmin` | Register or clear the group handle in `GroupHandleRegistry` |
| `MetadataAdmin` | Manage group metadata |

Use `defaultMemberPermissionTypes(packageId)` for the four core messaging permissions (Sender, Reader, Editor, Deleter), the baseline for regular group members.

Grant permissions via the groups extension:

```typescript
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';

const perms = messagingPermissionTypes(MESSAGING_PACKAGE_ID);

await client.groups.grantPermission({
  signer: keypair,
  groupId: '0x...',
  member: '0xAlice...',
  permissionType: perms.EncryptionKeyRotator,
});
```
