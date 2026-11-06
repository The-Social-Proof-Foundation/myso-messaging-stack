# E2EE Roadmap

Status of the end-to-end encryption upgrade across the relayer, the TS SDK / web app, and the iOS
client. Wire formats live in [E2EE-Protocol-v2.md](./E2EE-Protocol-v2.md).

## Visible to the relayer by design

That a message or event was sent or read, its timing and order, online presence, payment digests
and status, public on-chain post addresses for `post` shares, and on-chain group membership.
Everything else moves inside ciphertext.

## Target architecture

```
content envelope v2 (typed, padded)            <- text, reactions, edits, deletes, pins, votes, attachment refs + per-file keys
  └─ inner: AES-256-GCM with the MyData DEK    <- on-chain MessagingReader gate (kept)
       └─ outer: MLS PrivateMessage (OpenMLS)  <- forward secrecy + post-compromise security (M4+)
```

One Rust crate (`myso-mls`) wraps OpenMLS for every platform: native in the relayer, WASM for the
web app and Node agents, UniFFI xcframework for iOS.

## Milestones

| | Scope | Status |
|---|---|---|
| Phase 0 | Signed device notification keys, on-chain recipient filter, attachment AAD v1, sealed web previews | Done |
| M1 | Content envelope v2 + opaque `message` / `event` kinds; reactions, edits, deletes, pins, poll votes as encrypted events; padding; attachment refs + per-file keys inside the envelope; per-group `e2ee=v2` flag | Done (relayer, SDK, web, iOS) |
| M2 | Encrypted group names (`enc:v1:`, padded, SDK/web/iOS); APNs payload minimization behind `PUSH_MINIMAL_PAYLOAD` (routing moves into the sealed preview). Typing already carries no payload; payer/recipient stay because the relayer derives them from DM membership anyway | Done |
| M3 | MLS spike: OpenMLS for wasm32 + iOS, ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, size/perf numbers. Results: [MLS-Spike.md](./MLS-Spike.md) | Done: **go** |
| M4 | MLS core: wallet-certified device credentials + KeyPackages, relayer as delivery service (one commit per epoch), on-chain-authorized Adds/Removes, outer MLS layer. Spec: [E2EE-Protocol-MLS.md](./E2EE-Protocol-MLS.md) | Done (crate + relayer; client wiring is M6) |
| M5 | Multi-device via external commit, device-to-device history sync (self-group), optional "share recent history" for new members, logout removes leaf | Done (crate + relayer; client wiring is M6) |
| M6 | Clients: SDK `MlsSession` (WASM), web (sealed IndexedDB state, Web Locks single writer, `VITE_MLS_ENABLED`), iOS (`MySoMLS` UniFFI XCFramework, Vault-sealed state, app-only writer, `MLS_ENABLED`), agents as their own MLS devices. Hardening: zkLogin account identity, tri-state certificate checks, desync resync, ambiguous-commit resolution, on-demand joins, self-group history on iOS, live run against the real relayer | Done in code: hardening plus v2 certificate renewal through `messaging::mls_device_registry` (crate, relayer, SDK, web, iOS). Not yet deployed: framework release, one-time `create_mls_device_registry`, gas-pool allowlist, client flags |
| M7 | Every new chat is MLS: `e2ee=mls1` written in the creating transaction (groups and paid DMs, web + iOS), race-safe MLS group setup (first epoch-0 claim wins; any member finishes it), archive recovery off for MLS groups, MLS on by default. No migration or sunset: existing chats stay as they are | Done in code, agent rooms included (`create_agent_group_with_e2ee`, ships with the framework release) |
| M8 | Optional passkey backup: PRF salt `mysocial/messaging-backup-prf/v1` on the existing `mysocial.network` passkey, encrypted append-only history segments | Done in code: relayer (migration `028`), SDK, web (Settings → Message backup), iOS 18+ (Auth & Passkeys → Message Backup) |

## Rollout rules

- Readers ship before writers: every client must read v2 before any group writes it.
- A group writes v2 only when its on-chain metadata `data["e2ee"]` is `v2` (later `mls1`).
- New groups get the flag only when the app's "v2 for new groups" switch is on.
- Relayer deploys before clients for every milestone.
