#!/usr/bin/env bash
# Runs repro/reproduce.sh in Docker's node:26 image, with Docker's init as PID 1, on a copy of this checkout's files
# (what git tracks and the new files it does not ignore), and exits as the container's script does when that is 0 or 1;
# 2 when a step before it fails, the container never runs, or it ends any other way.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
changed=$(git status --porcelain | wc -l)
checkout="checkout at $revision"
[ "$((changed))" -eq 0 ] || checkout="$checkout, $((changed)) files changed since"
scratch=$(mktemp -d)
container=
trap '[ -z "$container" ] || docker rm --force "$container" > /dev/null 2>&1; rm -rf "$scratch"' EXIT
archive=$scratch/checkout.tar
git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -T - -cf "$archive"
# docker writes the container's id to a path of its host's own shape, which Git Bash on Windows needs spelled out.
container_id_file=$(cd "$scratch" && { pwd -W 2> /dev/null || pwd; })/container-id
docker pull --quiet node:26 > /dev/null
docker run -i --init --cidfile "$container_id_file" -e CHECKOUT="$checkout" node:26 bash -c '
  set -Eeuo pipefail
  trap "echo \"failed: \$BASH_COMMAND\" >&2; exit 2" ERR
  mkdir /one
  tar -C /one -xf -
  npm install --global --silent bun@1.4.4 > /tmp/npm-install.log 2>&1 || { cat /tmp/npm-install.log >&2; exit 2; }
  . /etc/os-release
  node_version=$(node --version)
  bun_version=$(bun --version)
  echo "$PRETTY_NAME, node $node_version, bun $bun_version, $CHECKOUT"
  exec bash /one/repro/reproduce.sh
' < "$archive" || true
if [ ! -s "$scratch/container-id" ]; then
  echo "docker run started no container" >&2
  exit 2
fi
container=$(cat "$scratch/container-id")
state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")
case $state in
  'exited 0') exit 0 ;;
  'exited 1') exit 1 ;;
  *)
    echo "the container ended as: $state" >&2
    exit 2
    ;;
esac
