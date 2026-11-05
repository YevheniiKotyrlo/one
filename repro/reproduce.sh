#!/usr/bin/env bash
# `bun audit` in an app on one 2.13.4 reports moderate advisories that come in through One's own dependencies.
# repro/ installs one from npm, as a new app does, at the versions repro/bun.lock pins.
# Exits 1 while bun audit reports one of those advisories, 0 once it reports none, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
bun install
mkdir -p tmp
echo
echo "one $(node -p "require('one/package.json').version"), vxrn $(node -p "require('vxrn/package.json').version"), create-vxrn $(node -p "require('create-vxrn/package.json').version")"
echo '$ bun audit'
bun audit 2>&1 | tee tmp/audit.log || true
grep -q -e GHSA-rmxm-3fg6-px4f -e GHSA-3g3m-2fjr-6pw4 -e GHSA-g3hv-75wg-m249 tmp/audit.log || exit 0
exit 1
