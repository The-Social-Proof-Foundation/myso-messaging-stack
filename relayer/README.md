# messaging-sdk-relayer

Privacy-preserving message relay service for the MySocial Messaging Stack SDK. The relayer acts as an off-chain indexer that receives encrypted messages from clients, verifies their identity using cryptographic signatures, checks on-chain group permissions, stores messages locally, and archives them to File Storage for decentralized backup.

## How It Works

The relayer operates as a stateless relay — it does not decrypt messages or manage keys. Clients encrypt messages client-side using MYDATA encryption before sending them to the relayer. The relayer's job is to:

1. **Authenticate** every request by verifying a cryptographic signature against the sender's MySo wallet address.
2. **Authorize** the action by checking that the sender holds the required permission (e.g., `MessagingSender` for POST) in the target group, as recorded on-chain by the Groups SDK smart contract.
3. **Store** the encrypted message in the local storage backend (in-memory by default).
4. **Archive** messages to File Storage in the background, batching them into quilts for efficient decentralized storage.
5. **Stay in sync** with the MySo blockchain via a gRPC subscription that listens for group membership events (member added/removed, permissions granted/revoked) and updates a local permission cache in real time.

The relayer is an indexer — it only reflects what is on-chain. It never makes on-chain transactions itself.

## Features

- **HTTP CRUD API** for encrypted messages (POST, GET, PUT, DELETE)
- **Multi-scheme signature verification** (Ed25519, Secp256k1, Secp256r1)
- **Nonce-based replay protection** — POST requests are deduplicated by checking the AES-GCM nonce against existing messages in storage
- **Permission-based access control** via Groups SDK on-chain events
- **Membership sync** via gRPC subscription to MySo blockchain checkpoints
- **File Storage archival** with background sync worker for decentralized backup storage
- **Pluggable storage** via the `StorageAdapter` trait (in-memory default, PostgreSQL for production)
- **Ownership enforcement** — only the original sender can edit or delete their message
- **DM block enforcement** — optional `SOCIAL_SERVER_URL` + `BlockCheckService` returns `403` code `BLOCKED` for 1:1 DMs
- **Encrypted read-state** — opaque `GET/PUT /v1/users/read-state` per wallet (see `docs/myso-messaging-stack/ReadState.md`)
- **Optional push** — `POST /v1/devices/push-tokens`, `POST /v1/devices/presence`, env-gated APNs delivery on new messages (see `docs/myso-messaging-stack/ClientSide-iOS.md`)
- **WebSocket realtime** — `GET /v1/ws` pushes full encrypted `MessageResponse` JSON; Postgres `LISTEN/NOTIFY` coordinates cross-instance delivery (metadata only on NOTIFY)

**Deprecated:** plaintext `GET/POST /v1/groups/:id/receipts` — use encrypted read-state instead.

---

## Authentication

Every request to a message endpoint must be authenticated. The relayer supports three MySo signature schemes:

| Scheme | Flag Byte | Public Key Size | Typical Use |
|--------|-----------|-----------------|-------------|
| **Ed25519** | `0x00` | 32 bytes | Default MySo wallets, most common |
| **Secp256k1** | `0x01` | 33 bytes (compressed) | Bitcoin/Ethereum-compatible wallets |
| **Secp256r1** | `0x02` | 33 bytes (compressed) | WebAuthn/passkeys, mobile devices |

### How Request Signing Works

The client must sign a message with their private key and include the signature and public key as HTTP headers on every request.

**For requests with a body (POST, PUT):** The JSON body itself contains `group_id`, `sender_address`, and `timestamp` fields. The signed message is the raw JSON body bytes — the entire request body is what gets signed.

**For bodyless requests (GET, DELETE):** Since there is no body, the auth fields come from headers (`X-Sender-Address`, `X-Timestamp`, `X-Group-Id`). The signed message is a canonical string built from these values: `"timestamp:sender_address:group_id"`.

### Required Headers

All authenticated requests must include:

| Header | Description |
|--------|-------------|
| `X-Signature` | Hex-encoded 64-byte raw signature |
| `X-Public-Key` | Hex-encoded bytes: `flag_byte \|\| public_key_bytes` (first byte identifies the scheme) |

Bodyless requests (GET, DELETE) also require:

| Header | Description |
|--------|-------------|
| `X-Sender-Address` | Sender's MySo wallet address (e.g., `0xabc...`) |
| `X-Timestamp` | Unix timestamp in seconds |
| `X-Group-Id` | Target group ID |

### Verification Pipeline

When a request arrives, the auth middleware runs the following steps in order. If any step fails, the request is rejected immediately:

1. **Validate timestamp** — The timestamp (from body or header) must be within the configured TTL window (default 5 minutes). This prevents replay attacks where an attacker resubmits a previously captured request.

