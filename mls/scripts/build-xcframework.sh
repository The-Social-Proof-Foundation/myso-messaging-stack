#!/usr/bin/env bash
# Builds MySoMLSFFI.xcframework (iOS device + Apple-silicon simulator) and the UniFFI Swift
# bindings, then installs both into myso-swift-kit (E2EE M6).
#   ./scripts/build-xcframework.sh [path/to/myso-swift-kit]
set -euo pipefail
cd "$(dirname "$0")/.."
KIT="${1:-../../myso-swift-kit}"
OUT=target/xcframework
rm -rf "$OUT" && mkdir -p "$OUT/headers/myso_mlsFFI" "$OUT/swift"

for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --release --lib --target "$target"
done
# Host dylib carries the UniFFI metadata for library-mode generation.
cargo build --release --lib
cargo run --quiet --features bindgen --bin uniffi-bindgen -- generate \
  --library target/release/libmyso_mls.dylib --language swift --out-dir "$OUT/swift"

# Headers live in their own folder: several XCFrameworks in one app can't all put a
# module.modulemap at the include root (Xcode copies them to the same path).
cp "$OUT/swift/myso_mlsFFI.h" "$OUT/headers/myso_mlsFFI/"
cp "$OUT/swift/myso_mlsFFI.modulemap" "$OUT/headers/myso_mlsFFI/module.modulemap"

xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libmyso_mls.a -headers "$OUT/headers" \
  -library target/aarch64-apple-ios-sim/release/libmyso_mls.a -headers "$OUT/headers" \
  -output "$OUT/MySoMLSFFI.xcframework"

mkdir -p "$KIT/Frameworks" "$KIT/Sources/MySoMLS"
rm -rf "$KIT/Frameworks/MySoMLSFFI.xcframework"
cp -R "$OUT/MySoMLSFFI.xcframework" "$KIT/Frameworks/"
cp "$OUT/swift/myso_mls.swift" "$KIT/Sources/MySoMLS/MySoMLSBindings.swift"
echo "Installed MySoMLSFFI.xcframework + Swift bindings into $KIT"
