#!/usr/bin/env bash
# Run from the repository root on a machine without Xcode (Windows or Linux).
set -u
bun install
bun run build
cd repro
rm -rf ios android
echo '$ one prebuild'
bunx one prebuild
echo "one prebuild exit code: $?"
activity=android/app/src/main/java/dev/onestack/repro/MainActivity.kt
echo "android/ exists: $([ -d android ] && echo yes || echo no)"
echo "MainActivity.kt lines naming RNScreensFragmentFactory: $(grep -c RNScreensFragmentFactory "$activity")"
echo "MainActivity.kt lines naming OneLaunchScreen: $(grep -c OneLaunchScreen "$activity")"
rm -rf ios android
echo '$ one prebuild --platform android'
bunx one prebuild --platform android
echo "one prebuild --platform android exit code: $?"
echo "MainActivity.kt lines naming RNScreensFragmentFactory: $(grep -c RNScreensFragmentFactory "$activity")"
echo "MainActivity.kt lines naming OneLaunchScreen: $(grep -c OneLaunchScreen "$activity")"
