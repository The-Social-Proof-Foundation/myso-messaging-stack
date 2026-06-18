# iOS Client-Side Integration

The iOS client connects **directly to the Relayer** — no separate product backend for messages, unread counts, or push relay.

## Relayer endpoints

| Feature | Endpoint |
|---------|----------|
| Messages | `/messages` or `/v1/messages` (signed CRUD) |
| Realtime | `GET /v1/ws` (WebSocket, full encrypted wire JSON) |
| Read state | `GET/PUT /v1/users/read-state` |
| Push token | `POST/DELETE /v1/devices/push-tokens` |
| Presence | `POST /v1/devices/presence` |
| Blocks (DM) | Relayer enforces via social-server; SDK pre-check optional |

## Unread badges

1. `GET /v1/users/read-state` → decrypt blob → `readUpto` per group
2. Fetch message heads → compute `unread = messages after readUpto`
3. On thread open → merge blob → `PUT /v1/users/read-state`

## Push wake flow

1. Register APNs token: `POST /v1/devices/push-tokens` with `{ platform: "ios", token, environment: "sandbox"|"production" }`
2. Heartbeat while foreground: `POST /v1/devices/presence` with `{ active: true }` (also refreshed by open WebSocket connections)
3. Relayer sends metadata-only APNs when recipient is not recently active (`PRESENCE_TTL_SECS`)
4. On push: background-fetch messages + read-state → update local badge

## Foreground realtime (WebSocket)

When the app is active, prefer WebSocket over HTTP polling:

1. Open `wss://{relayer}/v1/ws?group_id=...&sender_address=...&timestamp=...&signature=...&public_key=...` (same canonical auth as GET messages)
2. Parse `{ "type": "message.created", "message": { ... } }` frames — decrypt locally; **do not HTTP-refetch** after each event
3. Optional `after_order` query param for resumability
4. Fall back to HTTP polling if WebSocket is blocked or fails (TypeScript SDK: `HybridRelayerTransport`)

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

## Swift client

Implement the same wallet-signature HTTP contract as `HTTPRelayerTransport` in the TypeScript SDK (see `ReadState.md` and `Relayer.md`). For foreground delivery, mirror `HybridRelayerTransport` / `WSRelayerTransport` WebSocket auth and wire parsing.
