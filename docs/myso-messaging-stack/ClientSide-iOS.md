# iOS Client-Side Integration

The iOS client connects **directly to the Relayer** for messaging — no separate product backend for messages, unread counts, or push relay.

DripDrop also keeps its **existing product WebSocket** (`WebSocketService`) to the DripDrop backend (portfolio, analytics, JWT `authenticate`). Messaging uses a **second** socket to the messaging relayer. Do not multiplex both protocols on one connection.

## Two-socket model

| Socket | Service | Auth | Purpose |
|--------|---------|------|---------|
| DripDrop backend | `WebSocketService` | Bearer JWT JSON `{type:authenticate,token}` | Product realtime (unchanged) |
| Messaging relayer user feed | `MessagingUserFeedService` | Wallet-signed query params | Unread / discovery wake signals (metadata only) |
| Messaging relayer group feed | `MessagingGroupFeedService` | Wallet-signed query + `group_id` | Open-thread encrypted frames (`message.created`) |

Lifecycle: on login / `sceneDidBecomeActive`, connect both DripDrop WS and user feed. On logout / background, disconnect both with `stopReconnect: true`.

Config: `MESSAGING_RELAYER_URL` in xcconfig / Info.plist as **host only** (e.g. `10.0.0.10:3003`) — same pattern as `BACKEND_URL`. Do not put `http://` in xcconfig (`//` starts a comment). `Constants` prepends `http://` / `ws://`.

## Relayer endpoints

| Feature | Endpoint |
|---------|----------|
| Messages | `/messages` or `/v1/messages` (signed CRUD) |
| User feed (wake) | `GET /v1/users/ws` (WebSocket, metadata only) |
| Group realtime | `GET /v1/ws` (WebSocket, full encrypted wire JSON) |
| Unread counts | `POST /v1/users/unread-counts` (body-signed batch) |
| Read state | `GET/PUT /v1/users/read-state` |
| Push token | `POST/DELETE /v1/devices/push-tokens` |
| Presence | `POST /v1/devices/presence` |
| Blocks (DM) | Relayer enforces via social-server; SDK pre-check optional |

## User feed WebSocket (`/v1/users/ws`)

Wallet-scoped wake channel. Frames are **metadata only** — never ciphertext. Inbox mirrors web: on `group.activity`, immediately refresh unread (`POST /v1/users/unread-counts`) and tip-decrypt the newest message via REST (`GET /v1/messages`). There is no always-on socket that streams every group's ciphertext into the sidebar.

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
| `group.activity` | New message order in a group | Optimistic unread + immediate unread REST + tip preview decrypt for `group_id` |
| `read_state.updated` | Encrypted read-state blob changed | `GET /v1/users/read-state` |
| `group.discovered` | Conversation appeared (created/invited/joined) | Refresh group list |
| `group.hidden` | Conversation should leave sidebar | Remove locally |

Ignore unknown / workflow types until those milestones ship.

### Group feed auth (`/v1/ws`)

Canonical: `{timestamp}:{sender_address}:{group_id}` plus optional `after_order`. See `MessagingRelayerAuth.createGroupFeedQuery` / TS `createWsAuthQuery`.

## Unread badges

1. `GET /v1/users/read-state` → decrypt blob → `readUpto` per group
2. `POST /v1/users/unread-counts` with `{ items: [{ group_id, after_order }] }` → exact batch counts (preferred over paging message heads)
3. On thread open → merge blob → `PUT /v1/users/read-state` (optional `expected_version` for CAS)
4. Foreground: user-feed `group.activity` / `read_state.updated` wakes recompute (no ciphertext on the socket)

