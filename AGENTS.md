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

### Manual Preprocessing Flow (TorrentPanel UI)
```
Download (100% complete)
     │
     ├── [checkbox OFF] "Move to Processed" → Processed/{Filmy|Serialy}/{name}/
     │                                          └── Sonarr/Radarr import
     │
     └── [checkbox ON]  "Move to Workspace" → Workspace/{id}-{name}/inputs/
                                                ├── output/ (pre-created)
                                                └── Manual mux/merge → Processed
```

### Key Principles
- **Download is immutable**: never modify, never delete while seeding
- **Workspace is ephemeral**: cleaned up after each processing job
- **Processed is staging**: Sonarr/Radarr import from here and rename
- **Hardlinks everywhere**: zero extra disk space, original untouched
- **Library managed by Sonarr/Radarr**: they handle renaming and organization

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
- Shows all seasons as clickable rows with colored filled/missing badges (e.g. `12/24` green, `8 missing` red)
- Expandable episode grid: Sonarr episode list with titles, FILLED/MISSED badges, quality tags, per-episode Search button
- Search term input (default: franchise title, editable) — custom queries go to Prowlarr
- "Search All Seasons" button: fires background SSE search-all, navigates to first season's SeasonDetail
- Per-season Search button in header: navigates to SeasonDetail with season-specific auto-search
- Click a season → Layer 2

### Layer 2 — Season Detail (SeasonDetail component)
- Full release table/list with toggle (table default, card alternative)
- Score breakdown (quality, CF, size, rank) with expandable details
- Episode filter and sort controls (score, size, seeders)
- Search mode toggle (Season pack | Individual episodes)
- Auto-triggers search on mount when navigated with `initialSearch`
- Approve → grab via magnet or Sonarr/Radarr
- Torrent panel: progress bar, stats grid, source/library paths
- Preprocessing checkbox + "Move to Processed" / "Move to Workspace" button
- Move to Library (hardlink) / Process (remux/repack) / Remove from Library

## Processing Pipeline

### Workspace Naming
- Folder: `{request_id}-{sanitized_title}` (e.g. `42-LEGO.Ninjago.Dragons.Rising.S02`)
- Subdirs: `inputs/` (hardlinks from Download) and `output/` (processed files)
- Cleaned up automatically after each processing job

### Hardlink Processing (POST /:id/process)
1. Gets content path from qBittorrent
2. Creates workspace folder: `{PROCESSING_WORKSPACE}/{request_id}-{name}/`
3. Hardlinks source files to `workspace/inputs/`
4. **mkvmerge**: strip/keep audio tracks, remove subtitles
5. **ffmpeg**: audio codec conversion (fallback)
6. Output files written to `workspace/output/`
7. Hardlinks output to Processed folder
8. Cleans up workspace

### Move to Processed (POST /:id/move-to-processed)
1. Gets content path from qBittorrent
2. Hardlinks files from Download to Processed folder
3. Processed files await Sonarr/Radarr import to Library

### Move to Workspace (POST /:id/move-to-workspace)
1. Gets content path from qBittorrent
2. Creates workspace: `{PROCESSING_WORKSPACE}/{request_id}-{sanitized_title}/inputs/` and `output/`
3. Hardlinks files from Download to workspace `inputs/`
4. User manually processes files (mux/merge) in workspace
5. Output can be hardlinked to Processed folder when ready

### Move to Library (POST /:id/move-to-library)
1. Hardlinks files from Processed folder to Sonarr/Radarr library path
2. Falls back to copy on cross-device (EXDEV)
3. Checks existing files before creating links

## Key Files

