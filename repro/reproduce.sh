#!/usr/bin/env bash
# `bun audit` in an app on one 2.13.4 reported moderate advisories that came in through One's own dependencies.
# repro/ installs one from npm, as a new app does, at the version repro/package.json names.
# Exits 1 while bun audit reports one of those advisories, 0 once it reports none, and 2 when a setup step fails or
# bun audit prints no verdict.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
bun install
mkdir -p tmp
one_version=$(node -p "require('one/package.json').version")
vxrn_version=$(node -p "require('vxrn/package.json').version")
create_vxrn_version=$(node -p "require('create-vxrn/package.json').version")
echo
echo "one $one_version, vxrn $vxrn_version, create-vxrn $create_vxrn_version"
echo '$ bun audit'
bun audit 2>&1 | tee tmp/audit.log || true
grep -q -E '^(No vulnerabilities found|[0-9]+ vulnerabilit)' tmp/audit.log || { echo "bun audit printed no verdict" >&2; exit 2; }
grep -q -e GHSA-rmxm-3fg6-px4f -e GHSA-3g3m-2fjr-6pw4 -e GHSA-g3hv-75wg-m249 tmp/audit.log || exit 0
exit 1
