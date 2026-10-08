# Plan: make passkeys an optional custody upgrade for agents

Status: **being implemented**. Scope: `chat-app` (browser SPA) + `myso-memory` (`packages/sdk`, `services/server`).
Related: `myso-memory/docs/security/agent-key-backups.md` (custody contract), `chat-app/docs/SYSTEM_DESIGN.md` (ADR-2).

## 0. Implementation status

| Phase | State | Artifacts |
|---|---|---|
| 0 — docs/security contract | done | `myso-memory/docs/security/agent-key-backups.md` (tier table, canonical-empty rules, config block, routes, lifecycle, per-tier recovery); `chat-app/README.md` stale derivation replaced and custody documented in the env tables + agent chat lifecycle; `chat-app/src/lib/agents/legacy-agent-keys.ts` comment states the no-derived-seed invariant and the tier contrast |
| 1 — SDK v2 wraps | done | `myso-memory/packages/sdk/src/agent-key-envelope.ts` (`ROOT_WRAP_VERSION`, `CUSTODY_METHODS`, `CustodyBinding`, `RecoveryRootWrapV2`, `normalizeCustodyBinding`, `rootWrapV2AAD`, `wrapRecoveryRootV2`/`unwrapRecoveryRootV2`/`unwrapAnyRecoveryRoot`, `isRecoveryRootWrapV2`, `deriveZkLoginRootSecret`, `deriveRecoveryCodeSecret`, `formatRecoveryCodeParams`/`parseRecoveryCodeParams`, `generateDeviceWrapSecret`); `packages/sdk/src/agent-key-backup-client.ts` (`ownerChallenge`/`ownerVerify`, `getRoot`/`getRootV1`/`putRoot`, `listRoots`, `getCustodyPolicy`/`putCustodyPolicy`, `CustodyPurpose`); `packages/sdk/test/agent-key-root-wrap-v2.test.ts` |
| 2 — memory server | done | migration `015_agent_custody_tiers.sql`; method-aware `VaultSession` (with legacy `credential` compat) and `vault()`; purpose-bound owner challenge v1/v2 plus custody vault tokens; `custody_limit` per-account throttle and `custody_audit` events; v2 root-wrap validation with method-conditional canonical-empty rules; wrap PUT authorized by an already-active method; `recovery-roots` + `custody-policy` routes; tier config + capability flags; `custody_last_method` guard; sidecar accepts the v2 prefix; unit test `custody_root_wrap_key_sets_are_strict` and the extended `#[ignore]` PG/Redis integration test |
| 3 — client vault | done | `chat-app/src/lib/agents/custody-vault.ts` (`CustodyVault`, `CUSTODY_TIER_INFO`, login-seed provider, tier unlock/adopt/remove, `upgradeToPasskey`); `passkey-vault.ts` kept as a compatibility re-export; `AgentKeyVaultContext.tsx` builds the vault with a lazy `SHA256(sub + '_' + salt)` seed provider; `custody-vault.test.ts` |
| 4 — agent-management UI | done, revised in §0b | `PasskeyVaultPanel.tsx` → custody panel (`AgentSecurityPanel`, alias exported) with unlock-per-tier, configured tiers + tradeoffs, remove guards, passkey management, drafts/setups; tier chooser inline in `CreateAgentDialog`; all 19 gates reworded to "agent keys" (profile drawer, chat, memory reply, dev panel, registration hooks). §0b removes the tier chooser again: the panel is the always-on login holder plus an optional passkey backup |
| 5 — config/docs | done | `chat-app/src/vite-env.d.ts` (`VITE_AGENT_CUSTODY_TIERS`, `VITE_PASSKEY_CONNECT_ORIGINS`), `chat-app/.env.example`, `myso-memory/services/server/.env.example`, `myso-memory/docs/reference/environment-variables.md` (all backup/tier variables, limiter semantics), `chat-app/docs/SYSTEM_DESIGN.md` ADR-7 (appended byte-safely — that file is not valid UTF-8) |
| tests | written, not run | `packages/sdk/test/agent-key-root-wrap-v2.test.ts`; server unit test `custody_root_wrap_key_sets_are_strict` (plus `owner_auth` message-format tests) and the extended `#[ignore]` integration test; `chat-app/src/lib/agents/custody-vault.test.ts`; `chat-app/tests/passkey-vault.browser.spec.ts` updated for tier detection; new `custody-login.browser.spec.ts` + harness/html for the no-passkey path. Compile checks pass: `tsc --noEmit` clean for the SDK source and both SDK test files, `tsc --noEmit -p tsconfig.app.json` clean for the chat-app (including the new unit tests), and `cargo check --all-targets` exit 0 for the memory server (including the new test targets). The only type errors reachable anywhere are pre-existing nullability looseness in the untouched fixture body of `tests/passkey-vault.browser.spec.ts`, which the project does not typecheck |

Known gaps to close in follow-up work:

