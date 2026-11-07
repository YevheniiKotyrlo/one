#!/usr/bin/env bash
# vxrn's built-in react-native patch for RCTTurboModule.mm matches nothing on react-native 0.88, so the @catch block of
# performVoidMethodInvocation still rethrows. `one patch --force` patches this checkout's node_modules, as an app's
# install does. Exits 1 while that block rethrows, 0 once it does not, and 2 when a setup step fails.
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
awk '/::performVoidMethodInvocation\(/ { inside = 1 }
  inside && /@catch/ { printing = 1 }
  printing { printf "%d: %s\n", NR, $0 }
  printing && /@finally/ { exit }' \
  "$rn"/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm > tmp/void-catch.txt
react_native_version=$(node -p "require('react-native/package.json').version")
echo
echo "react-native $react_native_version"
echo 'one patch --force printed for react-native:'
grep -E 'patch for react-native |^ +[^ ]+ react-native$' tmp/patch.log | uncolor || true
echo 'the @catch block of performVoidMethodInvocation in RCTTurboModule.mm:'
cat tmp/void-catch.txt
[ -s tmp/void-catch.txt ] || { echo "RCTTurboModule.mm has no @catch block in performVoidMethodInvocation" >&2; exit 2; }
grep -q '@throw' tmp/void-catch.txt || exit 0
exit 1
