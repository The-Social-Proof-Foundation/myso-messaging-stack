# @socialproof/myso-mls

WebAssembly bindings of the `myso-mls` crate (OpenMLS, ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) used by `@socialproof/myso-messaging-stack`
for MLS (E2EE M4+). Pass the module to `client.messaging.openMlsSession({ wasm })`.

- **Browser / bundlers** (`web/`, ES module): call the default export once to load the WASM,
  then use the named exports:
  ```ts
  import init, * as mls from '@socialproof/myso-mls';
  await init();
  ```
- **Node** (`node/`, CommonJS, loads synchronously): `const mls = require('@socialproof/myso-mls')`
  (or `createRequire(import.meta.url)('@socialproof/myso-mls')` from ESM).

Build: `mls/scripts/build-npm.sh` (wasm-pack, release). Docs: `docs/myso-messaging-stack/E2EE-Protocol-MLS.md`.
