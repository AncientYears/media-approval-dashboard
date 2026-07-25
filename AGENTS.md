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

### Single Request Search (POST /:id/search)
1. User clicks "Search" or types custom term
2. Backend `POST /:id/search` endpoint
3. **If PROWLARR_API_KEY is set**: queries Prowlarr directly (`GET /api/v1/search?query=...&categories=2000|5000`)
4. **Fallback**: queries Sonarr/Radarr `/api/v3/release` (ignores custom terms)
5. Results mapped to `RadarrSearchResult` format, scored, stored in `release_candidates`
6. SSE streams progress to frontend

### Franchise Search All (POST /managed/:sonarrId/search-all)
1. User types search term in franchise overview, clicks "Search All Seasons"
2. Backend queries Prowlarr once per season (concurrency 3)
3. **Season filter**: Prowlarr results parsed with `/\bS(\d{1,2})(?:E\d|\b)/` — only results matching the target season are inserted
4. SSE streams per-season `found` events with live release counts
5. Skip guard: 5-minute cooldown via `last_searched_at` column

## Approval Flow

1. User clicks "Approve" on a release
2. Backend `POST /:id/approve` endpoint
3. Creates `approval_history` record
4. **If release has Prowlarr infoHash (40-char)**: grabs via qBittorrent directly using magnet URL
5. **Otherwise**: grabs via Radarr/Sonarr `/api/v3/release` (their native flow)
6. Detects new torrent in qBittorrent, updates `release_candidates.torrent_hash`
7. Status transitions to DOWNLOADING

## Franchise Management (2-Layer UI)

### Layer 1 — Franchise Overview (`/franchise/:sonarrId`)
- Shows all seasons as clickable rows with release counts and status badges
- Search term input (default: franchise title, editable) — custom queries go to Prowlarr
- "Search All Seasons" button with SSE progress
- Expandable season rows: shows approved releases + torrent status
- Active torrent panels at top (progress bar, speed, peers, pause/resume)
- Click a season → Layer 2

### Layer 2 — Season Detail (SeasonDetail component)
- Full release table/list with toggle (table default, card alternative)
- Score breakdown (quality, CF, size, rank) with expandable details
- Episode filter and sort controls (score, size, seeders)
- Approve → grab via magnet or Sonarr/Radarr
- Torrent panel: progress bar, stats grid, source/library paths
- Move to Library (hardlink) / Process (remux/repack) / Remove from Library

## Processing Pipeline

### Hardlink Processing (POST /:id/process)
1. Takes download content path from qBittorrent
2. Creates hardlinks to processing workspace
3. **mkvmerge**: strip/keep audio tracks, remove subtitles
4. **ffmpeg**: audio codec conversion (fallback)
5. Hardlinks processed result to library path
6. Workspace cleaned up after processing

### Move to Library (POST /:id/move-to-library)
- Hardlinks files from download folder to Sonarr/Radarr library path
- Falls back to copy on cross-device (EXDEV)
- Checks existing files before creating links

## Key Files

| File | Purpose |
|------|---------|
| `src/services/prowlarr.ts` | Prowlarr API client (search indexers) |
| `src/services/sonarr.ts` | Sonarr API client (search, grab, unmonitor, delete) |
| `src/services/radarr.ts` | Radarr API client (search, grab, unmonitor, delete) |
| `src/services/qbittorrent.ts` | qBittorrent Web API v2 (torrents, auth) |
| `src/services/scoring.ts` | Release scoring engine |
| `src/services/processor.ts` | Hardlink processing (mkvmerge/ffmpeg) |
| `src/routes/requests.ts` | All API endpoints (~1940 lines) |
| `src/jobs/pollRadarr.ts` | Discovers wanted movies, searches |
| `src/jobs/pollSonarr.ts` | Discovers wanted series, searches |
| `src/jobs/pollStatus.ts` | Tracks torrent status, state transitions |
| `src/db/index.ts` | Schema, migrations, auto-repair |
| `src/server.ts` | App entry, startup stale RC cleanup |
| `frontend/src/pages/FranchiseDetail.tsx` | Franchise overview + SeasonDetail |
| `frontend/src/pages/RequestDetail.tsx` | Single request view (movies) |
| `frontend/src/pages/Dashboard.tsx` | Requests list + filters + managed media |
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
PROCESSING_WORKSPACE=/media/processing
```

## DB Schema Notes

- `release_candidates.torrent_hash` — stores infoHash from Prowlarr (40-char hex) or hash from qBittorrent
- `release_candidates.info_url` — stores magnet URI for Prowlarr results (starts with `magnet:`), or info page URL for Sonarr/Radarr results
- `release_candidates.radarr_release_id` — stores Prowlarr's `infoHash` or `guid`, or Sonarr/Radarr's release `guid`
- `release_candidates.parsed_episodes` — extracted episode codes (e.g. "E01E02E03")
- `media_requests.last_searched_at` — used by search-all skip guard (5 min cooldown)
- `media_requests.episode_count` — total episodes for the season
- Status enum: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING

## Common Gotchas

- Express v5 routing: `/{*path}` for catch-all, not `/*`
- `better-sqlite3` v12: `lastInsertRowid` returns BigInt, never extract `.get`/`.run` from prepared statements (loses `this` binding → `Illegal invocation`)
- Sonarr's `/api/v3/release` ignores `term` parameter — use Prowlarr instead
- Dismiss blocked for DOWNLOADING/SEEDING/COMPLETED (backend guard)
- SSE: use `Connection: close` header, parse `eventType` across chunks
- Poller `pollStatus.ts` uses `torrentMatchesTitle()` for fuzzy matching when hash fails
- Season regex: `\bS(\d{1,2})(?:E\d|\b)` — plain `\b` after digits fails on `S02E12` format
- Startup stale RC cleanup: check each RC individually (not per-hash) to avoid deleting valid RCs
- Managed media: series show always if DOWNLOADING/SEEDING; movies require `release_count > 0`
- `franchise-season-row` uses flex layout with expandable inner content (click row header to toggle)

## Testing Checklist

- [ ] Prowlarr search returns results with custom terms
- [ ] Quality parsing from release titles works (1080p, 2160p, etc.)
- [ ] Approve grabs torrent via magnet URL
- [ ] Status poller detects Prowlarr-grabbed torrents by infoHash
- [ ] Dismiss blocked for active downloads
- [ ] Fallback to Sonarr/Radarr when PROWLARR_API_KEY not set
- [ ] Season regex handles S##E## format correctly
- [ ] Startup cleanup doesn't nuke valid RCs for same hash
- [ ] Franchise search-all filters results by season number
- [ ] Franchise overview shows active torrents + search term input
- [ ] Processing pipeline creates hardlinks and runs mkvmerge/ffmpeg
