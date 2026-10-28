# @socialproof/myso-messaging-stack

> [!NOTE] The MySocial Messaging Stack tooling is currently in Beta.
>
> The tooling is production-capable for many use cases, but developers should evaluate their own
> security, reliability, and operational requirements before deploying to production. .

TypeScript SDK for encrypted group messaging on MySocial, powered by
[MyData](https://github.com/the-social-proof-foundation/myso-mydata) for end-to-end encryption.

## Installation

```bash
npm install @socialproof/myso-messaging-stack
```

## Architecture

The SDK is **transport-agnostic**. It handles encryption, decryption, key management, and on-chain
group operations — but delegates message delivery and storage to a pluggable `RelayerTransport`
interface. You can implement this interface to connect to any backend (HTTP server, WebSocket,
peer-to-peer, etc.).

We provide two **reference implementations**:

- **`HTTPRelayerTransport`** — Built-in transport that works with the
  [reference relayer](../../relayer/). Ships with the SDK.
- **`FileStorageRecoveryTransport`** (example) — Read-only recovery adapter that fetches messages
  from File Storage storage via the [Discovery Indexer](../../file-storage-discovery-indexer/).
  Implements `RecoveryTransport`. Not part of the SDK — see
  [`examples/recovery-transport/`](./examples/recovery-transport/) for a reference implementation.

Neither is required — you can build your own transport from scratch.

## Quick Start

### With the reference relayer (built-in HTTP transport)

The SDK uses MySo's client extension pattern. Chain `$extend()` to compose `mysoGroups`, a MyData
extension, and `mysoMessagingStack`:

```ts
import { MySoGrpcClient } from '@socialproof/myso/grpc';
import { mysoGroups } from '@socialproof/myso-groups';
import { mysoMessagingStack } from '@socialproof/myso-messaging-stack';

const client = new MySoGrpcClient({ network: 'testnet' })
	.$extend(
		mysoGroups({ witnessType: `${pkg}::messaging::Messaging` }),
		mydata({ mydataKeyServers }), // from @socialproof/mydata
	)
	.$extend(
		mysoMessagingStack({
			encryption: { sessionKey: { ttlMin: 10, signer: keypair } },
			relayer: { relayerUrl: 'https://relayer.example.com' },
		}),
	);

// Send a message
await client.messaging.sendMessage({
	signer: keypair,
	groupRef: { uuid: 'my-group' },
	text: 'Hello, group!',
});

// Fetch and decrypt messages
const { messages } = await client.messaging.getMessages({
	signer: keypair,
	groupRef: { uuid: 'my-group' },
});
```

### With a custom transport

```ts
import { mysoMessagingStack } from '@socialproof/myso-messaging-stack';
import type { RelayerTransport } from '@socialproof/myso-messaging-stack';

class MyTransport implements RelayerTransport {
	// Implement sendMessage, fetchMessages, subscribe, etc.
	// Connect to whatever backend you want.
}

// Use { transport: ... } instead of { relayerUrl: ... }
const client = baseClient.$extend(
	mysoMessagingStack({
		encryption: { sessionKey: { ttlMin: 10, signer: keypair } },
		relayer: { transport: new MyTransport() },
	}),
);
```

## Recovery from File Storage

If your message backend persists messages to
[File Storage](https://docs.mysocial.network/mysocial/file-storage/overview) (as the reference
relayer does), the SDK provides utilities to read them back directly — useful when the backend is
unavailable and you need to restore conversation history.

### SDK Utilities

- **`fromFileStorageMessage(wire)`** — Converts a raw File Storage message (the `serde_json` wire
  format used by the reference relayer) to the SDK's `RelayerMessage` format. Handles `number[]` to
  `Uint8Array`, ISO 8601 to unix timestamps, field name mapping, and deriving
  `isEdited`/`isDeleted`.

- **`FileStorageMessageWire`** — TypeScript type for the raw JSON shape stored on File Storage.

```ts
import { fromFileStorageMessage } from '@socialproof/myso-messaging-stack';
import type { FileStorageMessageWire, RelayerMessage } from '@socialproof/myso-messaging-stack';

// Read a message blob/patch from File Storage (via aggregator, SDK, etc.)
const rawJson = await fetchFromFileStorage(blobId, patchId);
const wire: FileStorageMessageWire = JSON.parse(rawJson);

// Convert to the SDK's standard format — ready for decryption
const message: RelayerMessage = fromFileStorageMessage(wire);
```

### Building a Recovery Transport

To restore full conversation history from File Storage, implement `RecoveryTransport` (1 method:
`recoverMessages`) that:

1. Queries an indexer for which File Storage blobs contain a group's messages
2. Downloads message content from the File Storage aggregator
3. Converts each message using `fromFileStorageMessage()`
4. Returns them sorted by order

See [`examples/recovery-transport/`](./examples/recovery-transport/) for a complete reference
implementation using the [Discovery Indexer](../../file-storage-discovery-indexer/).

## API Reference

### Client Methods

| Method                  | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| `sendMessage()`         | Encrypt and send a message to a group                                           |
| `getMessages()`         | Fetch and decrypt messages for a group                                          |
| `getMessage()`          | Fetch and decrypt a single message                                              |
| `editMessage()`         | Re-encrypt and update an existing message                                       |
| `deleteMessage()`       | Soft-delete a message                                                           |
| `subscribe()`           | Group stream: decrypted messages, reactions, typing, presence                   |
| `subscribeUserEvents()` | Wallet stream: group activity, cross-device read state, group discovery         |
| `listReactions()`       | List reaction tallies (count + reactors) keyed by message `order`               |
| `addReaction()`         | Add the signer's emoji reaction to a message (idempotent)                       |
| `removeReaction()`      | Remove the signer's emoji reaction from a message (idempotent)                  |
| `getReadState()`        | Fetch and decrypt the wallet-scoped read-state blob                             |
| `updateReadState()`     | Advance a read watermark (CAS-protected; merges + retries on conflict)          |
| `getUnreadCounts()`     | Exact unread counts for many groups — one batch request                         |
| `sendTyping()`          | Broadcast the signer's typing start/stop (ephemeral, fire-and-forget)           |
| `getGroupPresence()`    | Presence snapshot for a group's members (live updates arrive via `subscribe()`) |

Reactions use canonical Unicode emoji strings (`👍`, `❤️`, `👨‍👩‍👧‍👦`, ...). Use the exported
`emojiToStorage()` helper to NFC-normalize input before comparing against stored entries.

Read-state synchronization is handled by the exported `MessagingSyncManager` (cache +
compare-and-set retries + cross-device invalidation via `read_state.updated` user-feed events);
`ReadStateManager` remains as a deprecated alias.

### Transport Interface (`RelayerTransport`)

| Method                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `sendMessage()`         | Send an encrypted message to the backend                                              |
| `fetchMessages()`       | Fetch paginated messages for a group                                                  |
| `fetchMessage()`        | Fetch a single message by ID                                                          |
| `updateMessage()`       | Update message content                                                                |
| `deleteMessage()`       | Soft-delete a message                                                                 |
| `subscribe()`           | Stream group events (messages, reactions, typing, presence)                           |
| `subscribeUserEvents()` | Stream the wallet-scoped user feed (`/v1/users/ws`)                                   |
| `fetchUnreadCounts()`   | Batch exact unread counts (`POST /v1/users/unread-counts`)                            |
| `listGroupReactions()`  | List per-message reaction entries                                                     |
| `postGroupReaction()`   | Add/remove the signer's reaction (idempotent)                                         |
| `sendTyping()`          | Broadcast an ephemeral typing start/stop                                              |
| `getGroupPresence()`    | Presence snapshot for a group's members                                               |
| `putUserReadState()`    | CAS write — throws `ReadStateConflictError` with the current blob on version mismatch |
| `disconnect()`          | Clean up transport resources                                                          |

### Recovery Exports

| Export                      | Description                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `RecoveryTransport`         | Read-only interface for recovery adapters (1 method: `recoverMessages`) |
| `fromFileStorageMessage()`  | Convert File Storage wire format to `RelayerMessage`                    |
| `FileStorageMessageWire`    | Type for the raw File Storage JSON shape                                |
| `FileStorageAttachmentWire` | Type for the raw File Storage attachment shape                          |

## License

Apache-2.0

## Shared room anchors and evidence

The SDK now exports the chat app's versioned `myso-chat://` / `myso-chat+v2://` anchor format, content/deduplication hashes and room-evidence matching. `matchDigestsToMessages(anchors, messages, { groupUuid })` requires the selected room UUID independently of the untrusted pointer. Explicit pointers to another room or an unloaded message never fall back to sender/time matching. Legacy anchors without a chat pointer can still be correlated by sender/time.

Pass chain sequence numbers as decimal strings when they exceed JavaScript's safe integer range. The matcher orders u64 sequences with `BigInt` and rejects already-rounded numbers or repeated sequences. `summarizeVerification` counts a row as verified only when both its signature and plaintext hash check succeed; unavailable plaintext is `unchecked`. Empty/whitespace plaintext is hashed exactly as stored.

Callers must obtain anchors through a trusted, room-scoped chain/indexer path and messages through the SDK's membership-controlled decrypt path. These helpers do not establish finality, organization authority or truth of message claims. They provide no encrypted room API or private-knowledge entitlement on their own.

The repository chat app consumes this SDK through its local package link. Build the SDK before compiling/running the chat app. No application or test run was performed as part of this extraction.


## Strict room history for coordination

`messaging.getRoomMessages({ signer, groupRef, afterOrder?, beforeOrder?, limit? })`
and the agent wrapper's `getRoomMessages` use the existing relayer and MyData
crypto client. They return one entry for each raw timeline row. Only
`verified_content` includes decrypted text; `unverified_content`,
`unavailable_content`, `system_metadata` and `deleted_metadata` contain the row
identity/status without text. Missing keys or invalid signatures therefore cannot
silently shorten the visible history. Invalid signatures never request decryption.

This reader checks the signer's normal on-chain `MessagingReader` permission
before and after processing, clears group DEKs when permission is denied, and
releases no page if the second check fails. Principal oversight without a normal
reader grant needs its separate native policy adapter. Hosted consumers must also
bind the signer, account, agent, network and deployment, check live delegation
capabilities, and handle session expiry/revocation; this SDK method does not
implement those service adapters or automatically erase previously disclosed text.

Pages contain at most 50 rows, 1 MiB ciphertext per row and 4 MiB ciphertext total,
with at most four decryption requests in flight. Cursors use raw rows including
failures, preserve finite forward-window bounds, and reject wrong rooms, duplicate
IDs, non-advancing pages and numbers outside JavaScript's safe integer range.
The existing relayer returns a newest window when no `afterOrder` is supplied;
continuations then use `beforeOrder`. Forward windows continue with `afterOrder`.
No ordering claim depends on an unverified row being decryptable.

`metadataSource: 'relayer_unverified'` explicitly covers message IDs, orders,
system/deletion state and pagination. Sender signatures bind the encrypted body,
group, kind and sender. They do not establish historical membership, the relayer's
agent/principal attribution, organization roles, task truth, transfer settlement,
attachments, complete history or chain finality. This reader omits unsigned
attribution, payment-state claims and attachment handles. `allContentVerified`
only describes a nonempty returned page; it is never a completeness proof. A
legacy post whose canonical signed post/idempotency fields are unavailable from
the relayer remains unverified rather than gaining a false verified status.

MySo Agents/MCP room-session adapters and UI are still being integrated. The
coordinator has not been given a plaintext room-history tool by this SDK change.
Source and regression code were compiled only; no messages, keys, membership
requests, applications or tests were executed during implementation.


For acting agents, configure `encryption.mydataPolicy` with the exported
`AgentMyDataReaderPolicy`. Its constructor pins the original/latest messaging
package, version, platform, memory config/account and exact derived agent
address. It builds the existing native `mydata_approve_agent_reader` ABI, which
checks CAP_MESSAGE_READ, actor ancestry/expiry, platform and group permission.
The envelope layer checks this policy's session address and encryption package
even on a DEK cache hit. Another agent or another package cannot satisfy that
identity hook. There is no fallback from this policy to owner oversight or the
generic reader gate.

This is explicit configuration, not an automatic change to existing messaging
clients. A long-lived MyData/DEK cache can still retain previously granted keys.
Use a fresh caller-bound client and current service authorization for private
room requests, and finish the logout/revocation/in-flight invalidation lifecycle
before claiming immediate access revocation. The native policy alone cannot
revoke already disclosed keys or plaintext.
