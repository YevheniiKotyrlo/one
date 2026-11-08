#!/usr/bin/env bash
# `one`'s runtime declarations and `one/vite`'s both import types/vite/types.d.ts, so a React Native program that
# imports `one` reads Vite's and Node's declarations, and a vite.config.ts program that imports `one/vite` reads React
# Native's. The script builds the workspace, installs repro/ in a folder outside it from the workspace's packed packages
# (use-workspace-packages.mjs), and type-checks two programs there with skipLibCheck off: tsconfig.native.json, the
# routes in app/ as a React Native app checks them (lib ESNext without the DOM, types [], the react-native condition),
# and tsconfig.vite.json, vite.config.ts with Node's types. For each it prints the declarations it reads from the other
# program's packages, why it reads them (tsc --explainFiles), and the errors tsc reports in one's own declarations.
# Exits 1 while the React Native program reads @types/node or vite, the Vite program reads react-native, or either
# reports an error in one's declarations; 0 once neither reads the other's packages and neither reports an error in
# one's; 2 when a step before the check fails or tsc cannot check a program.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
platform=$(uname -sr)
node_version=$(node --version)
bun_version=$(bun --version)
cd "$(dirname "$0")/.."
revision=$(git rev-parse --short HEAD)
echo "$platform, node $node_version, bun $bun_version, one checkout at $revision"
bun install
bun run build
workspace=$(mktemp -d "${TMPDIR:-/tmp}/declarations.XXXXXX")
# Node and bun on Windows take the folder as Windows names it.
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
typescript_version=$(./node_modules/.bin/tsc --version | tr -d '\r')

# Type-checks a program three ways into $workspace: its diagnostics, the files it reads, and why it reads each.
check_program() {
  local config=$1 status=0
  ./node_modules/.bin/tsc -p "$config" --pretty false 2>&1 | tr -d '\r' > "$workspace/$config.diagnostics" \
    || status=$?
  if [ "$status" -gt 2 ] || grep -qE 'error TS(5|6)[0-9]{3}' "$workspace/$config.diagnostics"; then
    cat "$workspace/$config.diagnostics"
    echo "tsc cannot check $config (exit $status)"
    exit 2
  fi
  ./node_modules/.bin/tsc -p "$config" --listFilesOnly | tr -d '\r' > "$workspace/$config.files"
  ./node_modules/.bin/tsc -p "$config" --explainFiles --pretty false 2>&1 | tr -d '\r' > "$workspace/$config.explained" \
    || true
  if [ ! -s "$workspace/$config.files" ]; then
    echo "tsc lists no file for $config"
    exit 2
  fi
}

# Prints "<package> (<count> files)" for each package the program reads declarations from that the pattern matches.
foreign_packages() {
  local config=$1 pattern=$2
  sed -n 's|^.*/node_modules/||p' "$workspace/$config.files" \
    | awk -F/ '{ print ($1 ~ /^@/) ? $1 "/" $2 : $1 }' \
    | grep -xE "$pattern" | sort | uniq -c | awk '{ printf "%s (%s files)\n", $2, $1 }' || true
}

# Prints the file and, under it, the first reasons tsc --explainFiles gives for reading it, without package ids.
explain_file() {
  local config=$1 file=$2 limit=$3
  awk -v file="$file" -v limit="$limit" '
    $0 == file { reading = 1; print file; next }
    reading && /^   / { if (shown++ < limit) { sub(/ with packageId .*$/, ""); sub(/^ +/, "    "); print } next }
    reading { exit }
  ' "$workspace/$config.explained"
}

# Prints "<package> <count>" for each package whose declarations tsc reports errors in, the most first, and "app <count>"
# for the app's own files.
errors_by_package() {
  sed -n 's/^\(.*\)([0-9]*,[0-9]*): error TS[0-9]*:.*$/\1/p' "$workspace/$1.diagnostics" \
    | awk -F/ '{ if ($1 != "node_modules") print "app"; else print ($2 ~ /^@/) ? $2 "/" $3 : $2 }' \
    | sort | uniq -c | sort -k1,1nr -k2,2 | awk '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $2, $1 }'
}

one_errors() {
  grep -E '^node_modules/one/[^(]*\([0-9]+,[0-9]+\): error TS' "$workspace/$1.diagnostics" || true
}

check_program tsconfig.native.json
check_program tsconfig.vite.json
native_foreign=$(foreign_packages tsconfig.native.json '@types/node|vite')
vite_foreign=$(foreign_packages tsconfig.vite.json 'react-native')
native_one_errors=$(one_errors tsconfig.native.json)
vite_one_errors=$(one_errors tsconfig.vite.json)

report_program() {
  local config=$1 description=$2 packages=$3 foreign=$4 errors=$5
  shift 5
  echo "\$ tsc -p $config   ($description)"
  local listed=${foreign:-none}
  echo "declarations it reads from $packages: ${listed//$'\n'/, }"
  if [ -n "$foreign" ]; then
    local entry
    for entry in "$@"; do explain_file "$config" "${entry%:*}" "${entry##*:}"; done
  fi
  local count by_package
  count=$(grep -cE ': error TS[0-9]+' "$workspace/$config.diagnostics" || true)
  by_package=$(errors_by_package "$config")
  echo "errors: $count${by_package:+ ($by_package)}"
  [ -z "$errors" ] || printf '%s\n' "$errors"
}

echo
echo "$typescript_version"
report_program tsconfig.native.json "app/, lib ESNext without the DOM, types [], the react-native condition" \
  '@types/node and vite' "$native_foreign" "$native_one_errors" \
  'node_modules/@types/node/index.d.ts:1' 'node_modules/vite/dist/node/index.d.ts:2' \
  'node_modules/one/types/vite/types.d.ts:8'
report_program tsconfig.vite.json "vite.config.ts with Node's types" \
  'react-native' "$vite_foreign" "$vite_one_errors" \
  'node_modules/react-native/types_generated/index.d.ts:1' 'node_modules/one/types/interfaces/router.d.ts:1'

if [ -z "$native_foreign$vite_foreign$native_one_errors$vite_one_errors" ]; then
  echo "neither program reads the other's declarations, and neither reports an error in one's declarations"
  exit 0
fi
problems=()
[ -z "$native_foreign" ] || problems+=("the React Native program reads Node's and Vite's declarations")
[ -z "$vite_foreign" ] || problems+=("the Vite program reads React Native's")
[ -z "$native_one_errors$vite_one_errors" ] || problems+=("tsc reports errors in one's declarations")
summary=$(printf '%s; ' "${problems[@]}")
echo "${summary%; }"
exit 1
