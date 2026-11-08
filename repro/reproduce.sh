#!/usr/bin/env bash
# `one`'s runtime declarations and `one/vite`'s both import types/vite/types.d.ts, so a React Native program that
# imports `one` reads Vite's and Node's declarations, and a vite.config.ts program that imports `one/vite` reads React
# Native's. The script builds the workspace, installs repro/ in a folder outside it from the workspace's packed packages
# (use-workspace-packages.mjs), and type-checks two programs there with skipLibCheck off: tsconfig.native.json, the
# routes in app/ as a React Native app checks them (lib ESNext without the DOM, types [], the react-native condition),
# and tsconfig.vite.json, vite.config.ts with Node's types. For each it prints the declarations it reads from the other
# program's packages, why it reads them (tsc --explainFiles), its errors by the package that declares them, and its
# errors in the declarations of one and of @vxrn/compiler, which import @babel/core's types without @types/babel__core.
# Exits 1 while the React Native program reads @types/node or vite, the Vite program reads react-native, or either
# reports an error in one's or @vxrn/compiler's declarations; 0 once neither reads the other's packages and neither
# reports an error in those; 2 when a step before the check fails, tsc cannot check a program (it exits other than 0
# or 1, prints what is not a diagnostic of a file, or reports a configuration error), or a program reads none of one's
# declarations or cannot import one.
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

# Runs tsc with the arguments after the first into $workspace/<first>, its carriage returns removed, and ends the run
# with 2 when tsc exits other than 0 or 1: under noEmit it exits 1 for a program with errors, and 2 for a panic or a
# program with no input.
run_tsc() {
  local output=$1 status=0
  shift
  ./node_modules/.bin/tsc "$@" > "$workspace/$output.raw" 2>&1 || status=$?
  tr -d '\r' < "$workspace/$output.raw" > "$workspace/$output"
  if [ "$status" -gt 1 ]; then
    cat "$workspace/$output"
    echo "tsc cannot check: tsc $* exited $status"
    exit 2
  fi
}

# Type-checks a program three ways into $workspace: its diagnostics, the files it reads, and why it reads each; ends the
# run with 2 when tsc prints a line that is no file's diagnostic or its continuation, or a configuration error.
check_program() {
  local config=$1
  run_tsc "$config.diagnostics" -p "$config" --pretty false
  if grep -qvE '^$|^.+\([0-9]+,[0-9]+\): error TS[0-9]+: |^  ' "$workspace/$config.diagnostics" \
    || grep -qE 'error TS(5[0-9]{3}|6[0-9]{3}|18003):' "$workspace/$config.diagnostics"; then
    cat "$workspace/$config.diagnostics"
    echo "tsc cannot check $config"
    exit 2
  fi
  run_tsc "$config.files" -p "$config" --listFilesOnly
  run_tsc "$config.explained" -p "$config" --explainFiles --pretty false
}

# Prints "<package> (<count> files)" for each package the program reads declarations from that the pattern matches.
foreign_packages() {
  local config=$1 pattern=$2
  sed -n 's|^.*/node_modules/||p' "$workspace/$config.files" \
    | awk -F/ '{ print ($1 ~ /^@/) ? $1 "/" $2 : $1 }' \
    | grep -xE "$pattern" | sort | uniq -c | awk '{ printf "%s (%s files)\n", $2, $1 }' || true
}

# Prints the file and, under it, the first reasons tsc --explainFiles gives for reading it, without package ids, and how
# many more it gives.
explain_file() {
  local config=$1 file=$2 limit=$3
  awk -v file="$file" -v limit="$limit" '
    $0 == file { reading = 1; print file; next }
    reading && /^   / { if (shown++ < limit) { sub(/ with packageId .*$/, ""); sub(/^ +/, "    "); print } next }
    reading { reading = 0 }
    END { if (shown > limit) printf "    and %d more\n", shown - limit }
  ' "$workspace/$config.explained"
}

# Prints "<package> <count>" for each package whose declarations tsc reports errors in, the most first, and "app <count>"
# for the app's own files.
errors_by_package() {
  sed -n 's/^\(.*\)([0-9]*,[0-9]*): error TS[0-9]*:.*$/\1/p' "$workspace/$1.diagnostics" \
    | awk -F/ '{ if ($1 != "node_modules") print "app"; else print ($2 ~ /^@/) ? $2 "/" $3 : $2 }' \
    | sort | uniq -c | sort -k1,1nr -k2,2 | awk '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $2, $1 }'
}

# Prints the errors tsc reports in the declarations of the package the second argument names, the run's folder named
# <workspace>.
package_errors() {
  grep -E "^node_modules/$2/[^(]*\\([0-9]+,[0-9]+\\): error TS" "$workspace/$1.diagnostics" | sed "s|$workspace|<workspace>|g" \
    || true
}

# Prints its arguments' lines, leaving out the empty ones.
join_lines() {
  printf '%s\n' "$@" | sed '/^$/d'
}

# Ends the run with 2 when the program reads none of one's declarations or its own files cannot import one.
require_one() {
  local config=$1
  if ! grep -q '/node_modules/one/' "$workspace/$config.files"; then
    echo "$config reads none of one's declarations"
    exit 2
  fi
  if grep -E "^(app/|vite\\.config\\.ts)[^(]*\\([0-9]+,[0-9]+\\): error TS(2305|2307): .*'one(/vite)?'" \
    "$workspace/$config.diagnostics"; then
    echo "$config cannot import one"
    exit 2
  fi
}

check_program tsconfig.native.json
check_program tsconfig.vite.json
require_one tsconfig.native.json
require_one tsconfig.vite.json
native_foreign=$(foreign_packages tsconfig.native.json '@types/node|vite')
vite_foreign=$(foreign_packages tsconfig.vite.json 'react-native')
native_one_errors=$(package_errors tsconfig.native.json one)
vite_one_errors=$(package_errors tsconfig.vite.json one)
native_compiler_errors=$(package_errors tsconfig.native.json @vxrn/compiler)
vite_compiler_errors=$(package_errors tsconfig.vite.json @vxrn/compiler)
native_package_errors=$(join_lines "$native_one_errors" "$native_compiler_errors")
vite_package_errors=$(join_lines "$vite_one_errors" "$vite_compiler_errors")

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
  '@types/node and vite' "$native_foreign" "$native_package_errors" \
  'node_modules/@types/node/index.d.ts:1' 'node_modules/vite/dist/node/index.d.ts:2' \
  'node_modules/one/types/vite/types.d.ts:10'
report_program tsconfig.vite.json "vite.config.ts with Node's types" \
  'react-native' "$vite_foreign" "$vite_package_errors" \
  'node_modules/react-native/types_generated/index.d.ts:1' 'node_modules/one/types/interfaces/router.d.ts:1'

if [ -z "$native_foreign$vite_foreign$native_package_errors$vite_package_errors" ]; then
  echo "neither program reads the other's declarations, and neither reports an error in one's or @vxrn/compiler's declarations"
  exit 0
fi
problems=()
[ -z "$native_foreign" ] || problems+=("the React Native program reads Node's and Vite's declarations")
[ -z "$vite_foreign" ] || problems+=("the Vite program reads React Native's")
[ -z "$native_one_errors$vite_one_errors" ] || problems+=("tsc reports errors in one's declarations")
[ -z "$native_compiler_errors$vite_compiler_errors" ] || problems+=("tsc reports errors in @vxrn/compiler's declarations")
summary=$(printf '%s; ' "${problems[@]}")
echo "${summary%; }"
exit 1
