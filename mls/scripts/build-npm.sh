#!/usr/bin/env bash
# Builds the publishable @socialproof/myso-mls package in mls/npm (web + node WASM builds).
#   ./scripts/build-npm.sh          then: cd npm && npm publish --access public
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf npm/web npm/node
wasm-pack build --release --target web --out-dir npm/web --out-name myso_mls
wasm-pack build --release --target nodejs --out-dir npm/node --out-name myso_mls
# wasm-pack writes its own package.json / .gitignore per target: keep only the module type marker
# so `web/` stays ESM and `node/` stays CommonJS inside the one package.
for d in web node; do
  rm -f "npm/$d/.gitignore" "npm/$d/README.md"
done
printf '{ "type": "module" }\n' > npm/web/package.json
printf '{ "type": "commonjs" }\n' > npm/node/package.json
echo "Built @socialproof/myso-mls in mls/npm (web + node)."