iOS: `MessagingRelayerHTTPClient.fetchUnreadCounts` / `getUserReadState` / `putUserReadState` / `fetchMessages`.

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
| `MessagingRelayerAuth` | Personal-message sign + WS query + wallet/group/body REST auth |
| `MessagingUserFeedService` | `/v1/users/ws` + typed events |
| `MessagingSyncHub` | User-feed wakes → inbox callbacks |
| `MessagingRelayerHTTPClient` | Signed REST via `Network.requestMessagingRelayer` |
| `MessagingInboxService` | Singleton: discovery, unread, store (survives tab unmount) |
| `MessagingGroupStore` | UserDefaults conversation cache |
| `MessagingMessageStore` | SQLite ciphertext store (WAL + File Protection) + vault helpers; plaintext only in RAM LRU |
| `MessagingPlaintextCache` | Process-wide LRU of decrypted bodies (~20 groups × ~150 msgs) |
| `MessagingVault` | Keychain AES vault key; wraps DEKs + seals inbox chrome |
| `MessagingGroupDiscovery` | GraphQL `MemberAdded` / `MemberRemoved` net membership |
| `MessagingGroupMetadata` | On-chain Metadata name/uuid via MySoKit dynamic fields |
| `MessagingProfileResolver` | Wallet → GraphQL `ProfileFull` (username, displayName, photo, SPT address, reservation %); indexer fallback; `@username` via search then ProfileFull |
| `MessagingAvatarView` | Shared list/bubble avatar + SPT ring |
| `ChatTabView` / list / thread / detail | UIKit Messages tab: list → thread (nav `info.circle` → detail); encrypt send; typing; image bubbles; linkified URLs |
| `MyDataCrypto` (SPM) | Native Swift MyData + messaging envelope encrypt/decrypt (blst BLS) |
| `Services/MyData/*` | SessionKey, key-server HTTP, approve PTB, `MyDataClient` |
| `MessagingEncryptionService` | DEK cache + EncryptionHistory + AES-GCM/AAD encrypt & decrypt + attachment meta/images |
| `MessagingFileStorageClient` | Lazy `GET` File Storage aggregator quilt-patch download |

### MyData decrypt (on-device)

Canonical protocol: TypeScript `@socialproof/mydata`. Crypto lives in `myso-swift-kit` product `MyDataCrypto` (`Sources/MyDataCrypto`, portable blst + protocol port). DripDrop links the local package at `../myso-swift-kit`. **Milestone 0 gate:** TS-generated `EncryptedObject` → Swift DEK byte-for-byte (`swift test --filter MyDataCryptoTests` in `myso-swift-kit`).

xcconfig / Info.plist:

| Key | Purpose |
|-----|---------|
| `MYDATA_KEY_SERVER_OBJECT_IDS` | Comma-separated KeyServer object IDs |
| `MYDATA_THRESHOLD` | Threshold (localnet often `1`) |
| `MYDATA_KEY_SERVER_URLS` | Optional URL overrides (`http:/$()/127.0.0.1:2024` in xcconfig) |
| `MESSAGING_NAMESPACE_ID` | `deriveObjectID` parent for EncryptionHistory |
| `MESSAGING_VERSION_OBJECT_ID` | `mydata_approve_reader` Version object |
| `MESSAGING_ORIGINAL_PACKAGE_ID` / `MESSAGING_LATEST_PACKAGE_ID` | SessionKey namespace / approve package |
| `FILE_STORAGE_AGGREGATOR_URL` | Host for attachment download (`/v1/blobs/by-quilt-patch-id/{id}`) |

After localnet regenesis, refresh Dev xcconfig (`ProjectYZDevelopment.xcconfig`):

1. Key server — match chat-app `VITE_MYDATA_KEY_SERVER_OBJECT_IDS` / `myso start --with-mydata` output (`key_server::KeyServer`).
2. Namespace / Version — GraphQL: filter `0xe110::messaging::MessagingNamespace` and `0xe110::version::Version`.
3. Rebuild the Dev scheme (plist values are baked at build time).

Decrypt `missingObject(0x…)` usually means a stale `MESSAGING_NAMESPACE_ID` (wrong EncryptionHistory derivation), not the key-server URL. Pre-regenesis messages in the relayer cannot be decrypted on a new chain — create new groups after reset.

Security: plaintext lives only in RAM (`MessagingPlaintextCache`); DEKs are RAM-cached and Keychain-wrapped with the vault key after first MyData unwrap; session keys stay on device. Cleared on logout via `MessagingEncryptionService.clear` + `MessagingMessageStore.clear(wallet:)`. Relayer never sees plaintext. **No SQLCipher** — messages are already E2E ciphertext; SQLite adds indexes/WAL under iOS File Protection + sandbox.

### SQLite ciphertext store + RAM plaintext (Signal-like load path)