- Pinned reference bytes for the v2 root-wrap AAD are not published yet (the v1 analogue lives in `packages/sdk/test/agent-key-envelope-vectors.json`). `agent-key-root-wrap-v2.test.ts` asserts behaviour plus the BCS domain prefix and per-field AAD binding, but not frozen hex; generate and pin the hex from a verified run so the v2 contract is frozen the way v1 is.
- `device-key-v1` exists in the SDK and server but is intentionally not surfaced in the chat-app UI and is not in the default tier list.
- New passkey enrollments keep the v1 wrap format (byte-compatible with existing records); v2 is dual-read. Migrating passkey wraps to v2 is optional follow-up.
- Per-agent mixed tiers (multiple roots) remain deferred (D2): one root per account, any number of unlock methods. Consequently there is no per-row tier badge on agent rows: the active tier is an account-level property, shown once in the custody panel rather than repeated on every agent.
- The per-account limiter counts one increment per challenge plus one per custody-purpose verify, so the default of 10 is roughly three or four unlocks per minute per account; raise it for test suites that unlock repeatedly. After the §0b revision, reads (`availableTiers`, `listPasskeys`, `custodyPolicy`) reuse one cached owner token, so only a real unlock spends the limited pair.
- The rollout flip in Phase 5 (agents reachable with backups enabled by default) is a deployment decision, not a code change made here.

## 0b. Revision: the login tier is the holder, the other tiers are optional

The tier work above shipped with three tiers presented as peers and a preference heuristic
(`detectTier`) that still picked a passkey first. That contradicted the goal in §1 and left several
broken paths. The client now enforces one rule: **`zklogin-root-v1` always holds an account's agent
keys; every other method is an optional extra wrap of the same root.**

Client changes (all in `chat-app`; the SDK and server contracts are unchanged):

| # | Before | Now |
|---|---|---|
| 1 | `detectTier` preferred `passkey-prf-v1` whenever a passkey wrap existed (`custody-vault.ts:226`) | `PRIMARY_CUSTODY` is the default in `unlock()`; a passkey is used only when the account has no login wrap |
| 2 | `unlock()` threw "Passkeys need a supported browser on HTTPS" on a device without WebAuthn (`:216`, `:170-174`) | `unlock()` never requires WebAuthn; only the passkey paths do, and they set a plain error instead of a vault status |
| 3 | `unlockWithPasskey` could mint a brand-new root through `enroll(false)` (`:247`, `:382`) | a passkey only ever wraps the root already in memory (`enrollPasskey`); a root comes from the login tier alone |
| 4 | `detectTier` opened an owner session, then the unlock opened another (`:166`, `:244`, `:324`) | one owner token is cached for its `expires_in`; reads (`availableTiers`, `listPasskeys`, `custodyPolicy`) share it |
| 5 | `createTierWrap(mintRoot=false)` zero-filled the live root, so adopting a second path broke every later decrypt | the root buffer is only zeroed when it is actually replaced |
| 6 | `removeCustodyMethod('zklogin-root-v1')` was allowed | the login holder is not removable; only optional paths are |
| 7 | panel offered three equal tiers, a recovery-code button and a first-run "Use a passkey" that always threw | panel is "Your MySocial login - always on" plus an optional passkey backup; recovery-code stays implemented but is not surfaced |
| 8 | `VITE_AGENT_CUSTODY_TIERS` was declared and documented but never read | removed from `vite-env.d.ts`, `.env.example` and `README.md`; the server's `GET /config` tier list is authoritative |
| 9 | passkey-only accounts (pre-existing data) had no migration | `unlock()` opens them with the passkey and then adds the login holder automatically (`ensureLoginHolder`, reported via `loginHolderMissing`) |

Not done here (deliberately): true 2FA (login **and** passkey) needs a combined-secret custody
method in the SDK and server; and a server-side rule refusing a first root with no `zklogin-root-v1`
wrap would make the invariant enforceable outside this client. Both are follow-ups in `myso-memory`.

## 1. Goal


Today an agent cannot be created, unlocked, or used in the chat app without enrolling a
WebAuthn PRF passkey. The goal is:

- **zkLogin is the default custody root.** A signed-in user with MySocial (Google/Apple/etc.)
  can create, unlock, and use agents with **no passkey at all**, on any device, exactly as they
  recover their wallet today.
- **Passkeys become an optional upgrade** — strictly stronger custody that the user opts into
  (as a primary tier or as an additional unlock path alongside the login root).
- **No agent key material becomes server-readable.** The Memory server still stores only
  ciphertext; it learns nothing new that lets it decrypt envelopes on its own.

Non-goals (this plan does not do these): on-chain agent key rotation (impossible today — see
§3.5), migrating existing agents between roots, or changing the messaging/encryption stack.

## 2. Why the current design requires a passkey (verified)

