#!/usr/bin/env bash
# `Tabs` and `Stack` are typed as `ReturnType<typeof withLayoutContext>`, which loses the navigators' option types:
# `Tabs`' screenOptions, `Tabs.Screen`'s options and `Stack`'s screenOptions accept any option, and a `tabBarIcon`
# callback's parameter gets no type. The script builds the workspace, installs repro/ in a folder outside it from the
# workspace's packed packages (use-workspace-packages.mjs), and type-checks options/ there with tsconfig.options.json
# (strict, skipLibCheck): options/valid.tsx uses options the navigators have, and each marked line of
# options/invalid.tsx passes one they do not have. It prints tsc's errors in valid.tsx and, for each line of
# invalid.tsx, the error tsc reports on it.
# Exits 1 while valid.tsx fails with TS7031 or a line of invalid.tsx compiles; 0 once valid.tsx compiles and every line
# of invalid.tsx fails; 2 when a step before the check fails, tsc cannot check the program, or valid.tsx fails another
# way.
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
workspace=$(mktemp -d "${TMPDIR:-/tmp}/options.XXXXXX")
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

tsc_status=0
./node_modules/.bin/tsc -p tsconfig.options.json --pretty false 2>&1 | tr -d '\r' > "$workspace/diagnostics" \
  || tsc_status=$?
if [ "$tsc_status" -gt 2 ] || grep -qE 'error TS(5|6)[0-9]{3}' "$workspace/diagnostics"; then
  cat "$workspace/diagnostics"
  echo "tsc cannot check tsconfig.options.json (exit $tsc_status)"
  exit 2
fi
marked_pattern='notATabsOption|notAStackOption|tabBarIcon: 42'
marked_lines=$(grep -cE "$marked_pattern" options/invalid.tsx || true)
if [ "$marked_lines" -ne 5 ]; then
  echo "options/invalid.tsx holds $marked_lines marked lines, not 5"
  exit 2
fi
marked_entries=$(grep -nE "$marked_pattern" options/invalid.tsx)
valid_errors=$(grep -E '^options/valid\.tsx\([0-9]+,[0-9]+\): error TS' "$workspace/diagnostics" || true)
valid_other_errors=$(printf '%s' "$valid_errors" | grep -v ': error TS7031: ' || true)

echo
echo "$typescript_version"
echo "\$ tsc -p tsconfig.options.json   (strict, skipLibCheck)"
echo "options/valid.tsx:"
printf '%s\n' "${valid_errors:-  no errors}" | sed 's/^options/  options/'
echo "options/invalid.tsx, each line passing an option its navigator does not have:"
compiling_lines=0
while IFS= read -r numbered; do
  line=${numbered%%:*}
  code=${numbered#*:}
  code=${code#"${code%%[![:space:]]*}"}
  error=$(grep -E "^options/invalid\.tsx\($line,[0-9]+\): error TS" "$workspace/diagnostics" | head -n 1 || true)
  if [ -z "$error" ]; then
    compiling_lines=$((compiling_lines + 1))
    echo "  line $line: $code   -> compiles"
  else
    echo "  line $line: $code   -> ${error#*: }"
  fi
done <<< "$marked_entries"

if [ -n "$valid_other_errors" ]; then
  echo "options/valid.tsx fails another way"
  exit 2
fi
if [ -z "$valid_errors" ] && [ "$compiling_lines" -eq 0 ]; then
  echo "options/valid.tsx compiles, and every option the navigators do not have fails"
  exit 0
fi
problems=()
[ -z "$valid_errors" ] || problems+=("tabBarIcon's parameter is implicitly any")
[ "$compiling_lines" -eq 0 ] || problems+=("$compiling_lines of the options the navigators do not have compile")
summary=$(printf '%s; ' "${problems[@]}")
echo "${summary%; }"
exit 1
