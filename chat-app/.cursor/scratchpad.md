# Chat-app zkLogin parity with mysocial-frontend

## Background
Chat-app stored proofs in sessionStorage, always called the Groth16 prover after OAuth, used `epoch + 30` without chain clock caps, and never logged out when `maxEpoch` was reached. Salt derivation could also run for zkLogin sessions if the ephemeral key was missing.

## Project Status Board
- [x] IndexedDB persist (`mysocial-zklogin-session`) matching frontend
- [x] Skip prove when stored `sub`/address still matches and maxEpoch is usable
- [x] `restoreZkLoginSignerStatus`: ok | expired | missing | clock-unavailable | invalid
- [x] Logout on expired/invalid/missing (not pending); no auto-prove
- [x] Chain clock + horizon; remaining=0 (`epoch >= maxEpoch`) is unusable
- [x] Signing (`zkLoginChainSignature`) refuses expired proofs and fires expiry event
- [x] Auth never salt-derives a keypair for zkLogin sessions

## Executor's Feedback
Chat-app still talks to the public prover URL (no Next `/api/zklogin/prove` proxy). SessionStorage `mysocial_zklogin_current` is a same-tab cache only; IndexedDB is the source of truth.
