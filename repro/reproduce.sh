#!/usr/bin/env bash
# On a Mac whose developer directory is the Command Line Tools, xcrun runs but finds no iOS SDK, and `one prebuild`
# without --platform ends on its iOS simulator SDK lookup. Run it on a Mac with only the Command Line Tools, or on one
# with Xcode as `DEVELOPER_DIR=/Library/Developer/CommandLineTools bash repro/reproduce.sh`. The script builds the
# workspace, installs repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs),
# runs `one prebuild` there and counts the lines of android/'s MainActivity.kt that name RNScreensFragmentFactory and
# OneLaunchScreen; then, as a control, it runs `one prebuild --platform android` on a clean copy and counts them again.
# Exits 1 while `one prebuild` fails and ends on an iOS simulator SDK lookup (its last ERROR line names one); 0 once it
# patches android/ and does not end on one; 2 when the host is not such a Mac, a step before `one prebuild` fails, the
# control leaves android/ unpatched, or `one prebuild` ends another way.
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

# Runs `one prebuild` with the arguments given on a copy without android/ and ios/, keeps its output in the log the
# first argument names, and sets `status`, `activity` (the MainActivity.kt it generated, or nothing), and `screens` and
# `launch_screen`, the counts of that file's lines naming RNScreensFragmentFactory and OneLaunchScreen.
prebuild() {
  local log=$1
  shift
  rm -rf android ios
  status=0
  NO_COLOR=1 node node_modules/one/run.mjs prebuild "$@" > "$log" 2>&1 || status=$?
  activity=
  screens=0
  launch_screen=0
  if [ -d android/app/src/main/java ]; then
    activity=$(find android/app/src/main/java -name MainActivity.kt)
  fi
  local activities=0
  [ -z "$activity" ] || activities=$(printf '%s\n' "$activity" | wc -l)
  if [ "$activities" -eq 1 ]; then
    screens=$(grep -c RNScreensFragmentFactory "$activity" || true)
    launch_screen=$(grep -c OneLaunchScreen "$activity" || true)
  else
    activity=
  fi
}

prebuild prebuild.log
cat prebuild.log
prebuild_status=$status
prebuild_activity=$activity
prebuild_screens=$screens
prebuild_launch_screen=$launch_screen
grep ' ERROR ' prebuild.log > prebuild-errors.log || true
error_line=$(tail -1 prebuild-errors.log)
prebuild control.log --platform android
rm -rf android ios

echo
echo "\$ xcrun --sdk iphonesimulator --show-sdk-path"
echo "${sdk_output%%$'\n'*}"
echo "exit code: $sdk_status"
echo "\$ one prebuild"
echo "exit code: $prebuild_status"
[ -z "$error_line" ] || echo "$error_line"
if [ -n "$prebuild_activity" ]; then
  echo "MainActivity.kt lines naming RNScreensFragmentFactory: $prebuild_screens"
  echo "MainActivity.kt lines naming OneLaunchScreen: $prebuild_launch_screen"
else
  echo "MainActivity.kt: not generated"
fi
echo "\$ one prebuild --platform android"
echo "exit code: $status"
echo "MainActivity.kt lines naming RNScreensFragmentFactory: $screens"
echo "MainActivity.kt lines naming OneLaunchScreen: $launch_screen"

if [ "$screens" -eq 0 ] || [ "$launch_screen" -eq 0 ]; then
  echo "the control, one prebuild --platform android, did not patch android/"
  exit 2
fi
patched=no
if [ -n "$prebuild_activity" ] && [ "$prebuild_screens" -gt 0 ] && [ "$prebuild_launch_screen" -gt 0 ]; then
  patched=yes
fi
ended_on_sdk_lookup=no
if [ "$prebuild_status" -ne 0 ]; then
  case $error_line in
    *'xcrun --sdk iphonesimulator --show-sdk-'*) ended_on_sdk_lookup=yes ;;
  esac
fi
if [ "$ended_on_sdk_lookup" = yes ]; then
  if [ "$patched" = yes ]; then
    echo "one prebuild patched android/ and still ended on an iOS simulator SDK lookup"
  else
    echo "one prebuild ended on an iOS simulator SDK lookup before it patched android/"
  fi
  exit 1
fi
if [ "$patched" = yes ] && [ "$ended_on_sdk_lookup" = no ]; then
  echo "one prebuild patched android/ and did not end on an iOS simulator SDK lookup"
  exit 0
fi
echo "one prebuild ended another way"
exit 2
