#!/usr/bin/env bash
# On a host without Xcode or CocoaPods (Linux, Windows), `one prebuild` without `--platform` writes android/ and then
# exits non-zero at `pod install`. Exits 1 while it exits non-zero, 0 once it exits 0, and 2 when xcrun or pod is on
# PATH or a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
for tool in xcrun pod; do
  if command -v "$tool" > /dev/null; then echo "$tool is on PATH; this shows a host without it" >&2; exit 2; fi
done
bun install
bun run build
cd repro
mkdir -p tmp
activity=android/app/src/main/java/dev/onestack/repro/MainActivity.kt

summary=()
prebuild() {
  rm -rf ios android
  status=0
  NO_COLOR=1 bunx one prebuild "$@" 2>&1 | tee tmp/prebuild.log || status=$?
  summary+=("\$ one prebuild${*:+ $*}" "exit code: $status")
  while IFS= read -r line; do summary+=("$line"); done < <(grep -m1 -e 'iOS SDK' tmp/prebuild.log || true)
  while IFS= read -r line; do summary+=("$line"); done < <(grep -m1 ' ERROR ' tmp/prebuild.log || true)
  if [ -f "$activity" ]; then
    for name in RNScreensFragmentFactory OneLaunchScreen; do
      summary+=("MainActivity.kt lines naming $name: $(grep -c "$name" "$activity" || true)")
    done
  else
    summary+=("$activity: missing")
  fi
}

prebuild
unscoped_status=$status
prebuild --platform android
rm -rf ios android

echo
printf '%s\n' "${summary[@]}"
[ "$unscoped_status" -eq 0 ] || exit 1
