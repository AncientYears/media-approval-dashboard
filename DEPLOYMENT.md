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

Dashboard on `:3000`, qBittorrent WebUI on `:8080`, Seerr (request portal) on
`:5055`. No Radarr or Sonarr — the app is fully arr-free.

Re-running `setup.sh` after a `git pull` rebuilds and reinstalls. It preserves
`.env`, `data/` and `node_modules`.

## Requirements

- Node.js 20+ (uses `better-sqlite3` v12 prebuilds)
- Debian/Ubuntu; `ffmpeg`, `mkvtoolnix` (mkvmerge), `mediainfo` from apt
- `qbittorrent-nox` from apt — note the **nox build still serves the full WebUI**
  on port 8080, it only drops the desktop tray icon

## Services (arr-free stack)

No Sonarr/Radarr anywhere. The pieces the app talks to:

- **Prowlarr** — search indexers directly, custom queries, season filters.
  Configured in `.env` (`PROWLARR_URL` / `PROWLARR_API_KEY`).
- **Seerr** — the request portal. The app syncs its request list into
  `media_requests` (`SEERR_URL` / `SEERR_API_KEY`; key from Seerr
  Settings → Main → API Key). Seerr itself needs **zero** arr connections — it
  only tracks requests; downloading/searching is the dashboard's job.
- **TMDB** — episode metadata for native franchises and Discover
  (`TMDB_API_KEY`). Optional but recommended; without it episode grids fall
  back to gap detection from filenames.
- **qBittorrent** — downloads, magnets grabbed directly by the app
  (`QBIT_URL` / `QBIT_USER` / `QBIT_PASS`).
- **ntfy** — optional change notifications (`NTFY_URL` / `NTFY_TOPIC`).

Radarr/Sonarr env vars are **optional legacy** — leave unset for arr-free mode
(the pollers and fallback search paths stay dormant).

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

### Jellyfin (separate VM)

Jellyfin runs on its own VM but saves `.nfo` sidecars **into** the library
folders, so it needs write access to `/media/{Filmy,Serialy}` — not just read.

**Access must come from the service's primary `Group=`, not supplementary
groups.** This export does not honour supplementary group membership: uid 103
with GID 1000 in its supplementary list still gets `EACCES`, while the same uid
with GID 1000 as its *primary* group writes fine. Verified directly:

```bash
# on the Jellyfin VM — the first fails, the second succeeds
sudo setpriv --reuid=103 --regid=103 --groups=103,1000 -- touch /media/.grouptest/a
sudo setpriv --reuid=103 --regid=1000 --groups=1000        -- touch /media/.grouptest/b
```

So `usermod -aG 1000 jellyfin` achieves nothing here, and the fix is a systemd
drop-in instead:

```ini
# /etc/systemd/system/jellyfin.service.d/override.conf
[Service]
User=jellyfin
Group=ancient
```

This keeps Jellyfin on its own uid (`User=jellyfin`, uid 103) and grants access
through its primary group — per-service identity is preserved, which matters
because a service sharing the app's uid could delete or rename library media.

Two things that look like failures but aren't:

- `ls /var/lib/jellyfin/data` → `Permission denied` as any other user. It's
  `0750 jellyfin:jellyfin`; `other` has no bits. Use `sudo`.
- `SQLite Error 14: 'unable to open database file'` at startup means SQLite
  couldn't write *in the directory*. It usually means a `chown` was applied
  while a **previous instance was still running** and recreated files as the
  old uid. Stop first, then chown, then start:

  ```bash
  sudo systemctl stop jellyfin
  sudo chown -R jellyfin:jellyfin /var/lib/jellyfin /var/cache/jellyfin /var/log/jellyfin /etc/jellyfin
  sudo systemctl start jellyfin
  ```

  These four trees are local disk, not the NFS export, so ownership is fully
  under local control — `chown -R` is authoritative there.

Because gid 1000 spans the whole media tree, Jellyfin can write anywhere under
`/media`, including `/media/Torrents/download`, which is immutable and seeds
forever. Harmless while its libraries are only `Filmy`/`Serialy`, and shrinkable
with a more specific read-only export (NFS matches the longest path prefix) if
that ever stops being true.

Inotify does not cross NFS, so Jellyfin will not notice a Fix Names rename on
its own — refresh the library manually after renaming.

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

**Jellyfin can't save `.nfo`** — it has no write access to the library folders,
and adding it to a group won't help because supplementary groups aren't honoured
on this export. See Permissions → Jellyfin.

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