2. **Decode public key** — The `X-Public-Key` header is hex-decoded. The first byte is the scheme flag (`0x00` = Ed25519, `0x01` = Secp256k1, `0x02` = Secp256r1). The remaining bytes are the raw public key. If the flag is unrecognized or the key length doesn't match the scheme, the request is rejected.

3. **Decode signature** — The `X-Signature` header is hex-decoded into 64 raw signature bytes.

4. **Verify signature** — The signature is verified against the signed message using the public key and the detected scheme. This uses `myso_crypto`'s `UserSignatureVerifier` with `PersonalMessage` wrapping (the same format MySo wallets use). If the signature doesn't match, the request is rejected.

5. **Derive MySo address** — The sender's MySo address is derived from the public key by computing `Blake2b-256(flag_byte || public_key_bytes)`. This is how MySo maps public keys to addresses.

6. **Verify address match** — The derived address must match the `sender_address` claimed in the request. This proves the sender actually owns the private key for the address they claim to be.

7. **Check permission** — The membership cache is queried to verify the sender holds the required permission for the HTTP method being used:

| HTTP Method | Required Permission |
|-------------|-------------------|
| GET | `MessagingReader` |
| POST | `MessagingSender` |
| PUT | `MessagingEditor` |
| DELETE | `MessagingDeleter` |

If the sender doesn't have the required permission in the target group, a `403 Forbidden` is returned. All other auth failures return `401 Unauthorized`.

### Bypassed Routes

The `GET /health_check` endpoint does not require authentication and is always publicly accessible.

---

## API Endpoints

### Summary

| Endpoint | Method | Auth | Permission | Description |
|----------|--------|------|------------|-------------|
| `/health_check` | GET | No | — | Liveness/readiness probe |
| `/messages` | POST | Yes | `MessagingSender` | Create a new message |
| `/messages` | GET | Yes | `MessagingReader` | Get a single message or paginated list |
| `/messages` | PUT | Yes | `MessagingEditor` | Update a message (owner only) |
| `/messages/:id` | DELETE | Yes | `MessagingDeleter` | Soft-delete a message (owner only) |

---

### `GET /health_check`

Simple liveness probe for load balancers and orchestrators. No authentication required.

**Response:**
```json
{ "status": "ok" }
```

---

### `POST /messages`

Creates a new encrypted message. Before storing, the handler checks that no existing message has the same nonce (replay protection). The message is stored locally with status `SYNC_PENDING` and will be archived to File Storage by the background sync worker.

**Required permission:** `MessagingSender`

**Request body:**
```json
{
  "group_id": "0xabc123...",
  "sender_address": "0xdef456...",
  "timestamp": 1700000000,
  "encrypted_text": "48656c6c6f...",
  "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "key_version": 0,
  "attachments": ["patch-id-1", "patch-id-2"]
}
```

- `encrypted_text` — Hex-encoded encrypted message bytes (AES-256-GCM ciphertext, encrypted client-side)
- `nonce` — Hex-encoded 12-byte AES-GCM nonce/IV used for encryption (24 hex chars = 12 bytes)
- `key_version` — Encryption key version (0-indexed, maps to a DEK in the on-chain EncryptionHistory)
- `attachments` — Optional array of File Storage quilt patch IDs referencing attached files
- `group_id`, `sender_address`, `timestamp` — Used for authentication (the entire body is the signed message)

