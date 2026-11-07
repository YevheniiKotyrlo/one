#!/usr/bin/env bash
# `one prebuild` adds `import androidx.activity.enableEdgeToEdge` and an `enableEdgeToEdge()` call to a bare app's
# MainActivity.kt, and the app's Kotlin then fails to compile. The script builds the workspace, installs repro/ in a
# folder outside it from the workspace's packed packages (use-workspace-packages.mjs), runs
# `one prebuild --platform android` there, prints MainActivity.kt's lines naming enableEdgeToEdge and whether it calls
# enableEdgeToEdge() before super.onCreate, prints the androidx.activity version the app compiles against
# (`./gradlew :app:dependencies --configuration debugCompileClasspath`), and compiles the app's Kotlin with
# `./gradlew :app:compileDebugKotlin`. Needs the Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT) and a JDK.
# Exits 1 while that compile fails with "Unresolved reference 'enableEdgeToEdge'", 0 once it compiles with the call
# still before super.onCreate, and 2 when a step before it fails, the compile fails another way, or it compiles without
# that call.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo 'failed: neither ANDROID_HOME nor ANDROID_SDK_ROOT names the Android SDK' >&2
  exit 2
fi
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
# Node and Gradle on Windows take the folder as Windows names it.
if command -v cygpath > /dev/null; then workspace=$(cygpath -m "$workspace"); fi
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
call_line=$(awk '/enableEdgeToEdge\(/ { print NR; exit }' "$activity")
super_line=$(awk '/super\.onCreate/ { print NR; exit }' "$activity")
calls_first=no
if [ -n "$call_line" ] && [ -n "$super_line" ] && [ "$call_line" -lt "$super_line" ]; then calls_first=yes; fi
cd android
# No Gradle or Kotlin daemon outlives the run, and the build JVM's metaspace is not capped at the template's 512 MiB.
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx6g -Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process"
dependencies_status=0
./gradlew :app:dependencies --configuration debugCompileClasspath --console=plain > "$workspace/dependencies.log" 2>&1 \
  || dependencies_status=$?
# The version each androidx.activity:activity line resolves to: the one after its last "->", or the one it names.
activity_versions=$(awk '
  {
    start = index($0, "androidx.activity:activity:")
    if (start == 0) next
    count = split(substr($0, start + length("androidx.activity:activity:")), words, " ")
    version = words[1]
    for (word = 1; word < count; word++) if (words[word] == "->") version = words[word + 1]
    print version
  }
' "$workspace/dependencies.log" | sort -u | paste -sd, -)
compile_status=0
./gradlew :app:compileDebugKotlin --console=plain > "$workspace/compile.log" 2>&1 || compile_status=$?
errors=$(grep -E '^e: ' "$workspace/compile.log" | sed "s|$workspace|<workspace>|g" || true)

echo
echo "\$ one prebuild --platform android"
echo "MainActivity.kt lines naming enableEdgeToEdge:"
printf '%s\n' "${edge_lines:-  none}" | sed 's/^\([0-9]\)/  \1/'
echo "MainActivity.kt calls enableEdgeToEdge() before super.onCreate: $calls_first"
echo "\$ ./gradlew :app:dependencies --configuration debugCompileClasspath"
if [ "$dependencies_status" -ne 0 ]; then
  tail -n 30 "$workspace/dependencies.log" | sed "s|$workspace|<workspace>|g"
  echo "the dependencies task exited $dependencies_status"
  exit 2
fi
echo "androidx.activity:activity on :app's debugCompileClasspath: ${activity_versions:-none}"
echo "\$ ./gradlew :app:compileDebugKotlin"
echo "exit code: $compile_status"
[ -z "$errors" ] || printf '%s\n' "$errors"
if [ "$compile_status" -eq 0 ] && [ "$calls_first" = yes ]; then
  echo "the app's Kotlin compiles, and MainActivity.kt still calls enableEdgeToEdge() before super.onCreate"
  exit 0
fi
if [ "$compile_status" -eq 0 ]; then
  echo "the app's Kotlin compiles, but MainActivity.kt no longer calls enableEdgeToEdge() before super.onCreate"
  exit 2
fi
if [[ $errors == *"Unresolved reference 'enableEdgeToEdge'"* ]]; then
  echo "the app's Kotlin does not compile: MainActivity.kt's enableEdgeToEdge is unresolved"
  exit 1
fi
tail -n 30 "$workspace/compile.log" | sed "s|$workspace|<workspace>|g"
echo "the compile failed another way"
exit 2
