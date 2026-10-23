#!/usr/bin/env bash
# CI only: apt-get install that fails fast on a crawling mirror (same pattern
# as #153). Seen 2026-10-23: azure.archive.ubuntu.com served indexes fast but
# .debs at ~3 kB/s. Each attempt is capped; after a failure the next attempt
# uses archive.ubuntu.com (downloaded .debs stay cached).
# Usage: scripts/ci-apt-install.sh ATTEMPTS SECONDS_PER_ATTEMPT PKG...
set -euo pipefail
attempts=$1
cap=$2
shift 2
export DEBIAN_FRONTEND=noninteractive
sudo rm -f /var/lib/man-db/auto-update
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=60)
for attempt in $(seq 1 "$attempts"); do
  if sudo timeout "$cap" apt-get "${opts[@]}" update &&
     sudo --preserve-env=DEBIAN_FRONTEND timeout "$cap" apt-get "${opts[@]}" install -y "$@"; then
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "apt failed after $attempts attempts" >&2
    exit 1
  fi
  echo "apt attempt $attempt failed (exit 124 = timed out); retrying on archive.ubuntu.com in 10s"
  pgrep -a "apt|dpkg|unattended" || true
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    printf 'http://archive.ubuntu.com/ubuntu/\tpriority:1\n' | sudo tee /etc/apt/apt-mirrors.txt
  fi
  sudo sed -i 's#http://azure.archive.ubuntu.com/ubuntu#http://archive.ubuntu.com/ubuntu#g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  sleep 10
done