| Fact | Where |
|---|---|
| Agent seeds are random Ed25519 seeds, encrypted under a random per-account 32-byte recovery root | `myso-memory/packages/sdk/src/agent-key-envelope.ts:100-125` |
| The recovery root is wrapped under a WebAuthn **PRF output** | `agent-key-envelope.ts:126-134` |
| Every envelope/root read requires a **vault token**, minted **only** by a verified WebAuthn assertion | `myso-memory/services/server/src/agent_key_backups.rs:108`, `:161`; `owner_auth.rs:103-113` |
| The root-wrap RPC additionally requires `credentialId == vault credential`, `rpId == PASSKEY_RP_ID`, and `prfInput == stored prf_input` | `agent_key_backups.rs:164-176` |
| Exactly one root per `(chain, account)`; one wrap per credential, all wraps of that root | `agent_key_backups.rs:177-198`; migration `myso-memory/services/server/migrations/014_agent_key_backups.sql` |
| The owner session (15 min) is established by a **zkLogin or native personal-message signature** — passkeys are *not* used to prove ownership, only to carry the vault token | `agent_key_backups.rs:17-18`; `services/server/scripts/key-backup.ts:7-17`; `owner_auth.rs:114-126` |
| The security doc states the exclusion explicitly: "OAuth claims, salt-service values, zkLogin ephemeral keys, tokens, and service secrets are never derivation inputs" and "There is no OAuth/password/server-secret fallback" | `myso-memory/docs/security/agent-key-backups.md:47`, `:100` |
| The client's login key IS deterministic and cross-device today: `SHA256(sub + '_' + salt)` → Ed25519 seed, salt fetched from the salt service with a Bearer access token | `chat-app/src/lib/derive-mysocial-keypair.ts:23-42`; `chat-app/src/lib/zklogin-signin.ts:323-345` |

So the passkey is not an arbitrary extra layer — it is currently the **only** mechanism that can
produce a vault token. But the design conflates two separable things:

1. **Authorization** to fetch stored ciphertext (a server policy decision), and
2. **Custody** of the root that decrypts it (a client secret).

zkLogin already satisfies (1). This plan makes (2) pluggable, so (1) stops forcing a passkey.

## 3. What zkLogin gives us, and what it does not

### 3.1 The universal root

The chat app already derives a stable Ed25519 keypair from `SHA256(sub + '_' + salt)`
(`derive-mysocial-keypair.ts:29`), verified against the session wallet address. The salt is
stored per user by the salt service (`zklogin-signin.ts:323-345`), so after any OAuth re-login
on any device the same 32 bytes come back.

**Therefore a custody root can be wrapped under `HKDF(login-key-seed, domain-separated AAD)`
with no passkey, no WebAuthn support, and no platform-specific authenticator.**

Critical correction to a common assumption: you *cannot* use "sign a fixed message and derive
from the signature" here. zkLogin signs with a fresh ephemeral key plus a proof, so signatures
are **not deterministic** across sessions. The deterministic secret is the derived keypair
itself, which is why the wrap must use it directly as HKDF input rather than a signature.

### 3.2 The honest security level of each tier

- **Login-root tier (new default):** an agent key is exactly as recoverable as the wallet
  itself. Anyone who can complete OAuth for the account, or who holds a valid JWT/refresh token
  plus salt-service access, can derive the root and decrypt backups — but that same attacker can
  already derive the wallet key and move funds. The tier does not lower the bar below the
  account's existing bar; it just stops vault custody from being *higher* than the wallet.
  Residual risk to state in the UI: the **salt service operator** can reconstruct the root.
- **Passkey tier (existing):** custody is independent of the OAuth provider; the root secret
  never leaves the authenticator, so neither the salt service nor the Memory server can
  reconstruct it. Cost: losing all passkeys = losing the backups.

Neither tier makes the Memory server able to read envelopes by itself: it holds ciphertext,
and the login-root tier additionally needs the salt + subject from the salt service.

### 3.3 A third, still-universal option worth shipping in the same shape

`recovery-code` tier: root wrap secret = `HKDF(login-key-seed, Argon2id(user code))`. The user
gets cross-device recovery with a printed/exported code, and neither the salt service nor the
Memory server alone can unwrap. This is the only non-passkey tier that resists a salt-service
compromise, so it is the recommended "portable recovery" answer for users who cannot or will
not use a passkey.

### 3.4 Tier matrix

| Tier | Secret that unwraps | Needs WebAuthn? | Cross-device | Recoverable after logout | Salt service can reconstruct | Server can reconstruct |
|---|---|---|---|---|---|---|
| `device-key-v1` | device-stored random wrap key (IndexedDB/Keychain), nothing on server | no | no | no | no | no |
| `zklogin-root-v1` | `SHA256(sub+salt)` login key | no | yes (OAuth re-login) | yes | yes | no (needs salt service) |
| `recovery-code-v1` | login key **+** user-held code | no | yes (login + code) | yes | no | no |
| `passkey-prf-v1` (existing) | WebAuthn PRF output | yes | yes (same credential/PRF) | yes | no | no |

### 3.5 Why the default must be recoverable: the chain cannot re-key

