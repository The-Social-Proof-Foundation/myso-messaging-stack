# @socialproof/myso-messaging-stack

> [!NOTE]
> The MySocial Messaging Stack tooling is currently in Beta and available on both Testnet and Mainnet.
>
> The tooling is production-capable for many use cases, but developers should evaluate their own security, reliability, and operational requirements before deploying to production.
>
> For questions, feedback, or production discussions, reach out to the team on [MySo Discord](https://discord.com/channels/916379725201563759/1417696942074630194).

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
- **`FileStorageRecoveryTransport`** (example) — Read-only recovery adapter that fetches messages from
  File Storage storage via the [Discovery Indexer](../../file-storage-discovery-indexer/). Implements
  `RecoveryTransport`. Not part of the SDK — see
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

If your message backend persists messages to [File Storage](https://docs.mysocial.network/mysocial/file-storage/overview) (as the reference
relayer does), the SDK provides utilities to read them back directly — useful when the backend is
unavailable and you need to restore conversation history.

### SDK Utilities

- **`fromFileStorageMessage(wire)`** — Converts a raw File Storage message (the `serde_json` wire format used
  by the reference relayer) to the SDK's `RelayerMessage` format. Handles `number[]` to
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

| Method            | Description                                 |
| ----------------- | ------------------------------------------- |
| `sendMessage()`   | Encrypt and send a message to a group       |
| `getMessages()`   | Fetch and decrypt messages for a group      |
| `getMessage()`    | Fetch and decrypt a single message          |
| `editMessage()`   | Re-encrypt and update an existing message   |
| `deleteMessage()` | Soft-delete a message                       |
| `subscribe()`     | Subscribe to real-time messages (decrypted) |

### Transport Interface (`RelayerTransport`)

| Method            | Description                              |
| ----------------- | ---------------------------------------- |
| `sendMessage()`   | Send an encrypted message to the backend |
| `fetchMessages()` | Fetch paginated messages for a group     |
| `fetchMessage()`  | Fetch a single message by ID             |
| `updateMessage()` | Update message content                   |
| `deleteMessage()` | Soft-delete a message                    |
| `subscribe()`     | Stream real-time messages                |
| `disconnect()`    | Clean up transport resources             |

### Recovery Exports

| Export                 | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `RecoveryTransport`    | Read-only interface for recovery adapters (1 method: `recoverMessages`) |
| `fromFileStorageMessage()`  | Convert File Storage wire format to `RelayerMessage`                          |
| `FileStorageMessageWire`    | Type for the raw File Storage JSON shape                                      |
| `FileStorageAttachmentWire` | Type for the raw File Storage attachment shape                                |

## License

Apache-2.0
