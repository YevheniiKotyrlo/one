#!/usr/bin/env bash
# Installs vxrn from npm and asks loadEnv for the env files of a root other than the working directory.
set -euo pipefail
cd "$(dirname "$0")"
if ! npm install --no-audit --no-fund --loglevel=error > npm-install.log 2>&1; then
  cat npm-install.log
  echo "result: npm install failed"
  exit 2
fi
node reproduce.mjs
