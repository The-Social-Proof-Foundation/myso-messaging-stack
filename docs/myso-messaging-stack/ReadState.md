# Encrypted Read State & Messaging Synchronization

Cross-device unread sync uses a **wallet-scoped encrypted blob** stored on the Relayer. The server never sees plaintext `readUpto` watermarks inside that blob. Around it sits the messaging synchronization layer: optimistic-concurrency writes, exact batch unread counts, and a wallet-scoped user feed WebSocket that makes polling a resilience fallback rather than the primary mechanism.

**Dual channel (do not conflate):**

| Channel | Purpose | Visible to peers? |
|---------|---------|-------------------|
| Encrypted `read-state` + `read_state.updated` | Your unread badges across *your* devices | **No** (private blob) |
| Plaintext `group_member_receipts` + `receipt.updated` | Delivery / read ticks on own messages | **Yes** (order watermarks only) |

Clients dual-write on open/read: advance private `updateReadState` **and** (when `receipt_mode` allows) `POST /v1/groups/:id/receipts` with `read_upto`. Delivered ACKs use the same receipts endpoint after **any** successful tip/message ingest (inbox sidebar or open thread) — not only while the chat is open. Read ACKs remain open-thread only.

Encrypted blob field `muted` is **not** used for push mute. Per-chat mute and read-receipt visibility are server-visible `conversation_preferences` (below).

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
| `receipt.updated` | `{ group_id, member, delivered_upto, read_upto }` | Other members of the group |
| `group.discovered` | `{ group_id, reason }` | The added wallet only |
| `group.hidden` | `{ group_id }` | The removed wallet only |

Discovery events are published exclusively by the relayer's membership checkpoint indexer, after membership persistence succeeds.

## Peer-visible delivery / read receipts

Durable Postgres table `group_member_receipts` (memory adapter for tests). Watermarks are monotonic (`GREATEST`); `read_upto` cannot exceed `delivered_upto` (read auto-bumps delivered). Advances are clamped to the group's tip message `order`.

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/v1/groups/:id/receipts` | Body `{ delivered_upto?, read_upto? }` — advance caller's watermarks; fan-out |
| `GET` | `/v1/groups/:id/receipts` | `{ members: [{ member, delivered_upto, read_upto }] }` |

Realtime: `receipt.updated` on the **group** feed (`/v1/ws`) and membership-filtered on the **user** feed (`/v1/users/ws`), plus `pg_notify` for multi-instance.

Tick UI (own messages, last-in-group): single green ✓ = all other members `delivered_upto >= order`; offset double ✓✓ = all others `read_upto >= order`. SDK helper: `tickStatus(order, members, selfAddress)`. Signature verification (`senderVerified`) is **not** the delivery tick.

`POST …/receipts` enforcement by caller's `receipt_mode` (silent strip, not 403):

| Mode | `delivered_upto` | `read_upto` |
|------|------------------|-------------|
| `full` (default) | accept | accept |
| `delivered_only` | accept | ignore |
| `none` | ignore | ignore |

## Conversation preferences (server-visible)

Plaintext Postgres table `conversation_preferences` keyed by `(group_id, wallet)`. Missing row = defaults `notification_mode: all`, `receipt_mode: full`, `version: 1`.

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| `GET` | `/v1/groups/:id/prefs` | Group header | Caller's prefs (synthetic defaults if no row) |
| `PUT` | `/v1/groups/:id/prefs` | Body-signed | Partial merge; bump `version`; return full prefs |

```json
PUT { "notification_mode": "none" }
// preserves receipt_mode; version++
```

Modes: `notification_mode` ∈ `all` \| `none`; `receipt_mode` ∈ `full` \| `delivered_only` \| `none`. Empty PUT → 400.

**Push filter order** in `notify_new_message`: members → drop sender → presence (recently active) → **batched** `list_notification_modes` for remaining inactive wallets → drop `notification_mode == none` → token lookup / APNs. Workflow push unchanged. Encrypted `muted` is unused for APNs.

**Clients:** Chat Details (web Info → AdminPanel; iOS Details) expose **Chat settings** with Notifications + Read receipts toggles for every member (default ON). SDK: `getConversationPrefs` / `putConversationPrefs`.

## SDK

```typescript
// One live stream for badges, cross-device read state, and group discovery
for await (const event of client.messaging.subscribeUserEvents({ signer, signal })) {
  // event.type: 'group.activity' | 'read_state.updated' | 'receipt.updated'
  //            | 'group.discovered' | 'group.hidden'
}

const state = await client.messaging.getReadState({ signer });
await client.messaging.updateReadState({ signer, groupId, readUpto: 42 }); // CAS + merge + retry
const counts = await client.messaging.getUnreadCounts({ signer, groupIds: ['0x...'] }); // one batch call

const receipts = await client.messaging.getGroupReceipts({ signer, groupRef });
await client.messaging.postGroupReceipts({
  signer,
  groupRef,
  deliveredUpto: 42,
  readUpto: 42,
});

const prefs = await client.messaging.getConversationPrefs({ signer, groupRef });
await client.messaging.putConversationPrefs({
  signer,
  groupRef,
  notificationMode: 'none',
  // receiptMode omitted → preserved
});
```

`MessagingSyncManager` (exported; `ReadStateManager` remains as a deprecated alias) caches the last-known state + version per wallet, uses it as the CAS base, retries on `ReadStateConflictError` by merging the server's current blob, skips writes that would not advance the watermark, and invalidates its cache when a `read_state.updated` event arrives from another device.

Encryption: HKDF-SHA256(wallet seed, `myso-messaging-read-state-v1`) + AES-256-GCM.

## Typing & presence (ephemeral)

Same synchronization layer, zero persistence:

- `POST /v1/groups/:id/typing` `{ typing: bool }` broadcasts `typing.start` (rate-limited, carries a TTL `expires_at` as recovery) or `typing.stop` on the group WebSocket. SDK: `client.messaging.sendTyping({ signer, groupRef, typing })`.
- Presence is **wallet-scoped**: the relayer refcounts WebSocket connections per wallet and broadcasts `presence.updated { member, online }` to the wallet's groups only on online/offline transitions (offline debounced ~10s). Snapshot: `GET /v1/groups/:id/presence`; SDK: `client.messaging.getGroupPresence({ signer, groupRef })`. Live events flow through `client.messaging.subscribe()` as `typing` / `presence` variants.

## Production

Use `STORAGE_TYPE=postgres` so read-state blobs, `group_member_receipts`, **and** `conversation_preferences` survive Relayer restarts; cross-instance realtime fan-out (read-state, receipts, typing, presence) rides the existing `pg_notify` channel.
