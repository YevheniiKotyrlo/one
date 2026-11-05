#!/usr/bin/env bash
# vxrn's built-in react-native patch for RCTTurboModule.mm matches nothing on react-native 0.88.
# `one patch --force` patches this checkout's node_modules, as an app's install does.
# Exits 1 while the patch matches nothing, 0 once it applies, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
mkdir -p tmp
NO_COLOR=1 bunx one patch --force 2>&1 | tee tmp/patch.log

uncolor() { sed $'s/\033\\[[0-9;]*m//g'; }
rn=$(node -p "require('path').dirname(require.resolve('react-native/package.json'))")
echo
echo "react-native $(node -p "require('react-native/package.json').version")"
echo 'one patch --force printed for react-native:'
grep -E 'patch for react-native |^ +[^ ]+ react-native$' tmp/patch.log | uncolor || true
echo 'the void-method branch of RCTTurboModule.mm:'
grep -n -A2 'Void methods are always async' "$rn"/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm
grep -q 'patch for react-native matched nothing' tmp/patch.log || exit 0
exit 1