| File | Purpose |
|------|---------|
| `src/services/prowlarr.ts` | Prowlarr API client (search indexers) |
| `src/services/sonarr.ts` | Sonarr API client (search, grab, unmonitor, delete) |
| `src/services/radarr.ts` | Radarr API client (search, grab, unmonitor, delete) |
| `src/services/qbittorrent.ts` | qBittorrent Web API v2 (torrents, auth) |
| `src/services/scoring.ts` | Release scoring engine |
| `src/services/processor.ts` | Hardlink processing (mkvmerge/ffmpeg), workspace management |
| `src/routes/requests.ts` | All API endpoints (~2860 lines) |
| `src/jobs/pollRadarr.ts` | Discovers wanted movies, searches |
| `src/jobs/pollSonarr.ts` | Discovers wanted series (no auto-search) |
| `src/jobs/pollStatus.ts` | Tracks torrent status, state transitions |
| `src/db/index.ts` | Schema, migrations, auto-repair |
| `src/server.ts` | App entry, startup stale RC cleanup |
| `frontend/src/components/TorrentPanel.tsx` | Shared torrent panel (progress, stats, move actions) |
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

# Paths — Download (immutable, seeds forever)
DOWNLOADS_MOVIES=/media/Torrents/Download/Filmy
DOWNLOADS_TV=/media/Torrents/Download/Serialy

# Paths — Processed (staging for Sonarr/Radarr import)
PROCESSED_MOVIES=/media/Torrents/Processed/Filmy
PROCESSED_TV=/media/Torrents/Processed/Serialy

# Paths — Workspace (ephemeral processing scratch space)
PROCESSING_WORKSPACE=/media/Torrents/Workspace

# Paths — Library (final destination, managed by Sonarr/Radarr)
MEDIA_MOVIES=/media/filmy
MEDIA_TV=/media/serialy

# Polling
POLL_INTERVAL_RADARR=60
POLL_INTERVAL_SONARR=60
POLL_INTERVAL_STATUS=30

# Notifications
NTFY_URL=
NTFY_TOPIC=
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
- Hardlinks cannot cross filesystem boundaries — Download, Workspace, Processed, and Library must all be on the same volume

## Testing Checklist

- [ ] Prowlarr search returns results with custom terms
- [ ] Quality parsing checks source (WEBDL/WEBRip/Bluray) before resolution
- [ ] Approve grabs torrent via magnet URL
- [ ] Status poller detects Prowlarr-grabbed torrents by infoHash
- [ ] Dismiss blocked for active downloads
- [ ] Fallback to Sonarr/Radarr when PROWLARR_API_KEY not set
- [ ] Season regex handles S##E## format correctly
- [ ] Startup cleanup doesn't nuke valid RCs for same hash
- [ ] Franchise search-all filters results by season number
- [ ] Franchise overview shows colored filled/missing badges per season
- [ ] Franchise episode grid shows Sonarr episode titles with FILLED/MISSED badges
- [ ] Per-season Search navigates to SeasonDetail with auto-search
- [ ] Per-episode Search includes episode name in query
- [ ] "Search All Seasons" fires background search + navigates to first season
- [ ] SeasonDetail search mode toggle (Season | Episodes) works
- [ ] Season packs (S## without E##) cover all episodes in coverage display
- [ ] Season pack quality parsed from torrent title (not hardcoded "unknown")
- [ ] Scan Downloads: status fix JOIN uses `ah.request_id = rc.request_id`
- [ ] Scan Downloads: season mismatches detected and re-imported
- [ ] Scan Downloads: stale approvals cleaned (torrent gone from qBittorrent)
- [ ] titlesMatch: "Mufasa: The Lion King" does NOT match "The Lion King" torrents
- [ ] Processing pipeline creates workspace with inputs/output dirs
- [ ] Move to Processed hardlinks from Download to Processed
- [ ] Move to Workspace hardlinks from Download to Workspace inputs/ (with output/ pre-created)
- [ ] Move to Library hardlinks from Processed (not Download)
- [ ] Workspace cleaned up after processing completes
- [ ] TorrentPanel checkbox toggles between "Move to Processed" and "Move to Workspace"
- [ ] TorrentPanel shared component renders correctly in both RequestDetail and FranchiseDetail
