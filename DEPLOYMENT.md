# Deployment Guide

Running directly on a VM. No containers — just systemd units and an NFS export
for the media tree.

## Architecture

```
Proxmox
├── app VM          media-approval-app + qbittorrent-nox   (systemd)
├── rob-r530        NFS server, exports /mnt/media
└── jellyfin VM     reads the library, no hardlink involvement
```

The app and qBittorrent **must** mount the shared storage at the **same absolute
path** (`/media`). See "Hardlinks" below for why this is not optional.

## Quick start

```bash
git clone https://github.com/AncientYears/media-approval-dashboard.git
cd media-approval-dashboard
sudo ./setup.sh              # installs deps, builds, installs units

sudo nano /opt/media-approval-dashboard/.env
systemctl enable --now qbittorrent-nox
systemctl enable --now media-approval-app
```

Dashboard on `:3000`, qBittorrent WebUI on `:8080`.

Re-running `setup.sh` after a `git pull` rebuilds and reinstalls. It preserves
`.env`, `data/` and `node_modules`.

## Requirements

- Node.js 20+ (uses `better-sqlite3` v12 prebuilds)
- Debian/Ubuntu; `ffmpeg`, `mkvtoolnix` (mkvmerge), `mediainfo` from apt
- `qbittorrent-nox` from apt — note the **nox build still serves the full WebUI**
  on port 8080, it only drops the desktop tray icon

## Hardlinks

Download → Processed → Library are hardlinks, not copies. This is the core
storage invariant and it drives every deployment decision:

- **Same path, both sides.** The app and qBittorrent must mount the storage at
  the same absolute path. Set `MEDIA_ROOT=/media` and leave `QBIT_PATH_PREFIX`
  and `QBIT_HOST_PREFIX` unset — the path conversions are then no-ops.
- **Same filesystem.** If they ever diverge, `processor.ts` catches the `EXDEV`
  error and silently falls back to `copyFileSync`. Nothing errors, you just end
  up with three full copies of every file. Watch disk usage.
- **Different VMs is fine.** The NFS server performs the link operation, so
  hardlinks work across VMs on one export. Performance is the cost, not
  correctness.
- **Never put the SQLite DB on NFS.** It stays local at `./data/app.db`; WAL
  mode over NFS is a corruption risk.

`systemd`'s `RequiresMountsFor=/media` in both units exists specifically to stop
these services from starting before the mount is ready.

## NFS export

On the storage host (`rob-r530`):

```
/mnt/media 192.168.1.28(rw,sync,no_subtree_check)
```

`root_squash` and `no_all_squash` appear in `exportfs -v` but are kernel
defaults, not settings — don't try to "fix" them in the file.

`noatime` is **not** a valid export option. It's a mount option, set on the
client:

```
# app VM /etc/fstab
192.168.1.18:/mnt/media /media nfs noatime,hard,proto=tcp,vers=4.2,_netdev 0 0
```

`hard` matters more than `noatime`: with `soft`, a server hiccup returns an I/O
error mid-write instead of blocking, which is how a torrent client ends up with
a corrupt state. `noatime` avoids a network round trip per read, which
qBittorrent does a lot of while seeding.

## Permissions

The app needs write access to these directories, and only these — Download
should stay read-only to it, since Download is immutable and seeds forever:

```
/media/Torrents/download/{filmy,serialy}   # qBittorrent writes
/media/Torrents/processed/{filmy,serialy}  # app hardlinks here
/media/Torrents/Workspace                  # app creates processing jobs
/media/Torrents/Trackers                   # app writes .torrent on destroy
/media/{Filmy,Serialy}                     # app hardlinks into the library
```

`Filmy` and `Serialy` are the Jellyfin library — the app only ever places
hardlinks there, so they must be on the same filesystem as `/media/Torrents`.

If those are `root:root`, grant write access with a **non-recursive** chown of
just those directories (the media files themselves do not need to change):

```bash
chown 1000:1000 \
  /mnt/media/Torrents/download/filmy /mnt/media/Torrents/download/serialy \
  /mnt/media/Torrents/processed/filmy /mnt/media/Torrents/processed/serialy \
    /mnt/media/Torrents/Workspace /mnt/media/Torrents/Trackers \
    /mnt/media/Filmy /mnt/media/Serialy
  ```

  **Run this on the NFS server, not on the app VM.** The export is mounted with
  `root_squash`, so root on the client maps to `nobody` and the chown fails with
  `Operation not permitted`. Log in to the server (`rob-r530`) and run it there,
  against the real export path.

  No `-R`, so it is instant and reversible with the same command plus `root:root`.
  Never `chown -R` the media tree.

Until this is done, the app runs but every move/import operation fails with
`EACCES`. Search, approve, the UI and the database all work fine.

## Configuration

`.env` — see `.env.example`. The app loads it itself via `dotenv`; do not use
`Environment=` in the unit for app settings.

The important one is `MEDIA_ROOT`, which every other path defaults from.
`QBIT_PATH_PREFIX` / `QBIT_HOST_PREFIX` are only for a legacy containerised
qBittorrent that reports a different prefix, and should normally both be unset.

## Operations

```bash
systemctl status  media-approval-app
systemctl restart media-approval-app
journalctl -u media-approval-app -f
journalctl -u media-approval-app -p err   # errors only
journalctl -u qbittorrent-nox -f
```

`journalctl` needs `sudo` unless your user is in `adm` or `systemd-journal`.
Both groups grant read access to *all* system logs, not just these units, so on a
single-admin box prefer `sudo journalctl -u <unit> -f`. Without it you get the
"You are currently not seeing messages from other users" hint and no output.

After a `git pull`: `sudo ./setup.sh && systemctl restart media-approval-app`.

## Troubleshooting

**Hardlinks silently copying** — the app and qBittorrent disagree on the mount
path, so `link()` returns `EXDEV` and `processor.ts` falls back to
`copyFileSync`. Check that both see the same absolute path.

**`EACCES` on move/import** — the write directories above aren't writable. See
Permissions.

**qBittorrent marks torrents as errored on start** — it started before the NFS
mount was ready. `RequiresMountsFor=/media` should prevent this; check with
`systemctl show qbittorrent-nox | grep -i mount`.

**Frontend shows the JSON API instead of the UI** — `public/` wasn't published.
Re-run `setup.sh`; it copies `frontend/dist` to `public/` because `server.ts`
serves `../public` relative to `dist/`.

**Path env vars seem ignored** — `config/paths.ts` reads `process.env` at module
load, which happens before `server.ts` calls `dotenv.config()`. It therefore
calls `dotenv.config()` itself. If you add another module that reads env at
import time, it needs the same.
