# Encrypted Read State & Messaging Synchronization

Cross-device unread sync uses a **wallet-scoped encrypted blob** stored on the Relayer. The server never sees plaintext `readUpto` watermarks. Around it sits the messaging synchronization layer: optimistic-concurrency writes, exact batch unread counts, and a wallet-scoped user feed WebSocket that makes polling a resilience fallback rather than the primary mechanism.

## Schema (inside ciphertext)

```typescript
interface UserReadState {
  version: 1;
  updatedAt: number;
  groups: Record<string, { readUpto: number; muted?: boolean }>;
}
```

Unread for group `G` = count of non-deleted messages where `order > groups[G].readUpto` — computed server-side by the batch endpoint below (the client sends its watermarks; it already reveals them as `after_order` query params when paging messages).

## Relayer API

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/users/read-state` | Wallet signature (`timestamp:sender_address`) |
| PUT | `/v1/users/read-state` | Signed JSON body |
| POST | `/v1/users/unread-counts` | Signed JSON body |
| GET (WS) | `/v1/users/ws` | Wallet signature via query params |

### Versioning & optimistic concurrency

The server assigns `blob_version` (monotonic increment per write); client-proposed versions are ignored. PUT accepts an optional `expected_version`:

- Match (or omitted) → `200 { ok: true, blob_version }`
- Mismatch → `409` with `code: "READ_STATE_CONFLICT"` and the current `{ encrypted_blob, blob_version, updated_at }` so the client merges and retries without another GET

Omitting `expected_version` preserves legacy last-writer-wins for old clients.

### Batch unread counts

`POST /v1/users/unread-counts` body: `{ sender_address, timestamp, items: [{ group_id, after_order }] }` (max 100 items). Response: `{ items: [{ group_id, latest_order, unread_count }] }` with exact counts excluding soft-deleted messages. Groups the wallet cannot read are omitted.

### User feed (`/v1/users/ws`)

One socket per wallet carries all user-scoped synchronization events (metadata only — never ciphertext; REST stays the source of truth):

| Event | Payload | Delivered to |
|-------|---------|--------------|
| `group.activity` | `{ group_id, latest_order }` | Members of the group |
| `read_state.updated` | `{ wallet, blob_version }` | That wallet only (cross-device sync) |
| `group.discovered` | `{ group_id, reason }` | The added wallet only |
| `group.hidden` | `{ group_id }` | The removed wallet only |

Discovery events are published exclusively by the relayer's membership checkpoint indexer, after membership persistence succeeds.

## SDK

```typescript
// One live stream for badges, cross-device read state, and group discovery
for await (const event of client.messaging.subscribeUserEvents({ signer, signal })) {
  // event.type: 'group.activity' | 'read_state.updated' | 'group.discovered' | 'group.hidden'
}

const state = await client.messaging.getReadState({ signer });
await client.messaging.updateReadState({ signer, groupId, readUpto: 42 }); // CAS + merge + retry
const counts = await client.messaging.getUnreadCounts({ signer, groupIds: ['0x...'] }); // one batch call
```

`MessagingSyncManager` (exported; `ReadStateManager` remains as a deprecated alias) caches the last-known state + version per wallet, uses it as the CAS base, retries on `ReadStateConflictError` by merging the server's current blob, skips writes that would not advance the watermark, and invalidates its cache when a `read_state.updated` event arrives from another device.

Encryption: HKDF-SHA256(wallet seed, `myso-messaging-read-state-v1`) + AES-256-GCM.

## Typing & presence (ephemeral)

Same synchronization layer, zero persistence:

- `POST /v1/groups/:id/typing` `{ typing: bool }` broadcasts `typing.start` (rate-limited, carries a TTL `expires_at` as recovery) or `typing.stop` on the group WebSocket. SDK: `client.messaging.sendTyping({ signer, groupRef, typing })`.
- Presence is **wallet-scoped**: the relayer refcounts WebSocket connections per wallet and broadcasts `presence.updated { member, online }` to the wallet's groups only on online/offline transitions (offline debounced ~10s). Snapshot: `GET /v1/groups/:id/presence`; SDK: `client.messaging.getGroupPresence({ signer, groupRef })`. Live events flow through `client.messaging.subscribe()` as `typing` / `presence` variants.

## Deprecation

Plaintext `/v1/groups/:id/receipts` remains for one release but should not be used in new clients.

## Production

Use `STORAGE_TYPE=postgres` so read-state blobs survive Relayer restarts; cross-instance realtime fan-out (including read-state, typing, and presence events) rides the existing `pg_notify` channel.
