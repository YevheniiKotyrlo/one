#!/usr/bin/env bash
# The root package.json patches react-native-safe-area-context@5.7.0 while bun.lock resolves 5.8.1, so `bun install`
# warns that the patch no longer applies; 5.8.1's SafeAreaView.kt already lacks the code the patch removes.
# Exits 1 while bun install prints that warning, 0 once it does not, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
mkdir -p repro/tmp
bun install 2>&1 | tee repro/tmp/install.log
package=$(node -p "require('path').dirname(require.resolve('react-native-safe-area-context/package.json'))")
view="$package/android/src/main/java/com/th3rdwave/safeareacontext/SafeAreaView.kt"
[ -f "$view" ] || { echo "$view is missing" >&2; exit 2; }
entries=$(node -p "Object.keys(require('./package.json').patchedDependencies).filter((name) => name.startsWith('react-native-safe-area-context@')).join(', ')")
installed=$(node -p "require('react-native-safe-area-context/package.json').version")
removed=$(grep -c -E 'dispatchViewUpdates|waitForReactLayout' "$view" || true)
echo
echo "patchedDependencies entries for react-native-safe-area-context: $entries"
echo "installed: react-native-safe-area-context $installed"
echo "lines of its SafeAreaView.kt naming dispatchViewUpdates or waitForReactLayout, which the patch removes: $removed"
grep 'react-native-safe-area-context.*no longer applies' repro/tmp/install.log || exit 0
exit 1