`memory::SubAgent` stores `public_key: vector<u8>` and `derived_address: address`. Canonical
source: `myso-core/crates/myso-framework/packages/myso-social/sources/memory.move:377-400`
(struct), `:1538-1579` (`register_sub_agent`), `:1581-1622` (`register_sub_agent_delegated`),
`:1624-1661` (`update_sub_agent`), `:1696-1710` (`revoke_sub_agent`). (`move/packages/ref_social_contract/sources/memory.move`
in this repo is a stale pre-sub-agent copy — do not cite it, and `myso-memory` contains no Move
package at all.) The vendored copy used by the messaging package is
`move/packages/messaging/build/messaging/sources/dependencies/MySocialContracts/memory.move`.

No entry function ever writes `public_key` or `derived_address` after registration:
`update_sub_agent` rewrites identity_class, role_tags, capabilities, delegatable_caps,
register_scope, constraints, platform_scope and expiry only, and no capability grants key
change. Re-keying is **structurally** blocked, not merely unimplemented:

- `derived_address` is a hash of the public key (enforced off-chain by
  `myso-memory/services/server/src/myso.rs:10-16`, `:50-61`, `:140-162`), so a new key is a new
  address and therefore a new agent identity.
- `derived_object::claim` (`myso-core/.../myso-framework/sources/derived_object.move:39-48`)
  can never be reused once the object is deleted, and `revoke_sub_agent` deletes the UID — so
  even "revoke and re-register the same address" is impossible forever.
- Any local re-key would break the agent's `x-public-key`/`x-signature` auth on the Memory
  server (`services/server/src/auth.rs:78`, `:439-445`).

Losing custody therefore permanently strands the agent's on-chain identity, chats, memories,
descendants, permissions and approvals (`docs/security/agent-key-backups.md:102`).

Consequence for product: a passkey-only default is a footgun for mainstream users. Defaulting to
the login root and offering passkeys as an upgrade is the failure-mode-correct order.

### 3.6 What "the login root" actually is at runtime (and what the user must still have)

Two different keypairs are involved today and the plan must not conflate them:

- **Owner-challenge signature** (authorization): in a zkLogin session this is signed by the
  session's **ephemeral** Ed25519 key and wrapped into a full zkLogin signature carrying a
  prover-built proof and `maxEpoch = loginEpoch + 30`
  (`chat-app/src/lib/zklogin-signin.ts:217-226`, `:370-374`, stored in **sessionStorage** under
  `mysocial_zklogin_current`, cleared on logout `:228-233`). The sidecar epoch-checks it
  (`services/server/scripts/key-backup.ts:10-14`). In a non-zkLogin OAuth session the same
  challenge is signed by the salt-derived identity keypair
  (`AgentKeyVaultContext.tsx:57-59`). So a login-root unlock can require "sign in again" when the
  proof window has lapsed — exactly the friction the vault already has today, not a regression.
- **Wrap secret** (custody): `SHA256(sub + '_' + salt)[0..32]`
  (`derive-mysocial-keypair.ts:29-31`). Because `getSaltFromSession` short-circuits on the salt
  cached in the auth-session blob in localStorage (`get-salt-from-session.ts:60-62`,
  `mysocial-auth-storage.ts:7`), the wrap secret is re-derivable **offline** once the user has
  logged in on that device, and on a brand-new device after OAuth re-login + salt fetch.

Hardening implication: the salt service stores `user_identifier` (`"{iss}:{sub}"`) and `salt` in
plaintext in one row (`myso-salt-service/migrations/008_zklogin_salts.sql`), so it holds both
halves needed to compute that seed — and `GET|PUT /zklogin-salt` currently has **no rate limiting
or attestation** (rate limits exist only on `/auth/provider/callback` and the passkey wallet-vault
lookup). Enabling the login-root tier should be gated on adding throttling there, or on an
explicit, written acceptance that the tier's custody equals the wallet's (which is the same
secret the wallet depends on anyway).

Prior art worth matching: the salt service **already** models a two-path wrap of a wallet
encryption key — `wallet_vaults` stores `prf_wrapped_wek` **and** `recovery_wrapped_wek` +
`recovery_kdf_salt`, with a consume-once challenge table and a possession proof
(`migrations/006_wallet_vaults.sql`, `wallet_vault_challenges`; handlers
`src/handlers/mod.rs:765-941`). The agent-custody tier model should reuse that established shape
(one root, several independent wraps, possession-proof challenge per unlock) rather than invent a
second pattern.



### D1 — Give the root wrap a custody-method discriminator (v2 AAD)

Add `RecoveryRootWrapV2`:

```
version: 2, algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256',
method: 'passkey-prf-v1' | 'zklogin-root-v1' | 'recovery-code-v1' | 'device-key-v1',
params: { ...method-specific public parameters },
chain, packageId, owner, accountId, rootId, revision, salt, nonce, ciphertext
```

- New AAD domain: `mysocial:agent-root-wrap:v2`; keep `:v1` for existing records.
- `params` per method: `passkey-prf-v1` → `{credentialId, rpId, prfInput}`;
  `zklogin-root-v1` → `{}` (identity is already bound by chain/package/owner/account/rootId);
  `recovery-code-v1` → `{kdf:'argon2id', kdfParams, codeSalt}`; `device-key-v1` → `{}`.