**Response (201 Created):**
```json
{
  "message_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### `GET /messages`

Retrieves messages. Supports two modes: fetch a single message by ID, or fetch a paginated list for a group.

**Required permission:** `MessagingReader`

**Auth headers required:** `X-Signature`, `X-Public-Key`, `X-Sender-Address`, `X-Timestamp`, `X-Group-Id`

#### Single message

**Query:** `?message_id=550e8400-e29b-41d4-a716-446655440000`

**Response (200):**
```json
{
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "group_id": "0xabc123...",
  "order": 1,
  "encrypted_text": "48656c6c6f...",
  "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "key_version": 0,
  "sender_address": "0xdef456...",
  "created_at": 1700000000,
  "updated_at": 1700000000,
  "attachments": [],
  "is_edited": false,
  "is_deleted": false,
  "sync_status": "SYNC_PENDING",
  "quilt_patch_id": null
}
```

#### Paginated list

**Query:** `?group_id=0xabc123&after_order=10&limit=50`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `group_id` | string | (required) | Group to fetch messages from |
| `after_order` | integer | — | Return messages with `order > value` (scroll forward/newer) |
| `before_order` | integer | — | Return messages with `order < value` (scroll backward/older) |
| `limit` | integer | 50 | Max messages to return (capped at 100) |

If both `after_order` and `before_order` are provided, `after_order` takes precedence. If neither is provided, the most recent messages are returned.

The server fetches `limit + 1` messages internally to determine the `hasNext` flag without an extra query.

**Response (200):**
```json
{
  "messages": [
    {
      "message_id": "...",
      "group_id": "0xabc123...",
      "order": 11,
      "encrypted_text": "...",
      "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2",
      "key_version": 0,
      "sender_address": "0xdef456...",
      "created_at": 1700000000,
      "updated_at": 1700000000,
      "attachments": [],
      "is_edited": false,
      "is_deleted": false
  ],
  "hasNext": true
}
```

- `is_edited` is `true` when `updated_at != created_at`
- `is_deleted` is `true` when the message has been soft-deleted (status `DELETE_PENDING` or `DELETED`)
- `sync_status` tracks the File Storage archival state (`SYNC_PENDING`, `SYNCED`, `UPDATE_PENDING`, `UPDATED`, `DELETE_PENDING`, `DELETED`)
- `quilt_patch_id` is `null` until the message has been archived to File Storage, then contains the File Storage patch ID for direct retrieval

---

### `PUT /messages`

Updates an existing message. Only the original sender can update their own message (ownership check). The updated message is marked `UPDATE_PENDING` and will be re-archived to File Storage by the background sync worker.

**Required permission:** `MessagingEditor`

**Ownership check:** The `sender_address` in the request must match the `sender_wallet_addr` stored on the original message. If it doesn't, a `403 Forbidden` is returned with `"Only the original sender can edit this message"`.

**Request body:**
```json
{
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "group_id": "0xabc123...",
  "sender_address": "0xdef456...",
  "timestamp": 1700000000,
  "encrypted_text": "6e657774657874...",
  "nonce": "f1e2d3c4b5a6f7e8d9c0b1a2",
  "key_version": 1,
  "attachments": ["new-patch-id"]
}
```

**Response (200):**
```json
{}
```

---

### `DELETE /messages/:message_id`

Soft-deletes a message. Only the original sender can delete their own message (ownership check). The message is marked `DELETE_PENDING` and a tombstone record is archived to File Storage so that other readers know the message was intentionally deleted.

**Required permission:** `MessagingDeleter`

**Auth headers required:** `X-Signature`, `X-Public-Key`, `X-Sender-Address`, `X-Timestamp`, `X-Group-Id`

**Ownership check:** The sender address extracted from the auth context must match the `sender_wallet_addr` stored on the original message. If it doesn't, a `403 Forbidden` is returned with `"Only the original sender can delete this message"`.

**Response (200):**
```json
{}
```

---

### `GET /v1/ws` (WebSocket)

Live message subscription for group members. The relayer **never decrypts** message content — WebSocket frames carry the same encrypted wire JSON as `GET /messages`.

**Auth:** Same canonical string as GET messages: `"timestamp:sender_address:group_id"`. Browsers cannot set custom headers on WebSocket upgrade, so pass auth as query parameters: `group_id`, `sender_address`, `timestamp`, `signature`, `public_key`. Optional `after_order` filters events server-side.

**Wire frame (server → client):**

```json
{
  "type": "message.created",
  "message": {
    "message_id": "...",
    "group_id": "...",
    "order": 11,
    "encrypted_text": "...",
    "nonce": "...",
    "signature": "...",
    "public_key": "..."
  }
}
```

**Postgres cross-instance signal:** On `STORAGE_TYPE=postgres`, each `INSERT` atomically emits `pg_notify('message_events', metadata_json)` where the payload contains only `message_id`, `group_id`, `order`, and `sender` — **not** ciphertext. Each relayer instance listens, loads the encrypted row from storage, and fans out the full wire frame to local WebSocket subscribers.

**In-memory dev:** The create-message handler publishes directly to the in-process `RealtimeHub` (no NOTIFY).

The TypeScript SDK uses `HybridRelayerTransport` by default (WebSocket primary, HTTP polling fallback). Set `realtime: 'poll'` to force polling only.

---

### Error Responses

All error responses follow this format:

```json
{
  "error": "Human-readable error message"
}
```

| Status | When |
|--------|------|
| `400 Bad Request` | Invalid JSON body, missing required fields, invalid hex encoding |
| `401 Unauthorized` | Missing auth headers, expired timestamp, invalid signature, address mismatch |
| `403 Forbidden` | Valid auth but missing required permission, or ownership check failed |
| `404 Not Found` | Message or group not found |
| `409 Conflict` | Duplicate nonce (a message with this nonce already exists) |
| `500 Internal Server Error` | Unexpected storage or server failure |

---

## Storage

### Pluggable Design

The relayer uses a `StorageAdapter` trait that defines the interface for message persistence. This allows swapping storage backends without changing any handler or service code. The trait is defined in `src/storage/adapter.rs` and requires these async methods:

| Method | Purpose |
|--------|---------|
| `create_message(message)` | Store a new message with auto-assigned order number (rejects duplicate nonces) |
| `get_message(id)` | Retrieve a single message by UUID |
| `get_messages_by_group(group_id, after_order, before_order, limit)` | Paginated retrieval for a group |
| `update_message(id, encrypted_msg, nonce, key_version, attachments)` | Update content, set status to `UPDATE_PENDING` |
| `delete_message(id)` | Soft-delete, set status to `DELETE_PENDING` |

| `update_sync_status(id, status, quilt_patch_id)` | Used by File Storage sync worker to track archival state |
| `get_messages_by_sync_status(status, limit)` | Used by File Storage sync worker to find pending messages |
| `health_check()` | Verify the storage backend is operational |

### InMemoryStorage (Default)

The default storage backend stores everything in a thread-safe `HashMap` protected by a `RwLock`. The `RwLock` allows many concurrent readers or one exclusive writer at a time, so GET requests don't block each other.

**Characteristics:**
- All data is lost on restart — no persistence
- No external dependencies — starts instantly
- Suitable for development, testing, and deployments where File Storage is the primary durable store

**Internal structure:**
- `messages: RwLock<HashMap<Uuid, Message>>` — all messages indexed by UUID
- `group_orders: RwLock<HashMap<String, i64>>` — tracks the highest order number per group for auto-increment

Each group maintains its own monotonically increasing order counter. When a new message is created, it gets `order = max_order_for_group + 1`. This order value is what clients use for cursor-based pagination.

### Message Sync Status Lifecycle

Every message has a `sync_status` field that tracks its archival state. The File Storage background worker processes messages based on this status:

```
New message created  ──→  SYNC_PENDING  ──→  SYNCED
                                                 │
Message edited       ──→  UPDATE_PENDING ──→  UPDATED
                                                 │
Message deleted      ──→  DELETE_PENDING ──→  DELETED
```

- `SYNC_PENDING` — Message received, not yet archived to File Storage
- `SYNCED` — Successfully archived to File Storage (has a `quilt_patch_id`)
- `UPDATE_PENDING` — Message content updated, pending re-archival
- `UPDATED` — Updated content archived to File Storage
- `DELETE_PENDING` — Message marked for deletion, pending tombstone archival
- `DELETED` — Deletion tombstone archived to File Storage

### PostgreSQL (production)

Set `STORAGE_TYPE=postgres` and `DATABASE_URL` for durable storage. The Postgres adapter implements the full `StorageAdapter` trait:

| Data | Postgres table | Notes |
|------|----------------|-------|
| Messages | `messages` | Includes unique `(group_id, nonce)` index for replay protection |
| Encrypted read-state | `user_read_states` | Opaque blobs per wallet |
| Push tokens | `push_tokens` | iOS/APNs registration |
| Presence | `presence` | Last-seen for push gating |
| Reaction tallies | `reaction_tallies` | Off-chain mirror |
| Group pins | `group_pins` | Off-chain mirror |

**Still in-memory (by design):**

| Data | Rationale |
|------|-----------|
| Plaintext receipts (`/v1/groups/:id/receipts`) | Deprecated — use encrypted read-state |
| Block check cache | TTL LRU; social-server is source of truth |

**Membership cache** is separate from `StorageAdapter`. Set `MEMBERSHIP_STORE_TYPE=postgres` (same `DATABASE_URL`) to persist group permissions across restarts. First deploy with an empty DB still requires live on-chain membership events before auth succeeds (persist-only strategy).

**Local development:** point `MYSO_RPC_URL` at your local node (e.g. `http://127.0.0.1:9001`) and use a local Postgres database:

```env
DATABASE_URL=postgresql://localhost:5432/messaging_db
MEMBERSHIP_STORE_TYPE=postgres
```

Create the database with `createdb messaging_db` (or equivalent). Migrations run automatically on relayer startup.

After **`myso start --force-regenesis`**, reset membership sync so the relayer re-processes checkpoint events (the service also auto-clears cache when the checkpoint cursor rewinds):

```sql
TRUNCATE membership_permissions;
UPDATE membership_sync_state SET last_cursor = NULL WHERE id = 1;
```

Then restart the relayer. For quick experiments without Postgres, set `MEMBERSHIP_STORE_TYPE=memory` (cache is lost on restart).

Schema is applied via versioned SQL migrations in `relayer/migrations/` at connect time.

### APNs push delivery

When `PUSH_ENABLED=true` and all APNs credentials are set, the relayer sends **metadata-only** background pushes to offline iOS clients after each new message is stored. Push fan-out runs asynchronously so message POST latency is unaffected.

**Gating:** push is skipped for the sender and for wallets with presence updated within `PRESENCE_TTL_SECS` (default 45s).

**Payload** (no message plaintext — relayer never decrypts):

```json
{
  "aps": { "content-available": 1 },
  "group_id": "<group_id>"
}
```

APNs headers: `apns-topic` = `APNS_BUNDLE_ID`, `apns-push-type` = `background`, `apns-priority` = `5`.

**Token lifecycle:** HTTP 410 (Unregistered) responses automatically delete the stale token from storage. Token `environment` must match server `APNS_ENVIRONMENT` (`sandbox` or `production`).

See [`docs/myso-messaging-stack/ClientSide-iOS.md`](../docs/myso-messaging-stack/ClientSide-iOS.md) for the iOS client-side integration flow.

---

## Membership Sync (gRPC Event Subscription)

The relayer needs to know which MySo addresses have which permissions in which groups. This information lives on-chain in the Groups SDK smart contract. The relayer stays in sync by subscribing to MySo blockchain checkpoints via gRPC.

### How It Works

On startup, the `MembershipSyncService` connects to a MySo fullnode using a gRPC `SubscriptionServiceClient` and subscribes to the checkpoint stream. As each checkpoint arrives, the service:

1. Iterates through all transactions in the checkpoint
2. Filters events by the configured `GROUPS_PACKAGE_ID` — events from other packages are ignored
3. Deserializes the event data from BCS (Binary Canonical Serialization) format
4. Updates the local membership cache based on the event type

If the gRPC connection drops, the service automatically reconnects with a 5-second backoff delay.

### Events Processed

The service listens for four event types emitted by the Groups SDK smart contract:

| Event | Action on Cache | Description |
|-------|-----------------|-------------|
| `MemberAdded` | `add_member(group_id, address, [])` | A new member was added to a group. They start with no permissions until explicitly granted. |
| `MemberRemoved` | `remove_member(group_id, address)` | A member was removed from a group. All their permissions in that group are deleted. |
| `PermissionsGranted` | `grant_permissions(group_id, address, permissions)` | One or more permissions were granted to a member (e.g., `MessagingSender`, `MessagingReader`). |
| `PermissionsRevoked` | `revoke_permissions(group_id, address, permissions)` | One or more permissions were revoked from a member. |

### Permission Types

The Groups SDK defines four messaging permissions. Each maps to a specific API action:

| Permission | Allows | API Method |
|------------|--------|------------|
| `MessagingSender` | Sending new messages | POST |
| `MessagingReader` | Reading messages | GET |
| `MessagingEditor` | Editing own messages | PUT |
| `MessagingDeleter` | Deleting own messages | DELETE |

Permissions are parsed from MySo type name strings like `0x123::messaging::MessagingSender`.

### MembershipStore

The in-memory membership store uses a nested `HashMap` protected by a `RwLock`:

```
HashMap<group_id, HashMap<address, HashSet<Permission>>>
```

This allows O(1) lookups for the most common operation: "does address X have permission Y in group Z?" — which runs on every authenticated request.

---

## File Storage Archival

The relayer archives messages to [File Storage](https://www.mysocial.network/storage/) for decentralized, durable backup storage. This runs as a background service that periodically batches pending messages and uploads them.

### How It Works

The `FileStorageSyncService` runs an infinite loop that is triggered by one of two conditions — whichever fires first:

1. **Timer-based** — A fixed interval elapses (default: 1 hour, configurable via `FILE_STORAGE_SYNC_INTERVAL_SECS`)
2. **Threshold-based** — A configurable number of new messages have been created since the last sync (default: 50, configurable via `FILE_STORAGE_SYNC_MESSAGE_THRESHOLD`, set to 0 to disable)

When the POST handler creates a message, it sends a notification on an internal channel. The sync service counts these notifications and triggers a sync when the threshold is reached.

### Three Sync Workflows

Each sync cycle runs three passes, one for each pending status:

| From Status | To Status | What Happens |
|-------------|-----------|-------------|
| `SYNC_PENDING` | `SYNCED` | New messages are uploaded to File Storage for the first time |
| `UPDATE_PENDING` | `UPDATED` | Edited messages are re-uploaded as new quilt patches (the old patch is superseded) |
| `DELETE_PENDING` | `DELETED` | Deleted messages are uploaded as tombstone records (so readers know the message was intentionally removed) |

### Batching

Messages are batched into File Storage **quilts** (a quilt is a collection of named patches stored as a single blob). Each message becomes a patch named `msg-{message_id}`. The patch content is the full message serialized as JSON, with the `sync_status` field set to the target status.

The batch size is configurable via `FILE_STORAGE_SYNC_BATCH_SIZE` (default: 100) but is hard-capped at 666, which is the maximum number of patches File Storage allows in a single quilt. Messages from different groups are batched together in the same quilt — there is no per-group separation at the File Storage level.

If more messages are pending than the batch size, they will be picked up in the next sync cycle. Multiple cycles will drain all pending messages.

### File Storage API

The `FileStorageClient` communicates with two File Storage endpoints:

- **Publisher** (`FILE_STORAGE_PUBLISHER_URL`) — for storing blobs and quilts
- **Aggregator** (`FILE_STORAGE_AGGREGATOR_URL`) — for reading blobs and patches

| Operation | HTTP Method | Endpoint |
|-----------|-------------|----------|
| Store quilt (batch upload) | PUT | `/v1/quilts?epochs=N` |
| Store single blob | PUT | `/v1/blobs?epochs=N` |
| Read patch from quilt | GET | `/v1/blobs/by-quilt-patch-id/{patch_id}` |
| Read standalone blob | GET | `/v1/blobs/{blob_id}` |
| List patches in quilt | GET | `/v1/quilts/{quilt_blob_id}/patches` |

Storage duration is controlled by `FILE_STORAGE_STORAGE_EPOCHS` (default: 5 epochs).

---

## Configuration

All configuration is loaded from environment variables. The relayer also supports `.env` files via `dotenvy`.

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `REQUEST_TTL_SECONDS` | `900` | No | Timestamp validity window in seconds for replay protection (15 minutes) |
| `STORAGE_TYPE` | `memory` | No | Storage backend: `memory` or `postgres` |
| `DATABASE_URL` | — | When `STORAGE_TYPE=postgres` or `MEMBERSHIP_STORE_TYPE=postgres` | PostgreSQL connection string |
| `MEMBERSHIP_STORE_TYPE` | `memory` | No | Membership cache: `memory` or `postgres` (recommended with `DATABASE_URL` in production) |
| `MYSO_RPC_URL` | — | **Yes** | MySo fullnode gRPC URL for checkpoint subscription (e.g., `https://fullnode.testnet.mysocial.network:443`) |
| `GROUPS_PACKAGE_ID` | Genesis `0x2` (framework `permissioned_group`) | No | Override only for non-genesis dev chains |
| `SOCIAL_SERVER_URL` | — | No | myso-social-server base URL for DM block checks |
| `BLOCK_CHECK_ENABLED` | `true` when URL set | No | Kill switch for block checks |
| `BLOCK_CACHE_TTL_SECS` | `300` | No | Block check LRU cache TTL |
| `BLOCK_CACHE_MAX_ENTRIES` | `100000` | No | Block check LRU max entries |
| `PUSH_ENABLED` | `false` | No | Enable APNs push delivery on new messages |
| `PRESENCE_TTL_SECS` | `45` | No | Skip push if wallet seen within N seconds |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_AUTH_KEY_PATH`, `APNS_ENVIRONMENT` | — | When push enabled | APNs credentials (HTTP/2 + JWT via `.p8` key) |
| `FILE_STORAGE_PUBLISHER_URL` | `https://publisher.file-storage-testnet.mysocial.network` | No | File Storage publisher endpoint for storing blobs/quilts |
| `FILE_STORAGE_AGGREGATOR_URL` | `https://aggregator.file-storage-testnet.mysocial.network` | No | File Storage aggregator endpoint for reading blobs |
| `FILE_STORAGE_STORAGE_EPOCHS` | `5` | No | Number of File Storage epochs to persist stored data |
| `FILE_STORAGE_SYNC_INTERVAL_SECS` | `3600` | No | Seconds between timer-based sync cycles (1 hour) |
| `FILE_STORAGE_SYNC_BATCH_SIZE` | `100` | No | Max messages per sync cycle (hard-capped at 666 by File Storage quilt limit) |
| `FILE_STORAGE_SYNC_MESSAGE_THRESHOLD` | `50` | No | Number of new messages that trigger an immediate sync (0 = timer-only) |
| `REALTIME_ENABLED` | `true` when `STORAGE_TYPE=postgres`, else follows default | No | Master switch for WebSocket endpoint and Postgres LISTEN worker |
| `WS_PING_INTERVAL_SECS` | `30` | No | Server-side presence refresh interval for active WebSocket connections |
| `RUST_LOG` | `messaging_relayer=info` | No | Log level |

---

## Project Structure

```
src/
├── main.rs                    # Server startup, route wiring, background service spawning
├── lib.rs                     # Module declarations
├── config.rs                  # Environment variable loading with defaults
├── state.rs                   # AppState (shared storage, config, sync channel)
├── auth/                      # Authentication & authorization
│   ├── middleware.rs           # Axum middleware — the 7-step verification pipeline
│   ├── signature.rs           # Signature verification and MySo address derivation
│   ├── schemes.rs             # SignatureScheme enum (Ed25519, Secp256k1, Secp256r1)
│   ├── permissions.rs         # MessagingPermission enum (Sender, Reader, Editor, Deleter)
│   ├── membership.rs          # MembershipStore trait + InMemoryMembershipStore
│   └── types.rs               # AuthContext, AuthError
├── handlers/                  # HTTP request handlers
│   ├── health.rs              # GET /health_check
│   └── messages/
│       ├── handlers.rs        # CRUD handler functions (create, get, update, delete)
│       ├── request.rs         # Request DTOs (CreateMessageRequest, UpdateMessageRequest, etc.)
│       ├── response.rs        # Response DTOs (MessageResponse, MessagesListResponse, etc.)
│       └── error.rs           # ApiError enum with HTTP status mapping
├── models/                    # Domain models
│   ├── message.rs             # Message struct, SyncStatus enum
│   ├── attachment.rs          # Attachment metadata
│   └── membership.rs          # GroupMembership struct
├── services/                  # Background services
│   ├── membership_sync.rs     # gRPC checkpoint subscription and event processing
│   ├── event_parser.rs        # BCS deserialization of Groups SDK events
│   └── file_storage_sync.rs         # Periodic File Storage archival worker
├── storage/                   # Storage layer
│   ├── adapter.rs             # StorageAdapter trait definition
│   └── memory.rs              # InMemoryStorage implementation (HashMap + RwLock)
└── file-storage/                    # File Storage HTTP client
    ├── client.rs              # FileStorageClient (store/read quilts, blobs, patches)
    └── types.rs               # File Storage API response types
```

---

## Running the Application

```bash
# Create a .env file with required variables
cat > .env << 'EOF'
MYSO_RPC_URL=https://fullnode.testnet.mysocial.network:443
GROUPS_PACKAGE_ID=0x...your_package_id...
EOF

# Run with defaults (port 3000, in-memory storage)
cargo run

# Or override any config via environment
PORT=8080 FILE_STORAGE_SYNC_INTERVAL_SECS=600 cargo run
```

On startup, the relayer will:
1. Load configuration from environment / `.env` file
2. Start the HTTP server on the configured port
3. Spawn the membership sync service (connects to MySo via gRPC)
4. Spawn the File Storage sync service (periodic background archival)

---

## Running with Docker

Docker packages the relayer into a self-contained image — no Rust toolchain needed on the host machine. The Dockerfile uses a multi-stage build: the first stage compiles the binary using the full Rust image, the second stage copies only the binary into a minimal Debian image (~150MB final size).

### Quick Start (docker-compose)

```bash
# 1. Create your .env from the example template
cp .env.example .env

# 2. Fill in the required values
#    MYSO_RPC_URL and GROUPS_PACKAGE_ID are required, everything else has defaults
#    See the Configuration section above for all available variables

# 3. Build and run
docker compose up
```

This builds the image, starts the container, maps port 3000, and loads your `.env` file. The container includes a health check that polls `/health_check` every 10 seconds and will auto-restart if it crashes.

### Common Commands

```bash
# Run in the background (detached mode)
docker compose up -d

# View logs
docker compose logs -f

# Stop the container
docker compose down

# Rebuild after code changes
docker compose up --build
```

### Standalone Docker (without docker-compose)

```bash
# Build the image
docker build -t messaging-relayer .

# Run with env file
docker run -p 3000:3000 --env-file .env messaging-relayer

# Or pass env vars directly
docker run -p 3000:3000 \
  -e MYSO_RPC_URL=https://fullnode.testnet.mysocial.network:443 \
  -e GROUPS_PACKAGE_ID=0x... \
  messaging-relayer
```

---

## Testing

### Auth Integration Tests (`tests/auth_integration_test.rs`)

Tests the full authentication middleware pipeline using real cryptographic keys for all three MySo signature schemes. Uses `rstest` for parameterized testing — each scheme-dependent test runs once per scheme (Ed25519, Secp256k1, Secp256r1).

```bash
cargo test --test auth_integration_test
```

| Test | What It Verifies |
|------|-----------------|
| `test_health_check_no_auth` | Health endpoint is publicly accessible without auth |
| `test_post_without_auth_fails` | Missing `X-Signature` header returns 401 |
| `test_valid_auth_succeeds` (x3 schemes) | Valid signature + valid permission returns 201 |
| `test_no_permission_returns_403` (x3 schemes) | Valid signature but no permission returns 403 |
| `test_expired_timestamp_rejected` (x3 schemes) | Timestamp older than TTL returns 401 |
| `test_address_mismatch_rejected` (x3 schemes) | Public key that doesn't match claimed address returns 401 |
| `test_invalid_signature_rejected` (x3 schemes) | Wrong private key signing returns 401 |
| `test_get_messages_requires_auth` | GET without auth headers returns 401 |
| `test_get_messages_with_valid_auth_succeeds` | Authenticated GET with `MessagingReader` returns 200 |
| `test_delete_own_message_succeeds` | Owner with `MessagingDeleter` can delete |
| `test_delete_other_users_message_returns_403` | Non-owner gets 403 even with `MessagingDeleter` |
| `test_replay_same_post_nonce_rejected` | Same POST nonce sent twice returns 409 Conflict |
| `test_different_nonces_both_accepted` | Two POSTs with different nonces both succeed |
| `test_get_replay_is_allowed` | Same GET sent twice both succeed (idempotent, no replay check) |

### Membership Sync Tests (`tests/membership_sync_test.rs`)

Tests the gRPC event subscription and membership cache updates using a mock gRPC server (no real MySo node needed). Verifies that the service correctly processes each event type and updates the permission cache.

```bash
cargo test --test membership_sync_test
```

| Test | What It Verifies |
|------|-----------------|
| `test_member_added_event` | `MemberAdded` + `PermissionsGranted` in same checkpoint |
| `test_member_removed_event` | Adding then removing a member across checkpoints |
| `test_permissions_granted_event` | Granting multiple permissions |
| `test_permissions_revoked_event` | Granting then revoking a subset of permissions |
| `test_multiple_checkpoints_with_multiple_events` | Multiple members and events per checkpoint |
| `test_ignores_events_from_other_packages` | Events from non-matching package IDs are skipped |
| `test_duplicate_cursor_is_skipped` | Duplicate checkpoint cursors don't cause double-processing |

### File Storage Client Tests (`tests/file_storage_integration_test.rs`)

Tests the File Storage HTTP client against the real File Storage testnet. Marked `#[ignore]` so they don't run in CI — run manually when testing File Storage connectivity.

```bash
cargo test --test file_storage_integration_test -- --ignored
```

| Test | What It Verifies |
|------|-----------------|
| `test_store_quilt_and_verify_response` | Stores 3 patches as a quilt, verifies response structure |
| `test_quilt_patch_roundtrip` | Stores a quilt, reads each patch back, asserts exact byte match |
| `test_blob_store_and_read_roundtrip` | Stores a single blob, reads it back, asserts exact byte match |
| `test_list_patches_in_quilt` | Lists patches in a quilt, verifies count matches |
| `test_read_nonexistent_patch_returns_error` | Reading a bogus patch ID returns error |
| `test_get_patch_id_helper` | `QuiltStoreResponse::get_patch_id()` returns correct values |

### File Storage Sync Worker Tests (`tests/file_storage_sync_test.rs`)

Tests the background sync service logic using wiremock (mock HTTP server). No real File Storage connection needed — runs in CI.

```bash
cargo test --test file_storage_sync_test
```

| Test | What It Verifies |
|------|-----------------|
| `test_sync_no_pending_messages` | Empty storage is a no-op, no File Storage call made |
| `test_sync_uploads_pending_and_marks_synced` | `SYNC_PENDING` messages uploaded and marked `SYNCED` |
| `test_sync_respects_batch_size` | Only `batch_size` messages synced per cycle |
| `test_sync_serializes_full_message_as_json` | Synced patch deserializes back to original Message struct |
| `test_sync_skips_non_pending_messages` | Already-synced messages are not re-uploaded |
| `test_sync_cross_group_batching` | Messages from multiple groups batched into one quilt |
| `test_multiple_sync_cycles_drain_all_pending` | Multiple cycles drain all pending messages |
| `test_sync_uploads_updated_messages` | `UPDATE_PENDING` messages uploaded and marked `UPDATED` with new patch ID |
| `test_sync_uploads_deleted_messages` | `DELETE_PENDING` messages uploaded and marked `DELETED` |
| `test_sync_handles_all_statuses_in_one_cycle` | Pending, updated, and deleted messages all processed in one cycle |
| `test_sync_deleted_message_contains_deleted_status` | Deleted message's patch contains `DELETED` status for readers |
| `test_run_timer_trigger` | `run()` loop syncs on timer tick |
| `test_run_message_threshold_trigger` | `run()` loop syncs on message count threshold |
| `test_create_message_sends_sync_notification` | POST handler sends notification on sync channel |

### Running All Tests

```bash
# All tests (unit + integration, no network required)
cargo test

# With output
cargo test -- --nocapture

# Specific test file
cargo test --test auth_integration_test

# Include ignored tests (requires File Storage testnet access)
cargo test -- --ignored
```

### End-to-End Tests (`e2e/`)

TypeScript/Vitest tests that run against a live relayer instance connected to MySo testnet. These are not automated in CI — they require a running relayer, a deployed Groups SDK contract, and a funded test wallet.

See [`e2e/README.md`](e2e/README.md) for setup instructions and test descriptions.

---

## Further Documentation

- [Auth System](src/auth/README.md) — Detailed authentication pipeline documentation with Mermaid diagrams
- [Message Flow Diagrams](diagrams/README.md) — Mermaid sequence diagrams for all request flows, storage modes, and membership sync
