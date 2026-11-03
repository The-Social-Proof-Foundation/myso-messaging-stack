---
'@socialproof/myso-messaging-stack': minor
---

Relayer zkLogin auth. A zkLogin-scheme signature is sent whole with `public_key` `05`, so the relayer
authenticates the zkLogin address itself. New `relayer.authSigner` option and `zkLoginRelayerSigner`
helper: relayer requests, message AAD and transfer idempotency keys use the zkLogin address, while
per-message signatures, MyData session keys and transactions keep the original signer.
