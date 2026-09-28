#!/usr/bin/env bash
#
# Pull, rebuild, and restart after a code change:
#
#   ./update.sh
#
# setup.sh owns dependency install, the build, and unit installation, so this
# only adds the pull and the restart. Keeping the build in one place avoids the
# two drifting apart.
#
# Only media-approval-app needs a restart for code changes — it runs dist/ and
# serves public/. qbittorrent-nox runs no code from this repo, so it is
# restarted only when its unit file actually changed. Restarting it needlessly
# interrupts active transfers.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

QBIT_UNIT=/etc/systemd/system/qbittorrent-nox.service
before=""
[ -r "$QBIT_UNIT" ] && before="$(cat "$QBIT_UNIT")"

git pull --ff-only

sudo APP_USER="${SUDO_USER:-$(id -un)}" "$APP_DIR/setup.sh"

sudo systemctl restart media-approval-app

# setup.sh re-templates the unit every run, so compare rather than assume.
after=""
[ -r "$QBIT_UNIT" ] && after="$(cat "$QBIT_UNIT")"

if [ "$before" != "$after" ]; then
  sudo systemctl restart qbittorrent-nox
  printf '\n\033[1;34m==>\033[0m qbittorrent-nox unit changed — restarted\n'
else
  printf '\n\033[1;34m==>\033[0m qbittorrent-nox unchanged — left running\n'
fi

sudo systemctl --no-pager --lines=0 status media-approval-app qbittorrent-nox || true
