# iOS Client-Side Integration

The iOS client connects **directly to the Relayer** for messaging — no separate product backend for messages, unread counts, or push relay.

DripDrop also keeps its **existing product WebSocket** (`WebSocketService`) to the DripDrop backend (portfolio, analytics, JWT `authenticate`). Messaging uses a **second** socket to the messaging relayer. Do not multiplex both protocols on one connection.

## Two-socket model

| Socket | Service | Auth | Purpose |
|--------|---------|------|---------|
| DripDrop backend | `WebSocketService` | Bearer JWT JSON `{type:authenticate,token}` | Product realtime (unchanged) |
| Messaging relayer user feed | `MessagingUserFeedService` | Wallet-signed query params | Unread / discovery wake signals |
| Messaging relayer group feed | `MessagingGroupFeedService` (stub) | Wallet-signed query + `group_id` | Open-thread encrypted frames |

Lifecycle: on login / `sceneDidBecomeActive`, connect both DripDrop WS and user feed. On logout / background, disconnect both with `stopReconnect: true`.

Config: `MESSAGING_RELAYER_URL` in xcconfig / Info.plist as **host only** (e.g. `10.0.0.10:3003`) — same pattern as `BACKEND_URL`. Do not put `http://` in xcconfig (`//` starts a comment). `Constants` prepends `http://` / `ws://`.

## Relayer endpoints

| Feature | Endpoint |
|---------|----------|
| Messages | `/messages` or `/v1/messages` (signed CRUD) |
| User feed (wake) | `GET /v1/users/ws` (WebSocket, metadata only) |
| Group realtime | `GET /v1/ws` (WebSocket, full encrypted wire JSON) |
| Read state | `GET/PUT /v1/users/read-state` |
| Push token | `POST/DELETE /v1/devices/push-tokens` |
| Presence | `POST /v1/devices/presence` |
| Blocks (DM) | Relayer enforces via social-server; SDK pre-check optional |

## User feed WebSocket (`/v1/users/ws`)

Wallet-scoped wake channel. Frames are **metadata only** — never ciphertext. After a wake, REST re-fetch is the source of truth (unread counts, message heads, read-state blob).

### Auth (query string)

Canonical personal-message string:

```
{timestamp}:{sender_address}
```

Query params (same bytes as wallet header auth):

| Param | Value |
|-------|--------|
| `sender_address` | MySo address |
| `timestamp` | Unix seconds |
| `signature` | Hex raw 64-byte Ed25519 signature |
| `public_key` | Hex flagged pubkey (`0x00 \|\| ed25519 pubkey`) |

Swift: `MessagingRelayerAuth.createUserFeedQuery` (mirrors TS `createUserWsAuthQuery`).

### Event types (wake → REST)

| `type` | Meaning | Client action |
|--------|---------|---------------|
| `group.activity` | New message order in a group | REST re-fetch heads / messages for `group_id` |
| `read_state.updated` | Encrypted read-state blob changed | `GET /v1/users/read-state` |
| `group.discovered` | Conversation appeared (created/invited/joined) | Refresh group list |
| `group.hidden` | Conversation should leave sidebar | Remove locally |

Ignore unknown / workflow types until those milestones ship.

### Group feed auth (`/v1/ws`)

Canonical: `{timestamp}:{sender_address}:{group_id}` plus optional `after_order`. See `MessagingRelayerAuth.createGroupFeedQuery` / TS `createWsAuthQuery`.

## Unread badges

1. `GET /v1/users/read-state` → decrypt blob → `readUpto` per group
2. Fetch message heads → compute `unread = messages after readUpto`
3. On thread open → merge blob → `PUT /v1/users/read-state`
4. Foreground: user-feed `group.activity` / `read_state.updated` wakes recompute (no ciphertext on the socket)

## Push wake flow

1. Register APNs token: `POST /v1/devices/push-tokens` with `{ platform: "ios", token, environment: "sandbox"|"production" }`
2. Heartbeat while foreground: `POST /v1/devices/presence` with `{ active: true }` (also refreshed by open WebSocket connections)
3. Relayer sends metadata-only APNs when recipient is not recently active (`PRESENCE_TTL_SECS`)
4. On push: background-fetch messages + read-state → update local badge

## Foreground realtime (group WebSocket)

When a thread is open, prefer group WebSocket over HTTP polling:

1. Open `wss://{relayer}/v1/ws?group_id=...&sender_address=...&timestamp=...&signature=...&public_key=...`
2. Parse `{ "type": "message.created", "message": { ... } }` frames — decrypt locally; **do not HTTP-refetch** after each event for that open thread
3. Optional `after_order` query param for resumability
4. Fall back to HTTP polling if WebSocket is blocked or fails (TypeScript SDK: `HybridRelayerTransport`)

User feed stays connected for sidebar/unread while group feed is open.

### APNs payload contract

The relayer sends a **silent background push** — no alert, sound, or message plaintext. Parse `group_id` from the notification payload to know which thread changed.

**JSON body:**

```json
{
  "aps": { "content-available": 1 },
  "group_id": "<group_id>"
}
```

**APNs request headers:**

| Header | Value |
|--------|-------|
| `apns-topic` | Your app bundle ID (`APNS_BUNDLE_ID`) |
| `apns-push-type` | `background` |
| `apns-priority` | `5` |

**iOS handling:**

1. Receive push in `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` or via Notification Service extension
2. Read `group_id` from the root-level custom field (not inside `aps`)
3. Background-fetch new messages for that group from the relayer
4. `GET /v1/users/read-state` → decrypt → recompute badge counts
5. Call `POST /v1/devices/presence` when the app is foreground/active to suppress further pushes while connected (WebSocket or polling)

**Token registration validation:**

- `platform` must be `"ios"`
- `environment` must match the relayer's `APNS_ENVIRONMENT`
- `token` must be a hex device token (32–200 characters)

Stale tokens are pruned server-side when Apple returns HTTP 410.

## Relayer env (production)

```
PUSH_ENABLED=true
PRESENCE_TTL_SECS=45
APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_BUNDLE_ID=...
APNS_AUTH_KEY_PATH=...
APNS_ENVIRONMENT=sandbox|production
STORAGE_TYPE=postgres
DATABASE_URL=postgres://...
SOCIAL_SERVER_URL=https://...
```

## Swift client (current foundation)

| Type | Role |
|------|------|
| `WebSocketConnection` | Shared transport (ping, reconnect) |
| `MessagingRelayerAuth` | Personal-message sign + query/header auth |
| `MessagingUserFeedService` | `/v1/users/ws` + typed events |
| `MessagingSyncHub` | Extension points for unread / discovery |
| `MessagingRelayerHTTPClient` | Stub for signed REST |
| `MessagingGroupFeedService` | Stub for `/v1/ws` |

Mirror the TypeScript SDK contracts in `auth-headers.ts` / `ws-transport.ts`. Ensure the messaging-relayer binary includes `/v1/users/ws` (stale release builds previously 401'd browser clients).