- **Agent envelopes do not change at all.** They are encrypted under the root, and the root is
  re-wrapped per method, so no existing ciphertext is invalidated
  (`agent-key-envelope.ts:110-125` stays as-is).
- Rejected alternative: adding a field to the v1 AAD. The AAD is simultaneously the HKDF `info`
  and the GCM `additionalData` (`agent-key-envelope.ts:93`, `:96`), so any change breaks every
  stored ciphertext and the pinned vector (`packages/sdk/test/agent-key-envelope-vectors.json`).

### D2 — One root, many wraps (generalize the wrap key)

Already the semantics for multiple passkeys: each credential holds an independent wrap of the
same root (`agent_key_backups.rs:178-198`; `chat-app/src/lib/agents/passkey-vault.ts:159-166`).
Generalize the wrap row key from `(chain, account_id, credential_id)` to
`(chain, account_id, method, subject)` so a passkey subject is a credential id and a
zkLogin subject is the account's owner/address. `recovery_roots` stays single-root per account:
this keeps "add a passkey later" a pure re-wrap of the same root, with no envelope re-encryption
and no migration of existing agents.

Per-agent mixed tiers (an agent that must NOT be login-recoverable) is explicitly deferred: it
requires multiple roots per account plus a root selector in the UI. The schema in D2 leaves room
for it (`rootId` is already in the envelope AAD).

### D3 — Generalize vault authorization

- `VaultSession` gains `method` and `subject`: `{account, chain, method, subject}`
  (`owner_auth.rs:32-33`).
- `vault()` (`owner_auth.rs:103-113`) currently validates against `recovery_passkeys`; it becomes
  method-aware: passkey subjects must be an active/non-revoked credential row; login-root
  subjects must equal the session owner; recovery-code subjects must equal the session owner
  (the code factor is client-side and invisible to the server, which is correct — the server
  authorizes the ciphertext, the code authorizes the decryption).
- New mint path for non-passkey tiers: `POST /api/owner/auth/challenge` gains a **purpose**
  parameter, the message format becomes
  `mysocial-key-backup-owner-v2|<origin>|<chain>|<account>|<owner>|<purpose>|<nonce>|<exp>`
  with `purpose = custody-unlock-zklogin-root-v1 | custody-unlock-recovery-code-v1`, and
  `POST /api/owner/auth/verify` mints a `VaultSession` for that method instead of only an
  owner token (`owner_auth.rs:114-126`; sidecar message check
  `services/server/scripts/key-backup.ts:7-17`).
- Keep the existing passkey ceremony path untouched: it remains the only way to mint a
  `passkey-prf-v1` vault token, and `prfOutput` still never leaves the browser.

### D4 — SDK: method-pluggable wrap/unwrap, dual-read

- Add `wrapRecoveryRootV2(secret, root, binding)` / `unwrapRecoveryRootV2(secret, wrap)` and
  `rootWrapV2AAD()`; keep `wrapRecoveryRoot`/`unwrapRecoveryRoot` (v1) intact for records already
  stored, or migrate passkey wraps to v2 behind a feature flag.
- Add new reference vectors for the v2 AAD and for each method's `params` encoding, plus a
  negative vector proving v1 and v2 AADs cannot cross-authenticate.