Wire ciphertext + metadata persist in SQLite under Application Support (`MessagingMessages/{wallet}/messages.sqlite`): `PRAGMA journal_mode=WAL`, file protection `completeUntilFirstUserAuthentication`. **No plaintext column.** After decrypt, bodies go to `MessagingPlaintextCache` (LRU ~20 groups × ~150 msgs). DEKs: RAM → Keychain-wrapped (`messagingWrappedDEK`, sealed with `messagingVaultKey`) → MyData last resort. Reaction absolute-state rows (`reactions` table: order/emoji/count/reactors) are public metadata and cached for instant chip paint. Inbox chrome (preview text) is vault-sealed on disk — not UserDefaults cleartext. Legacy `.json.sealed` plaintext blobs migrate into SQLite once then delete. Caps ~150 messages/group. Attachment **bytes** stay session/RAM. Logout wipes DB dir + vault key + RAM caches.

Open thread: hydrate SQLite tip page + cached reactions → local AES for missing plaintext (Keychain DEK, before tip REST) → paint → `fetchMessages` + `listReactions` in parallel → decrypt only still-missing ids → write ciphertext + reaction rows + RAM cache. Gap-fill / catch-up never block first message or chip paint. Inbox warm is incremental (skip groups already at tip order).

### Create Conversation (UI-only)

Messages list **+** opens a SwiftUI sheet (`CreateConversationSheet`): following suggestions (`ProfileFollowing`), MySo `/search` for username/name, and `0x`+64-hex wallet lookup via `ProfileFull` with **cardless** selectable rows when no profile exists. Next inserts a local draft group (`groupId` prefix `local-`) via `MessagingInboxService.insertLocalDraft`, seeds inbox chrome for 1:1 peers, republishes the inbox row at the top, and pushes `ChatThreadViewController` with composer focused. Discovery/`replaceActive` preserves `local-*` drafts. **Does not** call `createAndShareGroup`, share PTBs, or relayer create-group — wire those in a later milestone.

### Chat tab lifecycle

1. **Login / scene active** — user feed connects; `MessagingInboxService.start` (idempotent) hydrates sealed chrome, GraphQL discovery, metadata, `POST /v1/users/unread-counts` (local `localReadUpto` as `after_order`). Incremental tip warm only for missing/stale previews. If GraphQL returns `FEATURE_UNAVAILABLE` for event indexes (common on public testnet), discovery is skipped and the list relies on cache + `group.discovered` user-feed wakes.
2. **Foreground wakes** — `group.activity` on the user feed updates sort order immediately, bumps unread optimistically, then coalesced unread REST + targeted tip preview when chrome is behind. Group feed (`MessagingGroupFeedService`) is used only while a thread is open.
3. **Chat tab appears** — bind list UI; reconcile unread; 60s timer while mounted; incremental preview warm.
4. **Chat tab destroyed** (custom tab bar) — stop timer / group WS; **keep** inbox singleton + store.
5. **Open thread** — hydrate SQLite + reaction cache + plaintext LRU; local AES for missing bodies (Keychain DEK); parallel `fetchMessages` + `listReactions`; decrypt only still-missing; lazy images; group WS; local `markRead`; write-through ciphertext + reactions + RAM cache. Opening cancels inbox tip refresh tasks.
6. **Send** — composer encrypts (DEK + AAD AES-GCM) → signs canonical content → `POST /v1/messages`; optimistic bubble then WS/fetch reconcile; write-through SQLite + RAM cache.
7. **Typing** — throttled `POST /v1/groups/{id}/typing`; WS `typing.start`/`stop` drives indicator above composer.
8. **List profiles** — `@handle` DM names resolve via indexer search → `ProfileFull`; list title/photo/SPT ring from `MessagingProfile`.
9. **Encrypted read-state CAS / attachment upload-from-composer** — still deferred.

Unread badges stay on the relayer path (not product backend). Merge with likes/comments badges only at the UI if needed.

Mirror the TypeScript SDK contracts in `auth-headers.ts` / `http-transport.ts` / `ws-transport.ts`. Ensure the messaging-relayer binary includes `/v1/users/ws` (stale release builds previously 401'd browser clients).
