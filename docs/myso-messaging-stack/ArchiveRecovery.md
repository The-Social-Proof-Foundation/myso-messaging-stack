# Archive & Recovery

## Table of Contents

- [Backend Switch (R2 vs File Storage)](#backend-switch-r2-vs-file-storage)
- [How Archival Works](#how-archival-works)
  - [Batching](#batching)
  - [Tagging](#tagging)
  - [Sync Status Lifecycle](#sync-status-lifecycle)
- [How Discovery Works](#how-discovery-works)
- [How Recovery Works](#how-recovery-works)
  - [Relayer Archive Recovery Transport](#relayer-archive-recovery-transport)
  - [Reference Implementation (File Storage)](#reference-implementation)
  - [Wiring It Up](#wiring-it-up)
- [Production checklist](#production-checklist)
- [Current Limitations](#current-limitations)

**Documentation:** [Home](./README.md) | [Installation](./Installation.md) | [Setup](./Setup.md) | [API Reference](./APIRef.md) | [Examples](./Examples.md) | [Encryption](./Encryption.md) | [Security](./Security.md) | [Relayer](./Relayer.md) | [Attachments](./Attachments.md) | [Group Discovery](./GroupDiscovery.md) | [Extending](./Extending.md) | [Testing](./Testing.md)

---

Messages in the Messaging SDK flow through an off-chain relayer for real-time delivery. For durability and optional portable history, the relayer archives encrypted messages to a single pluggable backend. Live chat stays on the platform relayer; archive is restore-only.

## Backend Switch (R2 vs File Storage)

The relayer runs **one** archive backend at a time (`ARCHIVE_BACKEND`):

| `ARCHIVE_BACKEND` | Archive store | Client recovery transport |
|-------------------|---------------|---------------------------|
| `r2` (alias `cloudflare`) | Cloudflare R2 + Postgres `archive_messages` (in-process on the relayer) | `RelayerArchiveRecoveryTransport` |
| `file_storage` | File Storage quilts + [discovery indexer](../../file-storage-discovery-indexer/) | `FileStorageRecoveryTransport` (example) |

```
ARCHIVE_BACKEND=r2|file_storage
ARCHIVE_NAMESPACE=mysocial
R2_BUCKET=myso-message-archive
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
# FILE_STORAGE_* knobs used when ARCHIVE_BACKEND=file_storage
```

`ARCHIVE_NAMESPACE` scopes R2 keys / tags so platforms sharing one archive do not bleed history unless a client deliberately uses that namespace.

## How Archival Works

The relayer's `ArchiveSyncService` runs in the background and periodically uploads pending messages to the active archive backend. Sync is triggered by either:
- A **timer** (default: every hour, configurable via `FILE_STORAGE_SYNC_INTERVAL_SECS`)
- A **message count threshold** (default: 50 new messages, configurable via `FILE_STORAGE_SYNC_MESSAGE_THRESHOLD`)

Whichever fires first triggers a sync cycle.

### Batching

**File Storage:** messages are grouped into File Storage **quilts**. Each message becomes a patch named `msg-{messageId}`. Batch size is configurable via `FILE_STORAGE_SYNC_BATCH_SIZE` (default: 100, hard-capped at 666).

**R2:** each message is stored as its own object `{namespace}/groups/{group_id}/msg-{messageId}.json` and indexed in Postgres `archive_messages`.

### Tagging

Each archived item carries metadata:

| Tag | Value | Purpose |
|-----|-------|---------|
| `source` | `"myso-messaging-relayer"` | Identifies patches from the messaging relayer |
| `group_id` | Group object ID | Allows filtering by group |
| `sender` | Sender's MySo address | Allows filtering by sender |
| `order` | Message order number | Preserves ordering |
| `sync_status` | Status string | Indicates message state |
| `namespace` | Platform id (when `ARCHIVE_NAMESPACE` set) | Multi-platform isolation |

These tags are readable from the File Storage quilt index without downloading patch content. For R2, the same fields are stored on the Postgres index row + object metadata.

### Sync Status Lifecycle

Every message tracks its archival state:

```
New message   --> SYNC_PENDING   --> SYNCED
Edited        --> UPDATE_PENDING --> UPDATED
Deleted       --> DELETE_PENDING --> DELETED
```

Edited messages are re-uploaded. Deleted messages are uploaded as tombstone records so that recovering clients know the message was intentionally removed.

## How Discovery Works

The **file-storage-discovery-indexer** (File Storage path only) watches MySo checkpoints for `BlobCertified` events, inspects messaging patches (`source: "myso-messaging-relayer"`), and serves a REST API for patch discovery.

R2 recovery does **not** use this indexer — clients call the relayer archive API directly.

## How Recovery Works

The SDK provides a `RecoveryTransport` interface for fetching messages from an alternative backend:

```typescript
interface RecoveryTransport {
  recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult>;
}
```

When configured, the client exposes a `recoverMessages()` method. Recovered messages go through the same decryption and sender verification pipeline as real-time messages. Messages that fail decryption are silently dropped.

### Relayer Archive Recovery Transport

```typescript
import {
  createMySoMessagingStackClientAsync,
  RelayerArchiveRecoveryTransport,
} from '@socialproof/myso-messaging-stack';

const client = await createMySoMessagingStackClientAsync(baseClient, {
  // …
  recovery: new RelayerArchiveRecoveryTransport({
    relayerUrl: 'https://your-relayer.example.com',
    namespace: 'mysocial',
    signer: keypair,
  }),
});
```

Calls `GET /v1/archive/groups/:groupId/messages` with wallet auth headers and maps JSON via `fromFileStorageMessage`.

### Reference Implementation

A reference `FileStorageRecoveryTransport` is provided in [examples/recovery-transport/](../../ts-sdks/packages/myso-messaging-stack/examples/recovery-transport/). It:

1. Queries the Discovery Indexer for patches belonging to the group
2. Fetches patch content from the File Storage aggregator
3. Converts the File Storage wire format to SDK `RelayerMessage` objects
4. Returns them sorted by order for the SDK to decrypt and verify

### Wiring It Up

```typescript
const client = createMySoMessagingStackClient(baseClient, {
  encryption: { sessionKey: { signer: keypair } },
  relayer: { relayerUrl: 'https://your-relayer.example.com' },
  recovery: myRecoveryTransport,
});

const messages = await client.messaging.getMessages({ ... });
const recovered = await client.messaging.recoverMessages({ ... });
```

## Production checklist

1. Create R2 bucket + API token (Object Read & Write); set relayer `ARCHIVE_BACKEND=r2` + `R2_*` + `ARCHIVE_NAMESPACE`; Postgres on.
2. Migration `010_archive_messages` applies on relayer connect; restart; optionally lower sync threshold for smoke.
3. Send a message → row in `archive_messages` + R2 object → `quilt_patch_id` / archive_ref set.
4. Enable chat-app `VITE_ENABLE_MESSAGE_RECOVERY=true` (uses `VITE_RELAYER_URL`) → empty-thread restore / **Restore** works.
5. Flip `ARCHIVE_BACKEND=file_storage` → R2 path idle; File Storage sync still works.
6. Wrong `namespace` query returns empty (same deploy).

## Current Limitations

**In-memory storage on the relayer.** The default relayer storage backend holds everything in memory. For production use Postgres. R2 archive index also prefers `DATABASE_URL` (falls back to in-memory index for local smoke only).

**In-memory storage on the File Storage indexer.** On restart, it re-processes checkpoints but may miss blobs from before its start. Implement a persistent `DiscoveryStore` for production File Storage recovery.

**Recovery ordering is best-effort across multiple writers.** Within one relayer, `order` is monotonic per group.

**Sender verification on recovery.** Applications should check `senderVerified` on recovered messages.

---

[Back to table of contents](#table-of-contents)
