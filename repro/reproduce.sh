#!/usr/bin/env bash
# `one`, `vxrn` and `@vxrn/compiler` are ES module packages ("type": "module"), so under moduleResolution node16 or
# nodenext TypeScript needs each relative import in their declarations to name its file extension, and they name none.
# The script builds the workspace, installs repro/ in a folder outside it from the workspace's packed packages
# (use-workspace-packages.mjs), and type-checks tsconfig.nodenext.json there (module and moduleResolution NodeNext,
# Node's types): vite.config.ts, which imports `one/vite`, and nodenext-packages.ts, which imports the types of `vxrn`
# and `@vxrn/compiler` that one/vite's declarations import. For each of the checkout's packages it prints how many of
# its declaration files the program reads and how many relative imports without an extension tsc reports in them
# (TS2834, TS2835), with the first; then how many other errors tsc reports in them.
# Exits 1 while tsc reports a relative import without an extension in a declaration of one, vxrn or @vxrn/*; 0 once it
# reports none; 2 when a step before the check fails, tsc cannot check the program (it exits other than 0 or 1, prints
# what is not a diagnostic of a file, or reports a configuration error), the program reads none of one's declarations,
# or vite.config.ts or nodenext-packages.ts fails.
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
workspace=$(mktemp -d "${TMPDIR:-/tmp}/nodenext.XXXXXX")
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

run_tsc diagnostics -p tsconfig.nodenext.json --pretty false
if grep -qvE '^$|^.+\([0-9]+,[0-9]+\): error TS[0-9]+: |^  ' "$workspace/diagnostics" \
  || grep -qE 'error TS(5[0-9]{3}|6[0-9]{3}|18003):' "$workspace/diagnostics"; then
  cat "$workspace/diagnostics"
  echo "tsc cannot check tsconfig.nodenext.json"
  exit 2
fi
run_tsc files -p tsconfig.nodenext.json --listFilesOnly
checkout_package='(one|vxrn|@vxrn/[^/]+)'
source_errors=$(grep -E '^(vite\.config|nodenext-packages)\.ts\([0-9]+,[0-9]+\): error TS' "$workspace/diagnostics" || true)
extension_errors=$(grep -E "^node_modules/$checkout_package/[^(]*\\([0-9]+,[0-9]+\\): error TS283[45]: " \
  "$workspace/diagnostics" || true)
other_count=$(grep -E "^node_modules/$checkout_package/[^(]*\\([0-9]+,[0-9]+\\): error TS" "$workspace/diagnostics" \
  | grep -vcE ': error TS283[45]: ' || true)

# Prints, for each of the checkout's packages the program reads or reports an error in, its declaration files read, its
# relative imports without an extension and the first of them.
report_packages() {
  local packages package files count first
  packages=$( {
    sed -n 's|^.*/node_modules/||p' "$workspace/files"
    printf '%s\n' "$extension_errors" | sed -n 's|^node_modules/||p'
  } | awk -F/ '{ print ($1 ~ /^@/) ? $1 "/" $2 : $1 }' | grep -xE "$checkout_package" | sort -u || true)
  for package in $packages; do
    files=$(grep -c "/node_modules/$package/" "$workspace/files" || true)
    count=$(printf '%s\n' "$extension_errors" | grep -c "^node_modules/$package/" || true)
    echo "$package: $files declaration files read, $count relative imports without an extension"
    first=$(printf '%s\n' "$extension_errors" | grep -m1 "^node_modules/$package/" || true)
    [ -z "$first" ] || echo "  $first"
  done
}

echo
echo "$typescript_version"
echo "\$ tsc -p tsconfig.nodenext.json   (vite.config.ts and nodenext-packages.ts, module and moduleResolution NodeNext)"
report_packages
echo "other errors in their declarations: $other_count"
[ -z "$source_errors" ] || printf '%s\n' "$source_errors"

if ! grep -q '/node_modules/one/' "$workspace/files"; then
  echo "the program reads none of one's declarations"
  exit 2
fi
if [ -n "$source_errors" ]; then
  echo "vite.config.ts or nodenext-packages.ts fails"
  exit 2
fi
extension_count=$(printf '%s' "$extension_errors" | grep -c . || true)
if [ "$extension_count" -eq 0 ]; then
  echo "the declarations of one, vxrn and @vxrn/* import no relative path without an extension under nodenext"
  exit 0
fi
echo "the declarations of one, vxrn and @vxrn/* import $extension_count relative paths without an extension, which nodenext cannot resolve"
exit 1
