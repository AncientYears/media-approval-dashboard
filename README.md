# Media Approval Dashboard

A self-hosted approval gateway for Radarr/Sonarr with qBittorrent and Prowlarr integration. Review, compare, approve, and track media releases before they download.

## Features

- **Approval Dashboard** — Pending requests + managed media with franchise grouping, colored filled/missing badges
- **Prowlarr Search** — Direct indexer search with custom queries, quality scoring, and season filtering
- **Franchise Management** — 2-layer UI: season overview with expandable episode grid, then deep-dive per season
- **Episode Coverage** — Track which episodes are downloaded per season with FILLED/MISSED badges from Sonarr, quality tags from approved releases
- **Season Pack Detection** — Season packs (S02 without E##) automatically cover all episodes, quality parsed from title
- **Release Comparison** — Sortable table with app scoring, quality breakdown, seeder counts (all columns sortable)
- **Search Modes** — Season pack search or individual episode search per season
- **Hardlink Processing** — mkvmerge/ffmpeg pipeline for audio codec conversion, subtitle stripping, format modification
- **Torrent Management** — Pause, resume (single or franchise-level), move to library, process, remove from library
- **Live Search Progress** — SSE streaming shows progress per season/episode
- **Dismiss** — Permanent release deletion (no file removal, blocked for active downloads)
- **Scan Downloads** — Match existing qBittorrent torrents to requests, fix status/season mismatches, backfill approvals
- **Import Missing** — Import Radarr/Sonarr items not yet in the DB
- **Cleanup** — Remove duplicates, stale requests, orphaned entries
- **Toast Notifications** — Non-intrusive feedback for all actions
- **Dark Theme** — Full responsive dark UI

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Frontend   │────▶│   Backend    │────▶│  Prowlarr     │
│   (React)    │     │   (Express)  │     │  (search)     │
└─────────────┘     └──────┬───────┘     └───────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌─────────┐ ┌─────────┐ ┌──────────┐
         │ Radarr  │ │ Sonarr  │ │qBittorrent│
         │ (movies)│ │ (series)│ │ (torrents)│
         └─────────┘ └─────────┘ └──────────┘
```

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
└── Processed/             # STAGING — ready for Sonarr/Radarr import
    ├── Filmy/             #   Processed movies awaiting library import
    └── Serialy/           #   Processed TV shows awaiting library import

/media/
├── filmy/                 # LIBRARY — Radarr-managed movie library
└── serialy/               # LIBRARY — Sonarr-managed TV library
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
              └──── hardlink output to /Processed ──┘               │
                                                                     │
                                                      /Processed    │
                                                         │          │
                                                         ▼          │
                                                   Sonarr/Radarr import
                                                         │          │
                                                         ▼          │
                                                       /Library     │
```

### Key Principles
- **Download is immutable**: never modify, never delete while seeding
- **Workspace is ephemeral**: cleaned up after each processing job
- **Processed is staging**: Sonarr/Radarr import from here and rename
- **Hardlinks everywhere**: zero extra disk space, original untouched
- **Library managed by Sonarr/Radarr**: they handle renaming and organization

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/AncientYears/media-approval-dashboard.git
cd media-approval-dashboard
cp .env.example .env
# Edit .env with your API keys
docker compose up -d --build
```

### Local Development

```bash
cp .env.example .env
# Edit .env

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
| `PROWLARR_URL` | Prowlarr API URL (enables direct indexer search) |
| `PROWLARR_API_KEY` | Prowlarr API key |
| `RADARR_URL` | Radarr API URL (e.g. http://192.168.1.100:7878) |
| `RADARR_API_KEY` | Radarr API key |
| `SONARR_URL` | Sonarr API URL |
| `SONARR_API_KEY` | Sonarr API key |
| `QBIT_URL` | qBittorrent Web UI URL |
| `QBIT_USER` | qBittorrent username |
| `QBIT_PASS` | qBittorrent password |
| `NTFY_URL` | ntfy server URL |
| `NTFY_TOPIC` | ntfy notification topic |
| `POLL_INTERVAL_RADARR` | Radarr poll interval in seconds (default: 60) |
| `POLL_INTERVAL_SONARR` | Sonarr poll interval in seconds (default: 60) |
| `POLL_INTERVAL_STATUS` | Status poll interval in seconds (default: 30) |
| `MEDIA_MOVIES` | Library path for movies (for move-to-library) |
| `MEDIA_TV` | Library path for TV shows |
| `DOWNLOADS_MOVIES` | Download path for movies (hardlink source) |
| `DOWNLOADS_TV` | Download path for TV shows (hardlink source) |
| `PROCESSED_MOVIES` | Processed/staging path for movies |
| `PROCESSED_TV` | Processed/staging path for TV shows |
| `PROCESSING_WORKSPACE` | Temp workspace for mkvmerge/ffmpeg processing |

## API Endpoints

### Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests` | List all requests |
| GET | `/api/requests/:id` | Request detail + releases |
| POST | `/api/requests/:id/search` | Search releases (SSE, Prowlarr + episode name) |
| POST | `/api/requests/:id/approve` | Approve + grab (magnet or Radarr/Sonarr) |
| POST | `/api/requests/:id/dismiss` | Delete release candidate (no file deletion) |
| POST | `/api/requests/:id/set-status` | Manual status fix |
| POST | `/api/requests/:id/move-to-library` | Hardlink to library path |
| POST | `/api/requests/:id/move-to-processed` | Hardlink from Download to Processed staging |
| POST | `/api/requests/:id/process` | Process download through mkvmerge/ffmpeg |
| POST | `/api/requests/:id/remove-from-library` | Remove hardlinks from library |
| POST | `/api/requests/:id/torrent/pause` | Pause torrent (single or franchise-level) |
| POST | `/api/requests/:id/torrent/resume` | Resume torrent (single or franchise-level) |
| GET | `/api/requests/:id/torrent-statuses` | Approved torrent statuses for a request |
| DELETE | `/api/requests/:id` | Delete request + torrent + Sonarr/Radarr entry |

### Managed / Franchise

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests/managed` | Managed media list (series + movies with releases) |
| GET | `/api/requests/managed/:sonarrId` | Franchise detail (all seasons, releases, coverage) |
| GET | `/api/requests/managed/:sonarrId/season/:season/episodes` | Sonarr episode list with coverage + quality |
| GET | `/api/requests/managed/:sonarrId/torrent-statuses` | Batch torrent statuses across all seasons |
| POST | `/api/requests/managed/:sonarrId/search-all` | Parallel season search (SSE, Prowlarr) |
| POST | `/api/requests/managed/search-all-movies` | Parallel movie search (SSE, Prowlarr) |
| DELETE | `/api/requests/managed/:sonarrId` | Delete entire franchise (all seasons + Sonarr entry) |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/requests/detect-torrents` | Match existing qBittorrent torrents to requests |
| POST | `/api/requests/scan-downloads` | Full torrent scan: match, fix status/season, backfill approvals |
| POST | `/api/requests/import-missing` | Import from Radarr/Sonarr |
| POST | `/api/requests/cleanup` | Reset stuck requests, clean orphaned RCs |
| POST | `/api/requests/cleanup-duplicates` | Find and merge duplicate requests |
| POST | `/api/requests/remove-titles` | Remove specific entries by title from DB + Sonarr/Radarr |
| GET | `/api/requests/test-connections` | Test Radarr/Sonarr/Prowlarr connectivity |
| GET | `/api/requests/db/:table` | Browse DB tables (media_requests, release_candidates, approval_history) |
| GET | `/api/db` | Browse all tables |

## Search Flow

1. User types a query (or uses default franchise/season title)
2. Backend queries Prowlarr with the term + TV/movie categories
3. Results are scored (quality, custom formats, size, rank, seeders) and stored
4. SSE streams progress to frontend
5. User reviews results in a sortable table, expands to see score breakdown
6. Approve grabs via magnet URL (Prowlarr) or Radarr/Sonarr release endpoint

## Approval Flow

- **Prowlarr results** (40-char infoHash): grabbed directly via qBittorrent magnet URL
- **Radarr/Sonarr results**: grabbed through their native release endpoint
- Status transitions: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING

## Scan Downloads

Local-first torrent matching process:
1. Fetches all torrents from qBittorrent
2. Separates already-tracked (hash in DB) vs new torrents
3. **New torrents**: matches by title against Radarr/Sonarr, creates request + RC + approval
4. **Existing torrents**: backfills missing approvals, removes stale approvals (torrent gone from qBittorrent), fixes stale statuses, detects season mismatches (RCs on wrong-season requests → deletes + re-imports)
5. Quality parsed from torrent title (source: WEBDL/WEBRip/Bluray × resolution: 1080p/2160p)

## Processing Pipeline

Hardlink processing for format modification:
1. Copy download content to processing workspace
2. **mkvmerge**: strip/keep audio tracks, remove subtitles
3. **ffmpeg**: audio codec conversion (fallback when mkvmerge unavailable)
4. Hardlink result to Processed folder
5. Clean up workspace

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, Vite, TypeScript, React Router
- **Services**: Prowlarr API, Radarr API v3, Sonarr API v3, qBittorrent Web API v2
- **Database**: SQLite with WAL mode
- **Processing**: mkvmerge, ffmpeg (optional)
- **Deployment**: Docker multi-stage build

## License

MIT
