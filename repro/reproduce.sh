#!/usr/bin/env bash
# On a host without xcrun (Linux, Windows), `one prebuild` stops in its iOS SDK step before it patches android/.
# On macOS with Xcode both prebuilds succeed. Exits 1 while android/ is left unpatched, 0 once it is patched,
# and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
mkdir -p tmp
activity=android/app/src/main/java/dev/onestack/repro/MainActivity.kt

prebuild() {
  rm -rf ios android
  local status=0
  NO_COLOR=1 bunx one prebuild "$@" 2>&1 | tee tmp/prebuild.log || status=$?
  summary+=("\$ one prebuild${*:+ $*}")
  summary+=("exit code: $status")
  while IFS= read -r line; do summary+=("$line"); done < <(
    grep -m1 ' ERROR ' tmp/prebuild.log || true
    awk '/^ +at sdkPath /,/^ +at writeIosSdk /' tmp/prebuild.log
  )
  if [ -f "$activity" ]; then
    for name in RNScreensFragmentFactory OneLaunchScreen; do
      summary+=("MainActivity.kt lines naming $name: $(grep -c "$name" "$activity" || true)")
    done
  else
    summary+=("$activity: missing")
  fi
}

summary=()
prebuild
patched=$(grep -c RNScreensFragmentFactory "$activity" 2> /dev/null || true)
prebuild --platform android
rm -rf ios android

echo
printf '%s\n' "${summary[@]}"
[ "${patched:-0}" -gt 0 ] || exit 1
