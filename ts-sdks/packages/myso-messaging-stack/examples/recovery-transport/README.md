# Recovery Transport — Reference Implementation

This is a **reference implementation** of a read-only recovery transport that uses the
[Discovery Indexer](../../../../file-storage-discovery-indexer/) and the File Storage aggregator to recover
messages when the message backend is unavailable.

## How It Works

The reference relayer persists every message to File Storage as quilt patches (batched blobs). When the
backend is unavailable, this transport recovers messages by:

1. **Querying the Discovery Indexer** for patch metadata (which blobs contain a group's messages)
2. **Filtering out DELETED patches** (no need to download deleted content)
3. **Grouping patches by blobId** for efficient batch reads from File Storage
4. **Downloading content from the File Storage aggregator** via the quilt patch API
5. **Converting** each message using the SDK's `fromFileStorageMessage()` utility

## Usage

```ts
import { FileStorageRecoveryTransport } from './file-storage-recovery-transport.js';

const recovery = new FileStorageRecoveryTransport({
	indexerUrl: 'http://localhost:3001',
	aggregatorUrl: 'https://aggregator.storage.testnet.mysocial.network',
});

const { messages, hasNext } = await recovery.recoverMessages({
	groupId: '0x...',
	limit: 50,
});
```

## Building Your Own Recovery Transport

The SDK provides everything you need to build a custom recovery transport with your own indexer.

### What the SDK exports

| Export                                                           | Purpose                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `RecoveryTransport`                                              | Interface your transport must implement (1 method: `recoverMessages`) |
| `fromFileStorageMessage()`                                            | Converts File Storage wire format → `RelayerMessage`                        |
| `FileStorageMessageWire`                                              | Type for the raw File Storage JSON shape                                    |
| `FileStorageAttachmentWire`                                           | Type for the raw File Storage attachment shape                              |
| `RecoverMessagesParams`, `FetchMessagesResult`, `RelayerMessage` | Shared param/result types                                             |
| `HttpClientConfig`                                               | Base config type (timeout, fetch override, onError)                   |
| `DEFAULT_HTTP_TIMEOUT`                                           | Standard timeout (30s)                                                |
| `HttpTimeoutError`                                               | Timeout error class                                                   |

### 1. Implement `RecoveryTransport`

```ts
import {
	fromFileStorageMessage,
	type RecoveryTransport,
	type RecoverMessagesParams,
	type FetchMessagesResult,
	type FileStorageMessageWire,
} from '@socialproof/myso-messaging-stack';

class MyRecoveryTransport implements RecoveryTransport {
	async recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult> {
		// 1. Query YOUR indexer for message locations
		// 2. Download content from File Storage
		// 3. Convert using fromFileStorageMessage()
		// 4. Return sorted by order
	}
}
```

### 2. Use `fromFileStorageMessage()` to convert File Storage blobs

The reference relayer stores messages on File Storage as raw JSON (via `serde_json::to_vec()`). The SDK
exports a converter that handles the format differences:

```ts
import { fromFileStorageMessage } from '@socialproof/myso-messaging-stack';
import type { FileStorageMessageWire, RelayerMessage } from '@socialproof/myso-messaging-stack';

const rawJson = await readFromFileStorage(blobId, patchId);
const wire: FileStorageMessageWire = JSON.parse(rawJson);
const message: RelayerMessage = fromFileStorageMessage(wire);
```

`fromFileStorageMessage()` handles:

- `number[]` -> `Uint8Array` for encrypted_msg/nonce
- ISO 8601 -> unix seconds for timestamps
- Deriving `isEdited` / `isDeleted` from timestamps and sync_status
- Field name mapping (Rust naming -> SDK naming)

## Limitations

- **Read-only** — `RecoveryTransport` only supports `recoverMessages`