- `AgentKeyBackupClient` needs: root listing (`GET .../recovery-roots` returning wraps for the
  caller's method), `putRoot(wrap, revision)` using the new key, and a `unlock` helper per method.
  Note the client today takes only `(serverUrl, accountId)` with `ownerToken`/`vaultToken` as
  mutable properties (`packages/sdk/src/agent-key-backup-client.ts:14-18`).

### D5 — Client: `CustodyVault` with pluggable unlock providers

Rename/generalize `PasskeyVault` (`chat-app/src/lib/agents/passkey-vault.ts`) into a vault with an
ordered list of unlock providers:

1. `PasskeyProvider` — what exists today (`unlock`, `addPasskey`, `removePasskey`,
   `assertion`, `enroll`).
2. `ZkLoginRootProvider` — derives the wrap secret from the login keypair already in memory
   (`derive-mysocial-keypair.ts`), requires a MySocial OAuth session (wallet-only sessions cannot
   fetch the salt: `chat-app/src/contexts/MySocialAuthContext.tsx:396`).
3. `RecoveryCodeProvider` — prompts for the user code and mixes it with the login key.

Unlock flow: fetch the wraps the account has for the enabled methods, pick the strongest
available, unlock, and remember which method is active. `prepare`/`finalize`/`getAgent`/
`recoverDraft`/`importLegacy` stay method-agnostic — they only need `this.root`
(`passkey-vault.ts:176-242`).

New lifecycle operations:

- `upgradeToPasskey()` — needs the vault already unlocked (any method), enrolls a passkey, wraps
  the **same** `rootId`. This is today's `addPasskey()` with its precondition relaxed from
  "unlocked by passkey" to "unlocked".
- `downgradeToLoginRoot()` / `removeCustodyMethod(method)` — requires the vault unlocked by
  another method; asserts `rootId` is unchanged; hard-confirms that passkey custody is being
  given up. Server-side, removing the last passkey must no longer be the only way to lose
  access (and must not delete the root).
- `adoptAuthTier(tier, options)` — first-time setup when an account has **no** root yet: choose
  the tier, mint a random root, store the first wrap. This replaces the current
  "unlock or enroll a passkey" bootstrap (`passkey-vault.ts:116-144`).

### D6 — Server policy and capability surface

- Capability flags already exist and are the right extension point:
  `agentKeys.passkeyPrfV1` in `services/server/src/compatibility.rs:85` (gated by
  `ENABLE_AGENT_KEY_BACKUPS`, also surfaced as `agentKeyBackups` in `GET /config`,
  `services/server/src/routes.rs:1683`). Add `agentKeys.zkloginRootV1`,
  `agentKeys.recoveryCodeV1`, and `agentKeys.deviceKeyV1`.
- New server config: `AGENT_KEY_CUSTODY_TIERS` (comma list of enabled methods, default
  `passkey-prf-v1,zklogin-root-v1,recovery-code-v1`), `AGENT_KEY_REQUIRE_TIER` (optional minimum
  for high-assurance deployments — set to `passkey-prf-v1` to reproduce today's behavior exactly),
  and `AGENT_KEY_UNLOCK_PER_MINUTE` (per-account unlock limit, default 10 — one increment per
  challenge plus one per custody-purpose verify, so roughly three or four unlocks per minute).
- Per-account policy record (new migration): `custody_policy(chain, account_id, active_method,
  allowed_methods, updated_at)` so a client cannot silently downgrade an account the operator
  pinned; `PUT /api/accounts/{account}/custody-policy` requires the owner session and, for
  downgrades, an unlock from a method that will *remain* enabled.
- Authorization invariant to preserve: **a wrap may only be replaced by a request authorized by
  an already-active method of the same account**, with the same `rootId`
  (the existing `approved_existing`/`approved_by` logic, `agent_key_backups.rs:181-187`,
  generalized).

### D6b — Abuse controls and audit (new, and required before the tier can be enabled)

The backup routes are mounted on `public_routes` (`services/server/src/main.rs:375-379`), so the
normal auth middleware never applies and the **only** rate limit is the per-IP sponsor limiter
(10/min, 30/hr; `rate_limit.rs:826-941`). There is no per-account throttling, and no audit trail:
grep finds no `tracing::` in `agent_key_backups.rs`/`owner_auth.rs`/`agent_key_setup.rs` and no
`audit_push` reference to these routes.

Moving custody from "possession of a passkey" to "possession of the login" changes the attack
surface, so Phase 2 must add:

- per-account (not just per-IP) throttling for challenge issuance and unlock attempts,
- an audit record for every custody event: tier adoption, wrap added, wrap removed, downgrade,
  and any failed unlock on a non-passkey tier (a spike there is the signal that an account's
  login is compromised),
- and a purpose-pinned signature scheme: the sidecar currently accepts *any* scheme that
  resolves to the owner address (`key-backup.ts:7-17` dispatches on the signature's first byte;
  zkLogin is `0x05`, passkey `0x06`, multisig `0x03`), so the new
  `custody-unlock-*-v1` purposes should assert the expected scheme rather than merely verifying
  a signature over the message.

### D6c — Config hygiene

`ENABLE_AGENT_KEY_BACKUPS` is read ad hoc from the environment in three places
(`main.rs:65`, `main.rs:375`, `compatibility.rs:85`) rather than being a `Config` field
(`services/server/src/types.rs`). Add the tier configuration as real `Config` fields so the
tier list, the required-tier policy, and the per-account limit are validated at startup the way
`owner_auth::validate_config()` already validates RP/origin (`owner_auth.rs:43-65`).

### D7 — Migration and compatibility

- Migration NNN is **additive**: add `method` and `subject` to `recovery_root_wraps`
  (backfill `method='passkey-prf-v1'`, `subject=credential_id`), add `custody_policy`, relax the
  FK to `recovery_passkeys` so non-passkey subjects are legal. Keep the primary key on
  `(chain, account_id, method, subject)`.
- Dual-read: v1 wraps and v2 wraps both unlock the same root; a v1 record is upgraded to v2 on
  the next successful unlock (revision-bumped under `If-Match`).
- The server's strict JSON key-set validator (`agent_key_backups.rs:123-127`) must accept the v2
  field set for root wraps while still rejecting unknown keys — this is the one place where a
  careless change silently 400s the whole feature.
- Server-side `envelope()` treats `prfInput`/`credentialId`/`rpId` as mandatory for root wraps
  (`:134`); that becomes method-conditional.
- Passkey *registration* still requires a passkey ceremony; the difference is that nothing else
  requires one.

### D8 — UX and copy

The complete user-visible gate inventory to convert (all in `chat-app`, all worded
"passkey"/"agent backups"):

| Gate | file:line | Blocks |
|---|---|---|
| master flag | `AgentKeyVaultContext.tsx:12`, `:53` | `VITE_AGENT_KEY_BACKUPS_ENABLED !== 'true'` ⇒ `useAgentVault()` is `null` everywhere (checked-in default is **false**: `.env.example:91`) |
| server flag | `passkey-vault.ts:69-71` | `agentKeyBackups !== true` ⇒ unlock throws |
| panel | `PasskeyVaultPanel.tsx:17`, `:24`, `:29-32`, `:42`, `:56` | unlock/enroll status, "no server recovery fallback" copy, backup-passkey advice |
| create | `CreateAgentDialog.tsx:114`, `:169`, `:182`, `:183` | create agent, disabled Create button, resume saved setups (`vault.pending()`) |
| registration | `useAgentActions.ts:243`, `:302` | root and child registration |
| finish setup | `useAgentActions.ts:176` | memory vault + budget follow-up PTB |
| chat | `useAgentChatActions.ts:266` | starting an agent chat |
| reply | `useAgentMemoryReply.ts:141` | asking an agent's memory / posting its reply |
| model picker | `AgentProfileDrawer.tsx:301-302`, `useDerivedAgentKey.ts:12-16` | per-agent LLM model list/select (silent `data:null` when locked) |
| legacy import | `LegacyAgentBackup.tsx:10,12,21-22` | importing an existing local seed (`importLegacy` also calls `ready()`) |
| dev panel | `AgentDevSendPanel.tsx:67` | dev-only send-as-agent; note its env-credential path (`:75-78`) is the **only** place an agent key enters the app without the vault, and it is the existing proof that the rest of the pipeline works with a vault-free signer |

So: gates become method-agnostic ("Unlock agent keys"), the passkey-specific status/unsupported
copy moves into the Agent security panel, and the master flag becomes a tier list rather than a
boolean. Also rename the server's `"passkey_required"` error code (`owner_auth.rs:104`) and the
client copy that surfaces it.

### D9 — The flag default is itself a gate

With `VITE_AGENT_KEY_BACKUPS_ENABLED=false` and `ENABLE_AGENT_KEY_BACKUPS` unset, there is **no
alternate runtime path at all**: agent creation, agent chat and agent memory replies are
permanently unreachable. Phase 5 should therefore flip the feature to on-by-default with the
login-root tier as the baseline, not merely add a tier behind an existing off-by-default flag.


## 5. Phased execution

**Phase 0 — decisions and guardrails (no code).**
Confirm with product: is the login-root tier acceptable as a default for mainnet (it is a
*downgrade* relative to today's passkey-only custody)? Confirm the recovery-code tier is in
scope. Update the three places that currently state the opposite constraint —
`myso-memory/docs/security/agent-key-backups.md:47`, `:100`, and
`chat-app/src/lib/agents/legacy-agent-keys.ts:58-62` — to the tiered contract, and add a
threat-model table. Decide the salt-service hardening (§3.6). Deliverable: revised security doc +
sign-off.

**Phase 1 — SDK v2 wrap (`myso-memory/packages/sdk`).**
`RecoveryRootWrapV2` type, `rootWrapV2AAD`, `wrapRecoveryRootV2`/`unwrapRecoveryRootV2`, method
param encoders, v1↔v2 negative vectors, new reference vectors; `AgentKeyBackupClient` root
listing + method-aware put. Tests: `packages/sdk/test/agent-key-envelope.test.ts` extended;
vectors file updated. Acceptance: v1 and v2 wraps both unlock the same root in a unit test.

**Phase 2 — server methods + migration (`myso-memory/services/server`).**
Migration (additive), `method`/`subject` in `VaultSession`, purpose-bound owner challenge v2 in
`owner_auth.rs` + `scripts/key-backup.ts`, method-conditional `envelope()` validation, custody
policy endpoints, capability flags, per-account throttling and audit events (§D6b). Tests: extend
the `#[ignore]` PG/Redis integration test `agent_key_backups.rs:287-355` with a login-root unlock,
a cross-method wrap replacement, a downgrade denial, and a `prfOutput`-never-accepted assertion.
Acceptance: an account with zero passkeys can store and fetch envelopes.

**Phase 3 — client vault (`chat-app/src/lib/agents/passkey-vault.ts`, `AgentKeyVaultContext.tsx`).**
Provider abstraction, tier bootstrap, `upgradeToPasskey`, `removeCustodyMethod`, method-aware
`lock()`/idle behaviour, error copy. Keep the existing invariants: no root or signing key in
query caches, localStorage or sessionStorage (`passkey-vault.ts:37`), and the 15-minute idle
lock plus lock-on-unmount (`AgentKeyVaultContext.tsx:66-73`). Tests: unit tests for each provider's
secret derivation and cross-tier unlock; extend `chat-app/tests/passkey-vault.browser.spec.ts`
with a no-passkey browser run.

**Phase 4 — agent management UI.**
Tier chooser on first agent creation, Agent security panel, method-agnostic gates (§D8),
tier badge on agent rows, `LegacyAgentBackup`/`useDerivedAgentKey` retirement path
(`chat-app/src/components/agents/LegacyAgentBackup.tsx`,
`chat-app/src/hooks/agents/useDerivedAgentKey.ts`, `chat-app/src/lib/agents/legacy-agent-keys.ts`)
— the legacy path must keep working until its migration tooling is replaced, and its comment
("Never use this for new agents... the signer may be ephemeral, and OAuth subject/service-salt-derived
roots can be reconstructed by the service", `legacy-agent-keys.ts:59-62`) becomes the exact
tradeoff text shown for the login-root tier.

**Phase 5 — rollout.**
Ship behind `agentKeys.zkloginRootV1` + `AGENT_KEY_CUSTODY_TIERS`; default stays passkey-only for
one release, then flip the default to login-root with passkey upsell. Instrument: tier
distribution, upgrade rate, unlock failures per method. Localnet walkthrough per
`agent-key-backups.md:144` (create root/child, ask memory, reply, refresh/logout/recover with each
tier, downgrade, revoke between prepare/submit).

## 6. Test and doc surface to update

`myso-memory`:

- `packages/sdk/test/agent-key-envelope.test.ts`, `packages/sdk/test/agent-key-envelope-vectors.json`
  (the vectors file currently pins only the agent envelope AAD + HKDF output; the root-wrap and
  intent AADs have **no** published reference bytes, so new v2 vectors are needed, not just
  edited ones)
- `services/server/src/agent_key_backups.rs` (unit tests `:266-271` + the `#[ignore]` PG/Redis
  integration test `:287-355`), new migration, `src/db.rs:50` registration
- `docs/security/agent-key-backups.md` — contract `:38-51` (**`:47`** "salt-service values … never
  derivation inputs"), recovery `:96-102` (**`:100`** "no OAuth/password/server-secret fallback"),
  routes `:61-76`, lifecycle `:80-94`, commands `:110-140`
- `services/server/.env.example:129-133`; `docs/reference/environment-variables.md:60-61` does not
  document the backup env vars at all (gap to close)

`chat-app`:

- `src/lib/agents/passkey-vault.test.ts` (4 custody-boundary tests: no PRF on the wire, `lock()`
  zeroes secrets and invalidates generations, a late signature cannot unlock a logged-out vault,
  no OAuth substitute when no passkey provider)
- `tests/passkey-vault.browser.spec.ts` + `tests/passkey-vault-harness.ts` + `tests/passkey-vault.html`
  + `playwright.config.ts` — the whole browser suite is anchored on the vault harness page and
  exercises the **plain-Ed25519** `signOwner` branch; a no-passkey tier needs a new harness run and
  the **zkLogin owner-challenge branch has no coverage today**
- `src/lib/agents/agent-keys.test.ts`, `src/dev/seed-agentic-stack.e2e.test.ts` (seeds 150 agents
  via legacy derivation with **no vault envelopes** — i.e. it seeds exactly the custody-absent case,
  so the seeder's story changes with the tiers)
- `src/components/AgentDevSendPanel.tsx` env-credential path (dev-only vault bypass)
- `src/vite-env.d.ts` — `VITE_AGENT_KEY_BACKUPS_ENABLED` / `VITE_PASSKEY_CONNECT_ORIGINS` are not
  even declared today; tier flags must be added
- `vite.config.ts:33-51` — the CSP plugin is itself gated on the backups flag
- docs: `chat-app/README.md:308-321`, `:450-474` (env tables omit every backup variable), and
  **`:378-380` still documents the retired `sha256("mysocial-agent-v1" || human secret || …)`
  derivation as current**, contradicting `agent-key-backups.md:47` and
  `legacy-agent-keys.ts:58-62`. `chat-app/docs/SYSTEM_DESIGN.md` (865 lines, **not valid UTF-8**)
  has **zero** occurrences of agent/passkey/vault/custody — it needs a new ADR rather than an edit


## 7. Open questions

1. Does product accept that the default tier's custody equals the wallet's? (If not, the default
   must stay passkey and this becomes an "opt-down" feature — a much smaller win.)
2. Is `recovery-code-v1` in scope for v1 of this change, or deferred? It is the only non-passkey
   tier that survives a salt-service compromise.
3. Should per-agent tier mixing (multiple roots) ever be exposed, or is one account-wide root
   with multiple unlock paths sufficient?
4. Wallet-only (non-OAuth) sessions cannot fetch a salt, so they cannot use the login-root tier:
   keep them blocked (`MySocialAuthContext.tsx:396`) or offer `device-key-v1` only?
5. Do iOS/Swift and other Memory apps need to unlock the same vault? If yes, the tier must be
   implementable without WebAuthn PRF (login-root and recovery-code are; passkey is not).
