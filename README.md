# Media Approval Dashboard

A self-hosted approval gateway for Radarr/Sonarr with qBittorrent and Prowlarr integration. Review, compare, approve, and track media releases before they download.

## Features

- **Approval Dashboard** — Pending requests + managed media with franchise grouping
- **Prowlarr Search** — Direct indexer search with custom queries, quality scoring, and season filtering
- **Franchise Management** — 2-layer UI: season overview with episode grid, then deep-dive per season
- **Episode Coverage** — Track which episodes are downloaded per season with FILLED/MISSED badges from Sonarr
- **Release Comparison** — Side-by-side table with app scoring, quality breakdown, seeder counts
- **Season Packs** — Parse multi-episode torrents (S02E01-E12), track episode coverage per season
- **Search Modes** — Season pack search or individual episode search per season
- **Hardlink Processing** — mkvmerge/ffmpeg pipeline for audio codec conversion, subtitle stripping, format modification
- **Torrent Management** — Pause, resume, move to library, process, remove from library
- **Live Search Progress** — SSE streaming shows progress per season/episode
- **Auto-Dismiss** — Permanent release deletion without file removal
- **Import Missing** — Import Radarr/Sonarr items not yet in the DB
- **Detect Torrents** — Match existing qBittorrent torrents to pending requests
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
| POST | `/api/requests/:id/process` | Process download through mkvmerge/ffmpeg |
| POST | `/api/requests/:id/remove-from-library` | Remove hardlinks from library |
| POST | `/api/requests/:id/torrent/pause` | Pause torrent (single or franchise-level) |
| POST | `/api/requests/:id/torrent/resume` | Resume torrent (single or franchise-level) |
| GET | `/api/requests/:id/torrent-statuses` | Approved torrent statuses for a request |

### Managed / Franchise

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests/managed` | Managed media list (series + movies with releases) |
| GET | `/api/requests/managed/:sonarrId` | Franchise detail (all seasons, releases, coverage) |
| GET | `/api/requests/managed/:sonarrId/season/:season/episodes` | Sonarr episode list with coverage + quality |
| GET | `/api/requests/managed/:sonarrId/torrent-statuses` | Batch torrent statuses across all seasons |
| POST | `/api/requests/managed/:sonarrId/search-all` | Parallel season search (SSE, Prowlarr) |
| POST | `/api/requests/managed/search-all-movies` | Parallel movie search (SSE, Prowlarr) |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/requests/detect-torrents` | Match existing qBittorrent torrents to requests |
| POST | `/api/requests/import-missing` | Import from Radarr/Sonarr |
| GET | `/api/requests/test-connections` | Test Radarr/Sonarr/Prowlarr connectivity |
| GET | `/api/db` | Browse all tables |
| DELETE | `/api/requests/:id` | Delete request + torrent |

## Search Flow

1. User types a query (or uses default franchise/season title)
2. Backend queries Prowlarr with the term + TV/movie categories
3. Results are scored (quality, custom formats, size, rank, seeders) and stored
4. SSE streams progress to frontend
5. User reviews results in a table, expands to see score breakdown
6. Approve grabs via magnet URL (Prowlarr) or Radarr/Sonarr release endpoint

## Approval Flow

- **Prowlarr results** (40-char infoHash): grabbed directly via qBittorrent magnet URL
- **Radarr/Sonarr results**: grabbed through their native release endpoint
- Status transitions: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING

## Processing Pipeline

Hardlink processing for format modification:
1. Copy download content to processing workspace
2. **mkvmerge**: strip/keep audio tracks, remove subtitles
3. **ffmpeg**: audio codec conversion (fallback when mkvmerge unavailable)
4. Hardlink result to library path
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
