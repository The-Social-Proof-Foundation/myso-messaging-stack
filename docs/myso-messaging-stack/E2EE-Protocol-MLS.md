# E2EE Protocol: MLS layer (M4)

Normative for groups whose on-chain `data["e2ee"]` is `mls1`. Implementation: `mls/` (`myso-mls`,
OpenMLS 0.9.2, ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`), shared by the relayer
(native), web + Node agents (WASM) and iOS. Spike numbers: [MLS-Spike.md](./MLS-Spike.md).

## Layering

```
CEv2 envelope (E2EE-Protocol-v2.md)
  └─ AES-256-GCM with the MyData DEK + message AAD   (on-chain MessagingReader gate)
       └─ MLS application message                     (per-message keys: FS + PCS)
            └─ relayer row: encrypted_text = MLS bytes, wallet signature over them (v1/v2 canonical)
```

The MLS group id is the UTF-8 bytes of the lowercase on-chain group id.

## Device identity

Each device has its own MLS signature key (`DeviceKeys`, persisted in platform secure storage).
Its MLS credential identity is a **device certificate** (JSON):

```json
{ "v": 1, "wallet": "0x…", "device_id": "…", "mls_key": "<hex ed25519 pubkey>",
  "issued_at_ms": 1700000000000, "sig": "<hex>", "signer_key": "<hex flagged key | 05>" }
```

`sig` is the wallet's personal-message signature over
`myso-mls-device-v1:{wallet}:{device_id}:{mls_key}:{issued_at_ms}`, in request-auth encoding
(ed25519 raw signature with `00…` key, or full zkLogin signature with `05`).

`wallet` is the account the groups list as the member. For zkLogin that is the zkLogin address
(signed with the proof wrapping the ephemeral key's signature), never the ephemeral key's address.

A member is **authorized** iff its certificate names its leaf signature key, the wallet signature
verifies (ed25519 locally; zkLogin via a fullnode, never the relayer), and the wallet holds
`MessagingReader` on-chain.

**Verification is tri-state.** `valid` is cached permanently for that exact certificate + proof
(digest over every field incl. `sig`). `invalid` means provably wrong: bad signature, or a zkLogin
proof for another address or rejected while still inside its `max_epoch`. `unknown` means it can't
be decided now: the fullnode is unreachable, or a zkLogin proof is past `max_epoch` and this device
never verified it while it was fresh. Only `invalid` leaves are removed. `unknown` leaves are kept,
but sends to that group pause (`MlsMembersUnverifiedError`; the apps retry, then explain). A
legitimate member is never removed because of an outage or proof expiry.

## Certificate renewal: v2 certificates + on-chain device registry

A v1 zkLogin certificate can't be verified once its proof is past `max_epoch`. v2 fixes this
without ever needing a new proof.

**Registry.** `messaging::mls_device_registry` (myso-core `crates/myso-framework/packages/messaging`)
holds one record per `(owner, device_id)`: `authority_key` (ed25519), `previous_key` +
`previous_valid_until_ms`, `generation`, `registered_at_ms`, `revoked_at_ms`. The `MlsDeviceRegistry`
object is derived from `MessagingNamespace` (key `mls_device_registry`): new chains create it in
`create_genesis_objects`, an existing chain once via `messaging::create_mls_device_registry`.

| Call | Sender | Purpose |
|---|---|---|
| `register(device_id, authority_key)` | the account (zkLogin: proof checked by the chain) | Once per device id; sponsored gas |
| `rotate(new_key)` | the device's current authority key address | Replace the key; old one verifies for 7 days |
| `revoke_by_device(device_id)` | an active device of the same account | Revoke another device, or itself (logout) |
| `revoke(device_id)` | the account | Revoke a device |

Revocation is permanent for that device id (a retired device comes back under a new id). One
authority key can't serve two devices.

**v2 certificate.** `{ "v": 2, "wallet", "device_id", "mls_key", "issued_at_ms",
"authority_key", "sig", "signer_key": "authority" }`. `sig` is the authority key's raw ed25519
signature over
`myso-mls-device-v2:{wallet}:{device_id}:{mls_key}:{issued_at_ms}:{authority_key}`.

A v2 certificate is valid iff the signature verifies, the record exists and isn't revoked, and
`authority_key` is the current key or the previous one inside its grace window. Not registered:
`invalid`, or `unknown` for 10 minutes after issue (fullnode lag). Chain unreachable: `unknown`.

**Caching can't outlive a revocation.** v1 `valid` results are cached permanently (v1 has no
revocation). For v2 the registry answer is trusted for 1 hour, then re-read. If the chain can't be
read, the last answer is used for at most 24 hours, then it's `unknown` (sends pause; nobody is
removed). A revocation therefore takes effect within an hour when the chain is reachable, and never
later than a day.

**Device lifecycle (`MlsSession.maintain`, iOS `maintain`; on open, then every 6 h).**
1. Create an authority key (sealed with the rest of the MLS state) and register it. The account
   signs this one transaction; if it can't right now (zkLogin proof expired) the device keeps its
   v1 certificate and retries after the next sign-in.
2. Every 90 days, rotate the authority key, signed by the current key. The new key is saved as
   *pending* first, so a crash between the transaction and the local save is resolved against the
   chain next time.
3. Issue a v2 certificate under the current key, replace the device's MLS credential
   (`Device::with_identity`), retire and republish KeyPackages, and commit `update_credential` into
   every group (and the self-group) whose leaf still carries an older certificate.
4. If the registry says the device is revoked, or holds another key for its id: log the device out
   of MLS and start a new device under a new id.

Logout revokes the device on-chain with its own key. Another device can revoke a lost one
(`revokeDevice` / iOS `revokeDevice`).

**Rollout.**
1. Ship the framework with the new module.
2. On an existing chain, call `messaging::create_mls_device_registry(namespace)` once.
3. Allow the gas pool to sponsor `mls_device_registry::{register, rotate, revoke_by_device}`;
   authority-key senders hold no gas.
4. Ship clients, then turn on `VITE_MLS_DEVICE_REGISTRY=true` (web) and Info.plist
   `MLS_DEVICE_REGISTRY=YES` (iOS). Clients verify others' v2 certificates whether or not their own
   flag is on.

On localnet sponsored gas is off, so authority-key transactions need the authority address funded.

## Membership rule (the chain decides)

Any MLS member can technically add devices, so clients enforce:

1. Before encrypting, catch up on the log, then check every leaf. Commit `remove_leaves` for
   unauthorized ones first. **Never encrypt to a group containing an unauthorized or unverified
   leaf.** Check and encrypt run as one step (nothing can land in between).
2. On-chain `MemberRemoved` makes that wallet's leaves unauthorized, so rule 1 removes them. The
   DEK still rotates as before.
3. Adds use KeyPackages claimed from the relayer. The adder verifies each claimed KeyPackage's
   certificate itself (wallet + device id must match what was claimed; the relayer isn't trusted
   for this) and re-checks the member list on every retry, so a lost race never re-adds a device.

## Relayer (delivery service)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/mls/key-packages` | wallet | Device uploads ≤ 50 KeyPackages + its certificate. The relayer verifies the wallet signature and that every KeyPackage carries exactly that certificate. Keeps ≤ 100 unclaimed per device |
| `POST /v1/mls/key-packages/claim` | wallet | One single-use KeyPackage per device for up to 64 wallets |
| `POST /v1/groups/:id/mls/welcomes` | group | Hand a Welcome to named devices of current on-chain members |
| `GET /v1/mls/welcomes?device_id=` | wallet | This device's Welcomes, deleted once returned |
| `POST /messages` `kind=commit` | group | Commit in the ordered log. The relayer reads the cleartext header and accepts exactly one commit per epoch (`409` for later ones: process the log, then retry) |
| `POST /messages` `kind=message/event` | group | MLS application messages (unchanged row shape) |

Commits are control rows: they never count as unread, never push, and don't consume page limits.
The relayer stores no MLS secrets; it learns group id, epoch, and message type from framing.

## Client processing

Process rows strictly in relayer order. Commits advance the epoch; application messages yield the
DEK-sealed envelope, which is DEK-decrypted, verified and **stored locally** (MLS keys are single
use, so the relayer copy can't be re-read later). A device's own echoed rows are `Processed::Own`.
Up to 5 past epochs are kept for late messages. Every state-mutating operation on a device runs one
at a time (a serial queue; web also holds the Web Lock, iOS the app-only writer).

**Ambiguous commits.** If posting a commit fails without a clear answer (timeout, lost response),
the client looks for its exact bytes in the log: found = accepted, otherwise roll back and retry.

**Desync recovery (resync).** A device rejoins by external commit (`rejoin_external`: drops local
group state; OpenMLS puts a Remove of the device's old leaf, same signature key, into the commit) when:
- a commit at its current epoch can't be applied, or is its own commit it never applied (rolled
  back after the relayer accepted it: `Processed::Own` for a commit at the current epoch);
- a row arrives from an epoch ahead of its own;
- a commit removed it while it is still an on-chain reader.
If the wallet is no longer a reader, the group is forgotten locally instead. Resyncs are capped at
3 per group per hour, with a 30 s backoff after failures. While desynced, sends are refused.

**GroupInfo freshness.** Besides the committer, the two lowest leaves republish GroupInfo whenever
a sync moves the epoch, so a committer whose response was lost can't stall external joins.

**Joining on demand.** Reads and sends of an `mls1` group the device isn't in first take a pending
Welcome (polled at most every 5 s), else join by external commit. If that isn't possible, the
client reports why (`MlsGroupUnavailableError`: `no-device` = MLS off / another tab owns the device,
`not-joined`) instead of showing an empty thread. A metadata read failure never falls back to a
non-MLS write.

## Multi-device and history (M5)

**GroupInfo.** After every commit it makes, a member republishes the signed GroupInfo:
`POST /v1/groups/:id/mls/group-info` (any `MessagingSender`). The relayer stores it only for the
current accepted epoch. `GET` is limited to on-chain members by group auth.

**New device of an existing member.** The device publishes KeyPackages, then for each of its
wallet's groups fetches the GroupInfo, calls `join_external`, and posts the external commit as a
`commit` row (one per epoch, `409` → refetch and retry). Existing members process it like any
commit, and the membership rule keeps it only if its certificate is valid for an on-chain reader.
It reads messages from the join onward; earlier ones need history sync.

**Self-group (own devices).** Each wallet has an MLS group `self:<wallet>` containing only its own
devices, with its own log and GroupInfo on wallet-auth routes:

| Endpoint | Purpose |
|---|---|
| `PUT` / `GET /v1/mls/self/group-info` | Self-group GroupInfo (current epoch only) |
| `POST /v1/mls/self/messages` | Append an MLS message for `self:<caller>`; commits obey one-per-epoch; other groups' messages are rejected |
| `GET /v1/mls/self/messages?after=&limit=` | Ordered log (≤ 5,000 kept per wallet) |

**History bundles.** Opaque client bytes (an array of locally stored rows: message id, order,
sender, created_at, and the **DEK-sealed** inner ciphertext, so the receiving device still opens
each row through the MyData gate). `myso_mls::history::split` cuts them into ≤ 48 KB chunks:
`{ "t": "myso-history-v1", "bundle", "index", "total", "data" }`. Each chunk is one MLS
application message; `Reassembler` rebuilds bundles in any order.

- **Own new device:** an existing device sends its bundle in the self-group after the new device
  joins it.
- **Share recent history (opt-in):** after adding a member, the adder may send a bundle of the
  last N days as `event` rows in the chat group, with chunks as the MLS plaintext. Existing
  members ignore bundles they already hold.

**Logout.** The device posts `leave()` (a self-remove proposal) as a `commit` row (proposals don't
move the epoch), in every chat group and in its self-group. The next member to act calls
`commit_pending` and posts that commit (in the self-group: the wallet's next device to sync). The
device also calls `DELETE /v1/mls/devices/:device_id` (the signature binds the device id) so its
unclaimed KeyPackages can't be used to re-add it.

**Self-group membership.** On every self-group sync a device removes leaves that aren't verifiably
its own wallet's devices, commits pending logouts, and only sends history when every other device
verified. The first device claims epoch 0 with a commit, so two first devices can't both create it.

## New groups (M7)

Every new chat is an MLS group from the start. There is no migration: existing (v1 / v2) chats
keep working as they are.

- **Atomic flag.** The creating transaction builds the group with the returning `create_group` /
  `create_wallet_group`, calls `insert_group_data(e2ee, mls1)`, then shares the three objects. The
  group never exists without its flag (SDK `createAndShareGroup({ groupData })`,
  `buildOpenPaidDm({ groupData })`; iOS `submitCreateAndShareWalletGroup`, paid-DM PTB).
  Agent rooms are created by the agent's key, which has no `MetadataAdmin` (the principal does),
  so they use `messaging::create_agent_group_with_e2ee` (writes `e2ee` while the group is built,
  accepts only `v2` / `mls1`); SDK `createAgentAndShareGroup({ e2ee })` / `createAgentGroup({ e2ee })`,
  `openAgentPaidDm({ e2ee })`. The agent's own MLS device is started before the room is set up,
  so it's added at once; otherwise it joins on its first reply.
- **Race-safe setup** (`MlsSession.createGroup` / SDK `setupMlsGroup`, iOS `setUpGroup`). First,
  take a pending Welcome or join an existing MLS group by external commit. Otherwise, claim epoch 0
  with a commit before publishing anything. The relayer accepts exactly one commit per epoch, so
  one device wins and the rest join it. A claim is refused once the group has any commit, so a
  late setup can never fork a group. The winner publishes GroupInfo and adds every device of the
  on-chain readers.
- **Who sets it up.** The creator tries right after creating, retrying while the relayer learns the
  new group's membership. If that never finishes, the first member to open the chat does
  (`ensureGroup` bootstraps when no GroupInfo exists).
- **Archive recovery** returns nothing for `mls1` groups: archived rows are MLS ciphertext whose keys
  were used up when first read; the readable copies live on devices (and in history sync).
- MLS is on by default (web `VITE_MLS_ENABLED=false`, iOS `MLS_ENABLED=NO` to turn it off).

## Agents as MLS devices (agents app, MCP)

Every agent is a member of its rooms with its own MLS devices, certified by the agent's key.
- **Browser (myso-agents-app):** one device per agent per browser, `web-…`. It uses an IndexedDB
  store sealed under a non-extractable key and a Web Lock `myso-mls:<agent>` (one tab), and the
  session is opened once per page and shared by every messaging client for that agent
  (`attachMlsSession`; a second live session would fork the state).
- **Hosted (MCP / automation bridge):** one device per agent, `mcp-<agent address>`, opened per
  tool call for `mls1` rooms only. Its state is one blob on the memory server
  (`/api/messaging/mls/{lease,lease/renew,lease/release,state}`, agent-authenticated), sealed with
  `HKDF(sign("myso-mls-state-seal-v1:<agent>:<device>"))`. That needs a deterministic signer, which
  is checked. Exactly one holder at a time: a 60 s lease, renewed while working. Writes need the
  live lease and the expected version, and device state is written through before anything is
  posted, so a crashed holder can't leave a posted message whose ratchet advance was lost (a
  takeover from older state would reuse AES-GCM nonces). Hosted devices keep the newest 500 rows
  per room. SDK: `withHostedMlsStore`, `deriveHostedSealKey`, `SnapshotMlsStateStore`.
- **Rooms** created through `messaging.create_group.v1` use `create_agent_group_with_e2ee(…, "mls1")`
  then share, in one transaction. The first member to open or send sets the MLS room up.
- **Reads** of MLS rooms (`getRoomMessages`, `getMessage`) come from the device's store, verified
  against the MLS sender. In v2 / MLS rooms, edits and deletes are encrypted events, confirmed by
  sending the event, not by re-reading the row.
- The WASM ships as `@socialproof/myso-mls` (`mls/npm`, `mls/scripts/build-npm.sh`), with a browser
  build and a Node build behind conditional exports.

## Passkey message backup (M8)

Optional, off by default. MLS keys are single use, so readable history lives only on devices; this
keeps it recoverable on a brand-new device. It trades some forward secrecy for recoverability
(whoever holds the passkey can read back past messages they could already read), hence opt-in.

**Key.** The account's `mysocial.network` passkey (the same one the wallet vault uses, user id
`SHA-256(wallet)`) is evaluated with the WebAuthn PRF extension and salt
`SHA-256("mysocial/messaging-backup-prf/v1")`, which is independent of the wallet-vault PRF. Then
HKDF-SHA256 (salt `mysocial/messaging-backup/v1`) derives:
- `key = HKDF(prf, info "key:" + wallet, 32)`, used for AES-256-GCM;
- `keyId = hex(HKDF(prf, info "id:" + wallet, 16))`, which is public.

The key is kept on the device, sealed with the rest of the MLS state. The passkey is prompted
only when backup is turned on (including on a new device).

**Segment.** `"MBK1" || nonce(12) || AES-256-GCM(key, flags(1)=0 || bundle, aad)`, with
`aad = "myso-backup-v1:" + wallet + ":" + keyId`. `bundle` is the history-sync row format
(`{ v: 1, groups: { id: rows } }`), and every row is still DEK-sealed. Reading a backup therefore
needs the passkey **and** on-chain reader access (the MyData gate). Segments hold at most about
512 KiB of plaintext.

**Relayer** (wallet auth; sees only sizes, timing and `keyId`):

| Endpoint | Purpose |
|---|---|
| `POST /v1/mls/backup/segments` `{ key_id, body }` | Append (≤ 768 KiB; per wallet ≤ 20,000 segments / 512 MiB, `409` when full) |
| `GET /v1/mls/backup/segments?key_id=&after=&limit=` | The caller's segments under that key, in order |
| `DELETE /v1/mls/backup/:key_id` | Delete them (backup turned off) |

**Incremental.** A per-group cursor (sealed, per `keyId`) records the highest order backed up.
Devices upload rows past it every 15 minutes (web), or after syncs and launches, throttled to
15 minutes (iOS). Turning backup on first restores every segment (de-duplicated by
`(order, messageId)`, imported as trusted: only the passkey holder could have produced them), then
moves the cursor past what the backup already holds, then backs up the rest. A different passkey
means a different `keyId`, so it sees nothing. The format is shared byte-for-byte between the TS
SDK (`mls/backup.ts`) and iOS (`MessagingMlsService`).

## Client integration (M6)

**One code path per platform, same crate everywhere.**

| | TS SDK / web | iOS |
|---|---|---|
| Binding | `wasm-pack` (`mls/pkg`, `pnpm build:mls`), passed into `client.messaging.openMlsSession` | `mls/scripts/build-xcframework.sh` → `myso-swift-kit` product `MySoMLS` |
| Session | `MlsSession` (`src/mls/session.ts`) | `MessagingMlsService` (actor) |
| State at rest | `IndexedDbMlsStore`: every record AES-GCM sealed under a non-extractable key, record id in AAD | `Application Support/MessagingMLS/<wallet>/` sealed with the `MessagingVault` key |
| Single writer | Web Lock `myso-mls:<wallet>` (other tabs wait) | App only; the NSE never loads MLS state |
| Switches | `VITE_MLS_ENABLED`, `VITE_MLS_NEW_GROUPS` | Info.plist `MLS_ENABLED`, `MLS_NEW_GROUPS` |

- **Reads** (`getMessages`, `subscribe`; iOS `fetchMessages`, group-feed `message.created`) sync the log
  in order and serve unwrapped rows from the local store, so the DEK decrypt and UI code is unchanged.
- **Sends** pick the sender's own session (agents are separate certified devices), run the
  membership rule, wrap, post, then store their own inner row.
- **Commits** snapshot first and roll back on `409`, then catch up and retry.
- **Rollout:** ship the relayer (migrations `025`, `026`), then clients with MLS enabled, then turn on
  MLS for new groups. Release iOS builds need the XCFramework hosted (zip + checksum) like `MySoContraFFI`.
- **Tests:** Move (`myso move test -e localnet` in myso-core `packages/messaging`), crate (`cargo test` in `mls/`), SDK renewal (`test/unit/mls-renewal.test.ts`, `mls-registry-chain.test.ts`), SDK sessions on real WASM against an epoch-ordered fake
  relayer (`test/unit/mls-session.test.ts`), and a live run against the real relayer router
  (`relayer/examples/mls_e2e_server.rs` + `pnpm test:mls-relayer`): two members, a second device,
  own-device history, a commit race, on-chain removal, logout, and a stale device resyncing.
