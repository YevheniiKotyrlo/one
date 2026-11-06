#!/usr/bin/env bash
# On a Mac whose developer directory is the Command Line Tools, xcrun runs but finds no iOS SDK, and `one prebuild`
# without --platform stops in its iOS SDK step before it patches android/. Run it on a Mac with only the Command Line
# Tools, or on one with Xcode as `DEVELOPER_DIR=/Library/Developer/CommandLineTools bash repro/reproduce.sh`. The
# script builds the workspace, installs repro/ in a folder outside it from the workspace's packed packages
# (use-workspace-packages.mjs), runs `one prebuild` there and reads android/'s MainActivity.kt for One's patches.
# Exits 1 while `one prebuild` fails on the iOS simulator SDK lookup and MainActivity.kt names neither
# RNScreensFragmentFactory nor OneLaunchScreen; 0 once it names both; 2 when the host is not such a Mac, a step before
# `one prebuild` fails, or the result is neither.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
system=$(uname -s)
if [ "$system" != Darwin ]; then
  echo "this shows a Mac with only the Command Line Tools; this host is $system" >&2
  exit 2
fi
xcrun_version=$(xcrun --version)
sdk_status=0
# Inherited by the substitution, the ERR trap would end it with 2 in place of xcrun's own status.
set +E
sdk_output=$(xcrun --sdk iphonesimulator --show-sdk-path 2>&1) || sdk_status=$?
set -E
if [ "$sdk_status" -eq 0 ]; then
  echo "xcrun finds the iOS simulator SDK ($sdk_output); run this with DEVELOPER_DIR=/Library/Developer/CommandLineTools" >&2
  exit 2
fi
developer_directory=${DEVELOPER_DIR:-}
[ -n "$developer_directory" ] || developer_directory=$(xcode-select -p)
macos_version=$(sw_vers -productVersion)
architecture=$(uname -m)
node_version=$(node --version)
bun_version=$(bun --version)
echo "macOS $macos_version $architecture, developer directory $developer_directory, $xcrun_version, node $node_version, bun $bun_version"

cd "$(dirname "$0")/.."
bun install
bun run build
workspace=$(mktemp -d)
# Removes the workspace without changing the exit status.
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$workspace" 2> /dev/null; exit "$exit_status"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./android --exclude=./ios --exclude=./yarn.lock -cf - . \
  | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
package=$(node -p "require('./app.json').expo.android.package")
activity=android/app/src/main/java/${package//.//}/MainActivity.kt

prebuild_status=0
NO_COLOR=1 node node_modules/one/run.mjs prebuild > prebuild.log 2>&1 || prebuild_status=$?
cat prebuild.log

echo
echo "\$ xcrun --sdk iphonesimulator --show-sdk-path"
echo "$sdk_output"
echo "exit code: $sdk_status"
echo "\$ one prebuild"
echo "exit code: $prebuild_status"
error_line=$(grep -m1 ' ERROR ' prebuild.log || true)
[ -z "$error_line" ] || echo "$error_line"
sdk_error=$(grep -m1 'SDK "iphonesimulator" cannot be located' prebuild.log || true)
[ -z "$sdk_error" ] || echo "$sdk_error"
screens=0
launch_screen=0
if [ -f "$activity" ]; then
  screens=$(grep -c RNScreensFragmentFactory "$activity" || true)
  launch_screen=$(grep -c OneLaunchScreen "$activity" || true)
  echo "MainActivity.kt lines naming RNScreensFragmentFactory: $screens"
  echo "MainActivity.kt lines naming OneLaunchScreen: $launch_screen"
else
  echo "$activity: missing"
fi

if [ "$screens" -gt 0 ] && [ "$launch_screen" -gt 0 ]; then
  echo "android/ carries One's patches"
  exit 0
fi
if [ "$prebuild_status" -ne 0 ] && [ -n "$sdk_error" ] && [ "$screens" -eq 0 ] && [ "$launch_screen" -eq 0 ]; then
  echo "one prebuild stopped in the iOS SDK step before it patched android/"
  exit 1
fi
echo "one prebuild ended another way"
exit 2
