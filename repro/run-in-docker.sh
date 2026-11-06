#!/usr/bin/env bash
# Runs repro/reproduce.sh in Docker's node:26 image, with Docker's init as PID 1, on a copy of this checkout's files
# (what git tracks and the new files it does not ignore), and exits as the container's script does when that is 0 or 1;
# 2 when a step before it fails, docker starts no container, or the run ends any other way.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
changed=$(git status --porcelain | wc -l)
checkout="checkout at $revision"
[ "$((changed))" -eq 0 ] || checkout="$checkout, $((changed)) files changed since"
scratch=$(mktemp -d)
# Removes the scratch folder without changing the exit status.
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$scratch" 2> /dev/null; exit "$exit_status"' EXIT
archive=$scratch/checkout.tar
git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -T - -cf "$archive"
# docker writes the container's id to a path of its host's own shape, which Git Bash on Windows needs spelled out.
container_id_file=$(cd "$scratch" && { pwd -W 2> /dev/null || pwd; })/container-id
docker pull --quiet node:26 > /dev/null
run_status=0
docker run --rm -i --init --cidfile "$container_id_file" -e CHECKOUT="$checkout" node:26 bash -c '
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
' < "$archive" || run_status=$?
if [ ! -s "$scratch/container-id" ]; then
  echo "docker started no container" >&2
  exit 2
fi
case $run_status in
  0 | 1) exit "$run_status" ;;
  *)
    echo "docker run ended with $run_status" >&2
    exit 2
    ;;
esac
