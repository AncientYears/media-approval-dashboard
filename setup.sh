#!/usr/bin/env bash
#
# Setup for running the media approval dashboard directly on a VM (no Docker).
# Installs system dependencies, builds the backend and frontend, and installs
# the systemd units.
#
# Run from the clone:
#   sudo ./setup.sh
#
# Services run as the user who invoked sudo, not root — override with APP_USER.
# A root-owned app means a root-owned data/app.db and a root-owned HTTP API
# listening on the LAN.
#
# Re-runnable: safe to run again after `git pull` to rebuild and reinstall.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
SCRIPT_DIR="$APP_DIR"
APP_USER="${APP_USER:-${SUDO_USER:-$(id -un)}}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve the real home from passwd; do not rely on systemd's %h specifier.
# The `|| true` matters: pipefail would otherwise abort the script on a missing
# user before the check below can report it.
APP_HOME="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$APP_HOME" ] || die "No home directory found for user '$APP_USER'"

cd "$APP_DIR"

# --------------------------------------------------------------- system deps
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ffmpeg \
  mkvtoolnix \
  mediainfo \
  ca-certificates \
  build-essential \
  python3

if ! command -v qbittorrent-nox >/dev/null 2>&1; then
  log "Installing qbittorrent-nox"
  apt-get install -y -qq qbittorrent-nox
fi

# ---------------------------------------------------------------------- node
log "Checking Node.js"
command -v node >/dev/null 2>&1 \
  || die "Node.js not found. Install Node 20+ (https://github.com/nodesource/distributions) then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] \
  || die "Node $(node -v) found but 20+ is required (better-sqlite3 prebuilds)."
log "Node $(node -v), npm $(npm -v)"

# --------------------------------------------------------------------- deps
# npm ci aborts entirely when package.json and the lockfile have drifted apart,
# which turns a stale lock into a dead deploy. Fall back to npm install rather
# than blocking on it.
install_deps() {
  cd "$1"
  if [ -d node_modules ]; then
    npm install --silent
  else
    npm ci --silent || npm install --silent
  fi
}

# --------------------------------------------------------------------- mount
if ! mountpoint -q /media 2>/dev/null; then
  printf '\033[1;33mWARNING\033[0m /media is not mounted. The app needs the media\n'
  printf '         export before move/import operations will work.\n'
fi

# --------------------------------------------------------------- hardlinks
# Library files under /media are owned by root (Radarr/Sonarr import as root),
# while the app runs as $APP_USER (uid 1000). fs.protected_hardlinks=1 (Debian
# default) refuses link() when the caller does not own the source inode, which
# makes adoption EPERM on every cross-owner hardlink. Weaker security — the
# tradeoff of allowing hardlinks to root-owned media — but required for
# adoption to work on this single-user box.
if [ "$(cat /proc/sys/fs/protected_hardlinks 2>/dev/null || echo 1)" != "0" ]; then
  log "Disabling fs.protected_hardlinks (cross-owner NFS hardlinks)"

  printf 'fs.protected_hardlinks=0\n' > /etc/sysctl.d/99-media-hardlinks.conf
  printf '0' > /proc/sys/fs/protected_hardlinks
fi

# ------------------------------------------------------------------ backend
log "Installing backend dependencies"
# build-essential/python3 are the fallback if better-sqlite3 has no prebuild
# for this Node version.
install_deps "$APP_DIR"

log "Building backend"
npm run build

# ----------------------------------------------------------------- frontend
log "Installing frontend dependencies"
install_deps "$APP_DIR/frontend"

log "Building frontend"
npm run build

# server.ts serves ../public relative to dist/, so the Vite output (frontend/dist)
# has to be published to <app>/public.
log "Publishing frontend to $APP_DIR/public"
rm -rf "$APP_DIR/public"
mkdir -p "$APP_DIR/public"
cp -r "$APP_DIR/frontend/dist/." "$APP_DIR/public/"

# --------------------------------------------------------------------- env
cd "$APP_DIR"
if [ ! -f .env ]; then
  log "Creating .env from .env.example"
  cp .env.example .env
  echo "    Edit $APP_DIR/.env and set QBIT_URL, QBIT_USER, QBIT_PASS"
fi
mkdir -p "$APP_DIR/data"
# This script runs under sudo, so npm ci and any prior run leave root-owned
# files behind. The app writes data/app.db, so that dir must be APP_USER's or
# SQLite fails to open the database after a restart.
chown -R "$APP_USER" "$APP_DIR/data"

# ------------------------------------------------------------------ systemd
log "Installing systemd units"
sed -e "s|@@APP_DIR@@|$APP_DIR|g" \
    -e "s|@@APP_USER@@|$APP_USER|g" \
    "$SCRIPT_DIR/deploy/media-approval-app.service" \
    > /etc/systemd/system/media-approval-app.service

sed -e "s|@@APP_USER@@|$APP_USER|g" \
    -e "s|@@APP_HOME@@|$APP_HOME|g" \
    "$SCRIPT_DIR/deploy/qbittorrent-nox.service" \
    > /etc/systemd/system/qbittorrent-nox.service

systemctl daemon-reload

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

$(log "Done — services were not started automatically.")

  Edit $APP_DIR/.env, then:

    systemctl enable --now qbittorrent-nox
    systemctl enable --now media-approval-app

  Dashboard:   http://$IP:3000
  qBittorrent: http://$IP:8080
  Logs:        sudo journalctl -u media-approval-app -f

  The app needs write access to the media directories before move/import
  works. See the Permissions section in DEPLOYMENT.md.
EOF
