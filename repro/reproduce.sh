#!/usr/bin/env bash
# Run from the repository root: repro/ installs one from npm, as a new app does.
set -u
cd repro
bun install > /dev/null 2>&1
echo "one $(node -p "require('one/package.json').version"), vxrn $(node -p "require('vxrn/package.json').version"), create-vxrn $(node -p "require('create-vxrn/package.json').version")"
echo '$ bun audit'
bun audit
