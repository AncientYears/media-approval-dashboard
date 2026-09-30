# Media Approval Dashboard

A self-hosted, **fully arr-free** media approval gateway. Requests come in from
**Seerr** (or **TMDB Discover**), search hits **Prowlarr** directly, downloads
run through **qBittorrent**, and hardlinked files are processed into a Jellyfin
library — no Sonarr or Radarr required. Sonarr/Radarr integration remains in the
codebase as an optional, legacy feature; the deployed mode runs without them.

## Features

- **Approval Dashboard** — Pending requests + managed media with franchise grouping, colored filled/missing badges
- **Seerr Sync** — Pulls Seerr requests (movies + per-season series) into `media_requests`, reconciles deletions both ways
- **TMDB Discover** — Arr-free request button: search TMDB, pick, request, then search via Prowlarr
- **Prowlarr Search** — Direct indexer search with custom queries, quality scoring, and season filtering
- **Franchise Management** — 2-layer UI: season overview with expandable episode grid, then deep-dive per season
- **Episode Coverage** — Track which episodes are downloaded per season with FILLED/MISSED badges from TMDB, quality tags from approved releases
- **Season Pack Detection** — Season packs (S02 without E##) automatically cover all episodes, quality parsed from title
- **Release Comparison** — Sortable table with app scoring, quality breakdown, seeder counts (all columns sortable)
- **Search Modes** — Season pack search or individual episode search per season
- **Hardlink Processing** — mkvmerge/ffmpeg pipeline for audio codec conversion, subtitle stripping, format modification
- **Workspaces** — Persistent per-job scratch spaces with named jobs, notes, and custom scripts; outputs moved to /Processed
- **Torrent Management** — Pause, resume (single or franchise-level), move to library, process, remove from library
- **Live Search Progress** — SSE streaming shows progress per season/episode
- **Scan Downloads** — Match existing qBittorrent torrents to requests (arr-free native matching), fix status/season mismatches, backfill approvals
- **Library Audit & Adoption** — Inode-based reconcile between the library and /Processed; adopt orphaned library files back into the tree
- **Destroy** — Export .torrent + tracker metadata, optionally remove from qBittorrent, files preserved to /Processed
- **Dark Theme** — Full responsive dark UI

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Frontend   │────▶│   Backend    │────▶│   Prowlarr    │
│   (React)    │     │   (Express)  │     │   (search)    │
└─────────────┘     └──────┬───────┘     └───────────────┘
                           │
              ┌────────────┼───────────┬────────────┐
              ▼            ▼           ▼            ▼
         ┌─────────┐ ┌────────────┐ ┌─────────┐ ┌──────────┐
         │  TMDB   │ │   Seerr    │ │qBittorrent│ │ Jellyfin │
         │(metadata)│ │(requests) │ │(torrents)│ │ (library)│
         └─────────┘ └────────────┘ └─────────┘ └──────────┘
```

Search and grabs go Prowlarr → qBittorrent directly via magnet. Radarr/Sonarr
(optional legacy) are not part of this deployment.

## Folder Structure

```
/media/Torrents/
├── Download/              # IMMUTABLE — qBittorrent seeds from here forever
│   ├── Filmy/             #   Movies download destination
│   └── Serialy/           #   TV shows download destination
│
├── Workspace/             # EPHEMERAL — scratch space for processing jobs
│   └── {request_id}-{sanitized_name}/
│       ├── inputs/        #   Hardlinks from Download (read-only source)
│       └── output/        #   Processed files (mkvmerge/ffmpeg output)
│
└── Processed/             # STAGING — ready for library import
    ├── Filmy/             #   Processed movies awaiting library import
    └── Serialy/           #   Processed TV shows awaiting library import

/media/
├── filmy/                 # LIBRARY — Jellyfin movie library
└── serialy/               # LIBRARY — Jellyfin TV library
```

### Data Flow

```
qBittorrent
     │
     ▼
/Download (immutable, always seeds from here)
     │
     ├────── [no processing needed] ────── hardlink to /Processed ──┐
     │                                                              │
     └────── [processing needed] ── hardlink to /Workspace          │
              │                                                     │
              ▼                                                     │
         /Workspace/{id}-{name}/                                    │
              inputs/  →  mkvmerge/ffmpeg  →  output/              │
              │                                                     │
              └──── move output to /Processed ──┘                   │
                                                                      │
                                                       /Processed    │
                                                          │          │
                                                          ▼          │
                                     native library import (inode reconcile)
                                                          │          │
                                                          ▼          │
                                                        /Library     │
```

### Key Principles
- **Download is immutable**: never modify, never delete while seeding
- **Workspace is ephemeral**: cleaned up after each processing job
- **Processed is the modifiable working set**: the app owns it; library import reconciles it by inode
- **Hardlinks everywhere**: zero extra disk space, original untouched
- **Library is the presentation layer**: files hardlinked from /Processed, reconciled by `stat().ino` — never matched on title

## Quick Start

### Production (bare VM, systemd)

See **DEPLOYMENT.md**. No containers — systemd units + an NFS export for the media tree.

### Local Development

```bash
cp .env.example .env
# Edit .env: at minimum Prowlarr + qBittorrent. Seerr/TMDB/ntfy optional but recommended.

# Backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PROWLARR_URL` | Prowlarr API URL (search indexers directly) |
| `PROWLARR_API_KEY` | Prowlarr API key |
| `SEERR_URL` | Seerr API URL (request portal sync, e.g. http://...:5055) |
| `SEERR_API_KEY` | Seerr API key (Settings → Main → API Key) |
| `TMDB_API_KEY` | TMDB API key (arr-free episode grids + Discover) |
| `TMDB_LANGUAGE` | TMDB language for episode titles (e.g. `pl-PL`) |
| `QBIT_URL` | qBittorrent Web UI URL |
| `QBIT_USER` | qBittorrent username |
| `QBIT_PASS` | qBittorrent password |
| `NTFY_URL` | ntfy server URL |
| `NTFY_TOPIC` | ntfy notification topic |
| `POLL_INTERVAL_STATUS` | Status poll interval in seconds (default: 30) |
| `POLL_INTERVAL_SEERR` | Seerr sync poll in seconds (default: 60) |
| `MEDIA_MOVIES` | Library path for movies (for move-to-library) |
| `MEDIA_TV` | Library path for TV shows |
| `DOWNLOADS_MOVIES` | Download path for movies (hardlink source) |
| `DOWNLOADS_TV` | Download path for TV shows (hardlink source) |
| `PROCESSED_MOVIES` | Processed/staging path for movies |
| `PROCESSED_TV` | Processed/staging path for TV shows |
| `PROCESSING_WORKSPACE` | Temp workspace for mkvmerge/ffmpeg processing |
| `RADARR_URL`/`RADARR_API_KEY` | **Optional legacy** — Radarr (only used if both set) |
| `SONARR_URL`/`SONARR_API_KEY` | **Optional legacy** — Sonarr (only used if both set) |
| `POLL_INTERVAL_RADARR`/`POLL_INTERVAL_SONARR` | Legacy pollers (off when arrs unconfigured) |

## API Endpoints

### Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests` | List all requests |
| GET | `/api/requests/:id` | Request detail + releases |
| POST | `/api/requests/:id/search` | Search releases (SSE, Prowlarr) |
| POST | `/api/requests/:id/approve` | Approve + grab via magnet (Prowlarr) |
| POST | `/api/requests/:id/dismiss` | Delete release candidate (no file deletion; propagates to Seerr) |
| POST | `/api/requests/:id/set-status` | Manual status fix |
| POST | `/api/requests/:id/move-to-library` | Hardlink to library path, marks COMPLETED |
| POST | `/api/requests/:id/move-to-processed` | Hardlink from Download to Processed staging |
| POST | `/api/requests/:id/move-to-workspace` | Hardlink from Download to workspace inputs |
| POST | `/api/requests/:id/process` | Process download through mkvmerge/ffmpeg |
| POST | `/api/requests/:id/remove-from-library` | Remove hardlinks from library |
| POST | `/api/requests/:id/torrent/pause` | Pause torrent (single or franchise-level) |
| POST | `/api/requests/:id/torrent/resume` | Resume torrent (single or franchise-level) |
| POST | `/api/requests/:id/destroy/:releaseId` | Export torrent metadata, remove from qBittorrent, files → /Processed |
| GET | `/api/requests/:id/torrent-statuses` | Approved torrent statuses for a request |
| DELETE | `/api/requests/:id` | Delete request + torrent (propagates to Seerr) |

### Managed / Franchise

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests/managed` | Managed media list (series + movies with releases) |
| GET | `/api/requests/managed/:sonarrId` | Legacy franchise detail (all seasons, releases, coverage) |
| GET | `/api/requests/native-franchise/:id` | Native (arr-free, TMDB-backed) franchise detail |
| POST | `/api/requests/native-franchise/:id/fix-identity` | Repair polluted `library_key` identity |
| POST | `/api/requests/managed/:sonarrId/search-all` | Parallel season search (SSE, Prowlarr) |
| POST | `/api/requests/managed/search-all-movies` | Parallel movie search (SSE, Prowlarr) |
| DELETE | `/api/requests/managed/:sonarrId` | Delete legacy franchise (all seasons) |

### Discovery / Sync / Reconcile

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests/discover?q=` | TMDB search (movies + series combined) |
| GET | `/api/requests/discover/tv/:tmdbId/seasons` | TMDB season list (S00 excluded) |
| POST | `/api/requests/discover/request` | Create native request from a Discover pick |
| POST | `/api/requests/seerr/sync` | Manual Seerr request sync (also polls on interval) |
| POST | `/api/requests/import-library/native` | Arr-free library reconcile (dry run unless `apply: true`) |
| GET | `/api/requests/library-audit` | Read-only per-show inode attribution report |
| POST | `/api/requests/adopt-into-processed` | Hardlink orphaned library files back into /Processed |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/requests/detect-torrents` | Match existing qBittorrent torrents to requests |
| POST | `/api/requests/scan-downloads` | Full torrent scan: match (arr-free native), fix status/season, backfill approvals |
| POST | `/api/requests/cleanup` | Reset stuck requests, clean orphaned RCs |
| POST | `/api/requests/cleanup-duplicates` | Find and merge duplicate requests |
| POST | `/api/requests/remove-titles` | Remove specific entries by title |
| GET | `/api/requests/test-connections` | Test Prowlarr/qBittorrent/Seerr (and optional arrs) connectivity |
| GET | `/api/requests/db/:table` | Browse any DB table (read-only) |
| GET | `/api/db` | Browse all tables |

## Search Flow

1. User types a query (or uses default franchise/season title)
2. Backend queries Prowlarr with the term + TV/movie categories
3. Results are scored (quality, custom formats, size, rank, seeders) and stored
4. SSE streams progress to frontend
5. User reviews results in a sortable table, expands to see score breakdown
6. Approve grabs via magnet URL straight into qBittorrent (no Sonarr/Radarr involved)

## Approval Flow

- **Prowlarr results** (40-char infoHash): grabbed directly via qBittorrent magnet URL
- **Sonarr/Radarr results** (legacy mode only): grabbed through their native release endpoint
- Status transitions: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING → COMPLETED (manual move-to-library)

## Scan Downloads

Local-first torrent matching process:
1. Fetches all torrents from qBittorrent
2. Separates already-tracked (hash in DB) vs new torrents
3. **New torrents**: matches by title against known native titles / TMDB; creates request + RC + approval
4. **Existing torrents**: backfills missing approvals, removes stale approvals (torrent gone from qBittorrent), fixes stale statuses, detects season mismatches
5. Quality parsed from torrent title (source: WEBDL/WEBRip/Bluray × resolution: 1080p/2160p)

## Processing Pipeline

Hardlink processing for format modification:
1. Copy download content to processing workspace
2. **mkvmerge**: strip/keep audio tracks, remove subtitles
3. **ffmpeg**: audio codec conversion (fallback when mkvmerge unavailable)
4. Move/hardlink result to Processed folder
5. Clean up workspace

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, Vite, TypeScript, React Router
- **Services**: Prowlarr API, TMDB API, Seerr API, qBittorrent Web API v2 (optional legacy: Radarr API v3, Sonarr API v3)
- **Database**: SQLite with WAL mode
- **Processing**: mkvmerge, ffmpeg (optional)
- **Deployment**: bare VM with systemd units + NFS (see DEPLOYMENT.md)

## License

MIT