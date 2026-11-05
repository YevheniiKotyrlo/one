#!/usr/bin/env bash
# Run from the repository root.
set -u
bun install
[ -d packages/one/dist/esm ] || bun run build
cd repro
echo "react-native $(node -p "require('react-native/package.json').version")"
echo '$ one patch --force'
bunx one patch --force 2>&1 | grep -i 'react-native'
rn=$(node -p "require('path').dirname(require.resolve('react-native/package.json'))")
grep -n -A2 'Void methods are always async' "$rn"/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm
