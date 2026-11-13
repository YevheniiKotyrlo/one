#!/usr/bin/env bash
# runs outside Git Bash: Docker's node:26 image, through repro/run-in-docker.sh
# React Native's release bundle for Android of the app in repro/ (native.bundler 'metro', on this checkout's one and
# @vxrn/vite-plugin-metro, packed by use-workspace-packages.mjs), in the setup each case names:
#   watch-folders  the app is a member of a workspace whose root holds build output in target/, and app/index.tsx
#                  requires ../../target/build-output.js; exits 1 while that module bundles, so Metro's file map holds
#                  every file below the root, 0 once Metro cannot resolve it; times the bundle with 200000 files in
#                  target/deps and without them
#   patches        exits 1 while the bundle, which loads the Vite config, changes files of installed packages below
#                  node_modules (outside its dot folders, which hold caches), 0 once it changes none
#   watcher        exits 1 while the bundle calls fs.watch (counted by count-file-watchers.cjs), 0 once it never does
#   isolated       the app is a member of a Bun workspace with the isolated linker; exits 1 while the bundle fails with
#                  "Cannot find module" for a package the app does not depend on, 0 once it bundles
#   optional-peer  the app, a member of a Bun workspace with the isolated linker that links one's own packages and
#                  Rolldown at its root, lists neither react-native-reanimated nor react-native-worklets, which one
#                  declares optional peers; exits 1 while the bundle cannot resolve either, 0 once it bundles
#   no-tsconfig    the app has no tsconfig.json; exits 1 while its config fails to load with "tsconfig.json paths could
#                  not be loaded", 0 once it bundles
#   isolated-dependency  the app, in a Bun workspace with the isolated linker, does not list
#                  @react-navigation/elements, bottom-tabs or native-stack, which
#                  one depends on; beside it, plain-react-native bundles @react-navigation/native-stack on React
#                  Native's default Metro config; exits 1 while the One app cannot resolve one of them from one's
#                  files, 0 once it bundles
# Every case exits 2 when a step fails or the bundle fails another way. Given several cases, it runs them in the order
# named and exits with the highest status.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
known_cases=(watch-folders patches watcher isolated optional-peer no-tsconfig isolated-dependency)
if [ $# -eq 0 ]; then
  echo "usage: reproduce.sh <case>..., a case being one of: ${known_cases[*]}" >&2
  exit 2
fi
for name in "$@"; do
  if [[ " ${known_cases[*]} " != *" $name "* ]]; then
    echo "unknown case: $name; the cases are: ${known_cases[*]}" >&2
    exit 2
  fi
done
repro=$(cd "$(dirname "$0")" && pwd)
cd "$repro/.."
bun install > /tmp/one-install.log 2>&1 || { tail -50 /tmp/one-install.log >&2; exit 2; }
bun run build > /tmp/one-build.log 2>&1 || { tail -80 /tmp/one-build.log >&2; exit 2; }
scratch=$(mktemp -d)
# Removes the scratch folder without changing the exit status.
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$scratch" 2> /dev/null; exit "$exit_status"' EXIT
# Metro's file map watches unless the environment says CI.
unset CI CONTINUOUS_INTEGRATION BUILD_NUMBER RUN_ID
export NO_COLOR=1
template=$scratch/template
mkdir "$template"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./yarn.lock --exclude=./reproduce.sh \
  --exclude=./run-in-docker.sh --exclude=./use-workspace-packages.mjs --exclude=./count-file-watchers.cjs --exclude=./edit-manifests.mjs \
  --exclude=./plain-react-native -cf - . |
  tar -C "$template" -xf -
node repro/use-workspace-packages.mjs "$template"

# Copies the packed app into the folder the first argument names.
copy_app() {
  mkdir -p "$1"
  cp -R "$template/." "$1"
}

# Installs the app or workspace in the folder the first argument names.
install_app() {
  (cd "$1" && bun install > install.log 2>&1) || { tail -40 "$1/install.log" >&2; exit 2; }
}

# Runs React Native's release bundle for Android in the app folder the first argument names, with Metro's caches reset,
# its output in bundle.log there; sets bundled to yes when it exits 0 and writes the bundle, and seconds to how long it
# took.
bundle() {
  local app=$1 started ended status=0
  mkdir -p "$app/out"
  rm -f "$app/out/index.android.bundle"
  started=$(date +%s.%N)
  (cd "$app" && timeout 1500 node node_modules/react-native/cli.js bundle --platform android --dev false \
    --entry-file index.js --bundle-output out/index.android.bundle --reset-cache) > "$app/bundle.log" 2>&1 ||
    status=$?
  ended=$(date +%s.%N)
  seconds=$(awk -v started="$started" -v ended="$ended" 'BEGIN { printf "%.1f", ended - started }')
  bundled=no
  if [ "$status" -eq 0 ] && [ -s "$app/out/index.android.bundle" ]; then
    bundled=yes
  fi
}

# Prints the end of the bundle's output in the app folder the first argument names, then the second argument, and
# exits 2.
fail() {
  tail -40 "$1/bundle.log" >&2
  echo "$2" >&2
  exit 2
}

watch_folders() {
  local root=$scratch/watch-folders app=$scratch/watch-folders/app with_files
  copy_app "$app"
  install_app "$app"
  # Written once the app is installed, so Bun installs the app on its own and Vite finds this root.
  printf '{ "private": true, "workspaces": ["app"] }\n' > "$root/package.json"
  mkdir -p "$root/target/deps"
  printf "module.exports = 'build output below the workspace root'\n" > "$root/target/build-output.js"
  printf "\nexport const buildOutput = require('../../target/build-output.js')\n" >> "$app/app/index.tsx"
  (cd "$root/target/deps" && seq -f 'file-%g.rmeta' 1 200000 | xargs touch)
  bundle "$app"
  with_files=$seconds
  if [ "$bundled" = yes ]; then
    grep -q 'build output below the workspace root' "$app/out/index.android.bundle" ||
      fail "$app" "watch-folders: the bundle lacks target/build-output.js's text"
    rm -rf "$root/target/deps"
    bundle "$app"
    [ "$bundled" = yes ] || fail "$app" "watch-folders: the bundle without target/deps failed"
    echo "watch-folders: Metro bundled target/build-output.js from below the workspace root;" \
      "the bundle took $with_files s with 200000 files in target/deps and $seconds s without them"
    verdict=1
  elif grep -q 'build-output' "$app/bundle.log"; then
    echo "watch-folders: Metro did not resolve target/build-output.js, below the workspace root but outside the" \
      "app, its packages and node_modules; the bundle with 200000 files in target/deps took $with_files s"
    verdict=0
  else
    fail "$app" "watch-folders: the bundle failed before it reached target/build-output.js"
  fi
}

patches() {
  local app=$scratch/patches/app changed changed_count originals turbo_module
  copy_app "$app"
  install_app "$app"
  touch "$scratch/patches/marker"
  sleep 1
  bundle "$app"
  [ "$bundled" = yes ] || fail "$app" "patches: the bundle failed"
  changed=$(cd "$app" && find node_modules -type f -newer "$scratch/patches/marker" -not -path 'node_modules/.*' \
    -not -name '*.vxrn.original' | sort)
  originals=$(cd "$app" && find node_modules -type f -name '*.vxrn.original' -not -path 'node_modules/.*' | wc -l)
  if [ -n "$changed" ]; then
    changed_count=$(wc -l <<< "$changed")
    echo "patches: the release bundle rewrote $((changed_count)) files of installed packages, keeping" \
      "$((originals)) originals beside them as <file>.vxrn.original:"
    awk -F/ '{ name = ($2 ~ /^@/) ? $2 "/" $3 : $2; files[name]++ }
      END { for (name in files) printf "  %s: %d files\n", name, files[name] }' <<< "$changed" | sort
    turbo_module=node_modules/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm
    if [ -e "$app/$turbo_module.vxrn.original" ]; then
      echo "patches: diff $turbo_module.vxrn.original $turbo_module"
      (cd "$app" && diff "$turbo_module.vxrn.original" "$turbo_module" || true)
    fi
    verdict=1
  else
    echo "patches: the release bundle changed no file of an installed package"
    verdict=0
  fi
}

watcher() {
  local app=$scratch/watcher/app calls
  copy_app "$app"
  install_app "$app"
  NODE_OPTIONS="--require $repro/count-file-watchers.cjs" bundle "$app"
  [ "$bundled" = yes ] || fail "$app" "watcher: the bundle failed"
  calls=$(awk -F': ' '/^fs.watch calls: / { sum += $2 } END { print sum + 0 }' "$app/bundle.log")
  if [ "$calls" -gt 0 ]; then
    echo "watcher: the release bundle, outside CI, called fs.watch $calls times"
    verdict=1
  else
    echo "watcher: the release bundle, outside CI, never called fs.watch"
    verdict=0
  fi
}

isolated() {
  local root=$scratch/isolated app=$scratch/isolated/app missing
  copy_app "$app"
  node "$repro/edit-manifests.mjs" workspace-root "$root" "$app"
  printf '[install]\nlinker = "isolated"\n' > "$root/bunfig.toml"
  install_app "$root"
  bundle "$app"
  if [ "$bundled" = yes ]; then
    echo "isolated: the app, a member of a Bun workspace with the isolated linker, bundled"
    verdict=0
    return
  fi
  missing=$(grep -o -m1 "Cannot find module '[^']*'" "$app/bundle.log" | sed "s/Cannot find module '\(.*\)'/\1/" || true)
  [ -n "$missing" ] || fail "$app" "isolated: the bundle failed with no missing module"
  if grep -q "\"$missing\"" "$app/package.json"; then
    fail "$app" "isolated: the bundle cannot find $missing, which the app depends on"
  fi
  grep -m1 -B1 -A3 "Cannot find module '$missing'" "$app/bundle.log" | sed "s|$scratch|<scratch>|g"
  echo "isolated: the app, a member of a Bun workspace with the isolated linker, failed to bundle:" \
    "Cannot find module '$missing', which one's packages depend on and the app does not"
  verdict=1
}

optional_peer() {
  local root=$scratch/optional-peer app=$scratch/optional-peer/app unresolved
  copy_app "$app"
  node "$repro/edit-manifests.mjs" drop-dependencies "$app" react-native-reanimated react-native-worklets
  # react-native-css-interop, which one depends on, requires react-native-reanimated as a peer, so a hoisted install
  # puts it within everyone's reach; the isolated linker keeps it to react-native-css-interop. One's own packages and
  # Rolldown are linked at the root, which the isolated case shows one needs.
  node "$repro/edit-manifests.mjs" workspace-root "$root" "$app"
  printf '[install]\nlinker = "isolated"\npublicHoistPattern = ["@vxrn/*", "rolldown"]\n' > "$root/bunfig.toml"
  install_app "$root"
  for folder in "$root/node_modules" "$app/node_modules"; do
    if [ -e "$folder/react-native-reanimated" ] || [ -e "$folder/react-native-worklets" ]; then
      echo "optional-peer: the install linked react-native-reanimated or react-native-worklets in $folder" >&2
      exit 2
    fi
  done
  bundle "$app"
  if [ "$bundled" = yes ]; then
    echo "optional-peer: the app, without react-native-reanimated and react-native-worklets, bundled"
    verdict=0
    return
  fi
  unresolved=$(grep -o -m1 'Unable to resolve module react-native-\(reanimated\|worklets\)[^ ]* from [^:]*' \
    "$app/bundle.log" || true)
  [ -n "$unresolved" ] || fail "$app" "optional-peer: the bundle failed another way"
  echo "optional-peer: the app, without react-native-reanimated and react-native-worklets, failed to bundle:" \
    "${unresolved//$scratch/<scratch>}"
  verdict=1
}

no_tsconfig() {
  local app=$scratch/no-tsconfig/app
  copy_app "$app"
  rm "$app/tsconfig.json"
  install_app "$app"
  bundle "$app"
  if [ "$bundled" = yes ]; then
    echo "no-tsconfig: the app, without a tsconfig.json, bundled"
    verdict=0
    return
  fi
  grep -q 'tsconfig.json paths could not be loaded' "$app/bundle.log" ||
    fail "$app" "no-tsconfig: the bundle failed another way"
  grep -m1 'tsconfig.json paths could not be loaded' "$app/bundle.log" | sed "s|$scratch|<scratch>|g"
  echo "no-tsconfig: the app, without a tsconfig.json, failed to load its config:" \
    "tsconfig.json paths could not be loaded"
  verdict=1
}

isolated_dependency() {
  local root=$scratch/isolated-dependency app=$scratch/isolated-dependency/app
  local plain=$scratch/isolated-dependency/plain-react-native one_folder linked node_resolved unresolved
  copy_app "$app"
  cp -R "$repro/plain-react-native" "$plain"
  node "$repro/edit-manifests.mjs" drop-dependencies "$app" @react-navigation/elements @react-navigation/bottom-tabs \
    @react-navigation/native-stack
  node "$repro/edit-manifests.mjs" workspace-root "$root" "$app" plain-react-native
  printf '[install]\nlinker = "isolated"\n' > "$root/bunfig.toml"
  install_app "$root"
  one_folder=$(cd "$app/node_modules/one" && pwd -P)
  linked=no
  [ ! -e "$one_folder/../@react-navigation/elements/package.json" ] || linked=yes
  node_resolved=$(node -e 'console.log(require.resolve("@react-navigation/elements", { paths: [process.argv[1]] }))' \
    "$one_folder" 2>&1 || true)
  echo "isolated-dependency: one is installed at ${one_folder//$scratch/<scratch>};" \
    "@react-navigation/elements linked beside it: $linked; Node resolves it from one's folder to" \
    "${node_resolved//$scratch/<scratch>}"
  mkdir -p "$plain/out"
  (cd "$plain" && timeout 1500 node bundle.js) > "$plain/bundle.log" 2>&1 ||
    fail "$plain" "isolated-dependency: the plain React Native app failed to bundle"
  [ -s "$plain/out/index.android.js" ] || fail "$plain" "isolated-dependency: the plain app wrote no bundle"
  grep -q HeaderHeightContext "$plain/out/index.android.js" ||
    fail "$plain" "isolated-dependency: the plain app's bundle lacks @react-navigation/elements' HeaderHeightContext"
  echo "isolated-dependency: the plain React Native app, through Metro's runBuild on React Native's default config watching the" \
    "workspace root, bundled @react-navigation/native-stack and the @react-navigation/elements it depends on"
  bundle "$app"
  if [ "$bundled" = yes ]; then
    echo "isolated-dependency: the One app, without @react-navigation/elements, bottom-tabs and native-stack, bundled"
    verdict=0
    return
  fi
  unresolved=$(grep -o -m1 'Unable to resolve module @react-navigation/[a-z-]* from [^:]*/one/[^:]*' \
    "$app/bundle.log" || true)
  [ -n "$unresolved" ] || fail "$app" "isolated-dependency: the One app's bundle failed another way"
  echo "isolated-dependency: the One app, without @react-navigation/elements, bottom-tabs and native-stack, which" \
    "one depends on, failed to bundle: ${unresolved//$scratch/<scratch>}"
  verdict=1
}

highest=0
for name in "$@"; do
  verdict=2
  case $name in
    watch-folders) watch_folders ;;
    patches) patches ;;
    watcher) watcher ;;
    isolated) isolated ;;
    optional-peer) optional_peer ;;
    no-tsconfig) no_tsconfig ;;
    isolated-dependency) isolated_dependency ;;
  esac
  [ "$verdict" -le "$highest" ] || highest=$verdict
done
exit "$highest"
