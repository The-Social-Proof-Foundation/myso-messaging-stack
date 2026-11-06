# M3: MLS spike results

Crate: `mls/` (`myso-mls`), OpenMLS 0.9.2 + `openmls_rust_crypto` 0.6, ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Verdict: **go**.

## What was proven

| Check | Result |
|---|---|
| Native (relayer) build + tests | Pass: join via Welcome, application messages, replay rejected (same ciphertext can't be processed twice), self-update commit applied by peer, non-member can't decrypt |
| `wasm32-unknown-unknown` | Builds (`getrandom` 0.2 `js`, 0.4 `wasm_js`, OpenMLS `js` features). `wasm-pack` bundle: **1.28 MB raw / 496 KB gzip** |
| WASM in a JS runtime (Node) | End to end: join, decrypt, replay rejected, commit applied. ~126 µs per 256-byte message |
| iOS (`aarch64-apple-ios`) | Builds as a static library. Archive is 50 MB unstripped; the linked size must be measured in M6 (dead-stripping removes most of it) |

## Timings (native, `opt-level = "z"` size profile; speed profile is ~2× faster)

| Members | Add all (one commit) | Self-update | Apply commit | Encrypt 256 B | MLS msg | Welcome |
|---|---|---|---|---|---|---|
| 2 | 0.7 ms | 0.36 ms | 0.27 ms | 64 µs | 391 B | 777 B |
| 50 | 8.5 ms | 1.7 ms | 0.9 ms | 130 µs | 391 B | 16.8 KB |
| 500 | 127 ms | 9.3 ms | 5.0 ms | 0.78 ms | 391 B | 164 KB |

Per-message cost is invisible to users. Commits stay in the low milliseconds up to hundreds of
members.

## Findings that shape M4–M6

1. **Large Welcomes.** With the ratchet-tree extension the Welcome grows ~330 bytes per member
   (164 KB at 500). Fine for DMs and small groups; for large groups disable the extension and let
   joiners fetch the tree from the relayer.
2. **Size vs speed profile.** `opt-level = "z"` halves speed for a smaller WASM. Use `"z"` for the
   web bundle and `3` for native/iOS.
3. **Own-message echoes.** OpenMLS 0.9 surfaces a device's own commits/messages as distinct variants
   (`Processed::Own`). Clients keep their own plaintext locally and skip these.
4. **State persistence.** The spike uses the in-memory `OpenMlsRustCrypto` store. M6 needs a
   persistent `StorageProvider` (IndexedDB on web, app-group SQLite on iOS) with a single writer.
