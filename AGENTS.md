# AGENTS.md — Development Guide

## Quick Start

```bash
npm install                  # Install backend deps
cd frontend && npm install   # Install frontend deps
cp .env.example .env         # Configure env vars
npm run dev                  # Backend on :3000
cd frontend && npm run dev   # Frontend on :5173 (proxies to :3000)
```

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

## Search Flow

1. User clicks "Search" or types custom term
2. Backend `POST /:id/search` endpoint
3. **If PROWLARR_API_KEY is set**: queries Prowlarr directly (`GET /api/v1/search?query=...&categories=2000|5000`)
4. **Fallback**: queries Sonarr/Radarr `/api/v3/release` (ignores custom terms)
5. Results mapped to `RadarrSearchResult` format, scored, stored in `release_candidates`
6. SSE streams progress to frontend

## Approval Flow

1. User clicks "Approve" on a release
2. Backend `POST /:id/approve` endpoint
3. Creates `approval_history` record
4. **If release has Prowlarr infoHash (40-char)**: grabs via qBittorrent directly using magnet URL
5. **Otherwise**: grabs via Radarr/Sonarr `/api/v3/release` (their native flow)
6. Detects new torrent in qBittorrent, updates `release_candidates.torrent_hash`
7. Status transitions to DOWNLOADING

## Pipeline Plan (Future)

### Path A — No Preprocessing (current)
```
Approve → Sonarr/Radarr grab → qBittorrent download → auto-import to library
```

### Path B — With Preprocessing
```
Approve → qBittorrent download ourselves → process (mux/merge) → manual import to Sonarr/Radarr
```

### Auto-Removal
When a request's torrents disappear from qBittorrent AND files are gone from disk → auto-delete from DB.

### In-Place Reprocessing
For files already in library: use mkvtoolnix to add/modify tracks in-place.

## Key Files

| File | Purpose |
|------|---------|
| `src/services/prowlarr.ts` | Prowlarr API client (search indexers) |
| `src/services/sonarr.ts` | Sonarr API client (search, grab, unmonitor, delete) |
| `src/services/radarr.ts` | Radarr API client (search, grab, unmonitor, delete) |
| `src/services/qbittorrent.ts` | qBittorrent Web API v2 (torrents, auth) |
| `src/services/scoring.ts` | Release scoring engine |
| `src/routes/requests.ts` | All API endpoints (~1560 lines) |
| `src/jobs/pollRadarr.ts` | Discovers wanted movies, searches |
| `src/jobs/pollSonarr.ts` | Discovers wanted series, searches |
| `src/jobs/pollStatus.ts` | Tracks torrent status, state transitions |
| `src/db/index.ts` | Schema, migrations, auto-repair |
| `frontend/src/pages/RequestDetail.tsx` | Release comparison + torrent mgmt (755 lines) |
| `frontend/src/pages/Dashboard.tsx` | Requests list + filters |
| `frontend/src/api.ts` | Axios client + all API functions |

## Environment Variables

```env
# Prowlarr (search indexers directly)
PROWLARR_URL=http://192.168.1.100:9696
PROWLARR_API_KEY=

# Radarr/Sonarr (grab, monitor, import)
RADARR_URL=http://192.168.1.100:7878
RADARR_API_KEY=
SONARR_URL=http://192.168.1.100:8989
SONARR_API_KEY=

# qBittorrent (download)
QBIT_URL=http://192.168.1.100:8080
QBIT_USER=admin1
QBIT_PASS=admin1

# Paths
MEDIA_MOVIES=/media/filmy
MEDIA_TV=/media/serialy
DOWNLOADS_MOVIES=/media/torrents/downloads/filmy
DOWNLOADS_TV=/media/torrents/downloads/serialy
```

## DB Schema Notes

- `release_candidates.torrent_hash` — stores infoHash from Prowlarr (40-char hex) or hash from qBittorrent
- `release_candidates.info_url` — stores magnet URI for Prowlarr results (starts with `magnet:`), or info page URL for Sonarr/Radarr results
- `release_candidates.radarr_release_id` — stores Prowlarr's `infoHash` or `guid`, or Sonarr/Radarr's release `guid`
- Status enum: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING

## Common Gotchas

- Express v5 routing: `/{*path}` for catch-all, not `/*`
- `better-sqlite3` v12: `lastInsertRowid` returns BigInt
- Sonarr's `/api/v3/release` ignores `term` parameter — use Prowlarr instead
- Dismiss blocked for DOWNLOADING/SEEDING/COMPLETED (backend guard)
- SSE: use `Connection: close` header, parse `eventType` across chunks
- Poller `pollStatus.ts` uses `torrentMatchesTitle()` for fuzzy matching when hash fails
- DB migrations use `PRAGMA table_info` to check columns before adding

## Testing Checklist

- [ ] Prowlarr search returns results with custom terms
- [ ] Quality parsing from release titles works (1080p, 2160p, etc.)
- [ ] Approve grabs torrent via magnet URL
- [ ] Status poller detects Prowlarr-grabbed torrents by infoHash
- [ ] Dismiss blocked for active downloads
- [ ] Fallback to Sonarr/Radarr when PROWLARR_API_KEY not set
