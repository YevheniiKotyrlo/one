#!/usr/bin/env bash
# Run from the repository root.
set -u
bun install
bun run build
cd repro
echo '$ one build'
bunx one build > build.log 2>&1
echo "one build exit code: $?"
grep 'INVALID_OPTION' build.log
node -e '
const { readdirSync, statSync } = require("node:fs")
const dir = "dist/client/assets"
const sizes = readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => [name, statSync(`${dir}/${name}`).size])
const small = sizes.filter(([, size]) => size < 42000)
console.log(`${dir}: ${sizes.length} JavaScript files, ${small.length} below 42000 bytes`)
for (const [name, size] of small.sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${size} ${name}`)
'
