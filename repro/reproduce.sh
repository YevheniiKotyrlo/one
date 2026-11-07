#!/usr/bin/env bash
# `one prebuild` adds `import androidx.activity.enableEdgeToEdge` and an `enableEdgeToEdge()` call to a bare app's
# MainActivity.kt, and the app's Kotlin then fails to compile. The script builds the workspace, installs repro/ in a
# folder outside it from the workspace's packed packages (use-workspace-packages.mjs), runs
# `one prebuild --platform android` there, prints MainActivity.kt's lines naming enableEdgeToEdge, and compiles the app's
# Kotlin with `./gradlew :app:compileDebugKotlin`. Needs the Android SDK (ANDROID_HOME) and a JDK.
# Exits 1 while that compile fails with "Unresolved reference 'enableEdgeToEdge'", 0 once it compiles, and 2 when a step
# before it fails or the compile fails another way.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
: "${ANDROID_HOME:?names the Android SDK}"
platform=$(uname -sr)
node_version=$(node --version)
bun_version=$(bun --version)
java_version=$(java -version 2>&1)
java_version=${java_version%%$'\n'*}
cd "$(dirname "$0")/.."
revision=$(git rev-parse --short HEAD)
echo "$platform, node $node_version, bun $bun_version, $java_version, one checkout at $revision"
bun install
bun run build
workspace=$(mktemp -d "${TMPDIR:-/tmp}/edge.XXXXXX")
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$workspace" 2> /dev/null; exit "$exit_status"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./android --exclude=./ios --exclude=./yarn.lock -cf - . \
  | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
NO_COLOR=1 node node_modules/one/run.mjs prebuild --platform android
activity=$(find android/app/src/main/java -name MainActivity.kt)
edge_lines=$(grep -n enableEdgeToEdge "$activity" || true)
cd android
compile_status=0
# No Gradle or Kotlin daemon outlives the run, and the build JVM's metaspace is not capped at the template's 512 MiB.
GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx6g -Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process" \
  ./gradlew :app:compileDebugKotlin --console=plain > "$workspace/compile.log" 2>&1 || compile_status=$?
errors=$(grep -E '^e: ' "$workspace/compile.log" | sed "s|$workspace|<workspace>|g" || true)

echo
echo "\$ one prebuild --platform android"
echo "MainActivity.kt lines naming enableEdgeToEdge:"
printf '%s\n' "${edge_lines:-  none}" | sed 's/^\([0-9]\)/  \1/'
echo "\$ ./gradlew :app:compileDebugKotlin"
echo "exit code: $compile_status"
[ -z "$errors" ] || printf '%s\n' "$errors"
if [ "$compile_status" -eq 0 ]; then
  echo "the app's Kotlin compiles"
  exit 0
fi
if [[ $errors == *"Unresolved reference 'enableEdgeToEdge'"* ]]; then
  echo "the app's Kotlin does not compile: MainActivity.kt's enableEdgeToEdge is unresolved"
  exit 1
fi
tail -n 30 "$workspace/compile.log" | sed "s|$workspace|<workspace>|g"
echo "the compile failed another way"
exit 2
