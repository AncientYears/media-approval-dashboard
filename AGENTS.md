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
├── Processed/             # STAGING — ready for Sonarr/Radarr import
│   ├── Filmy/             #   Processed movies awaiting library import
│   └── Serialy/           #   Processed TV shows awaiting library import
│
└── Trackers/              # PER-TORRENT METADATA — exported on destroy
    └── {info_hash}/
        ├── *.torrent      #   Exported .torrent file
        └── trackers.json  #   Tracker list

/media/
├── filmy/                 # LIBRARY — Radarr-managed movie library
└── serialy/               # LIBRARY — Sonarr-managed TV library
```

### Data Flow

/Processed is the **source of truth**. Files there are independent — not linked to any torrent.

```
qBittorrent
     │
     ▼
/Download (immutable, always seeds from here)
     │
     ├────── [no processing needed] ────── hardlink to /Processed ──┐
     │     (treated as independent file, not linked to torrent)     │
     │                                                              │
     └────── [processing needed] ── hardlink to /Workspace          │
              │                                                     │
              ▼                                                     │
         /Workspace/{id}-{name}/                                    │
              inputs/  →  mkvmerge/ffmpeg  →  output/              │
              │                                                     │
              └──── delete inputs, MOVE output to /Processed ───────┘
                    (outputs are new files, different inodes, truly independent)
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
     ├── [checkbox OFF] "Move to Processed"
     │     → hardlink Download/* to /Processed/
     │     → file appears in processed panel as independent
     │     → "To Library" button sends to Radarr/Sonarr
     │
     └── [checkbox ON] "To Workspace" → opens WorkspacePickerModal
           → select existing workspace or create new (name, notes, scripts)
           → hardlink Download/* to workspace/inputs/
           → user processes files manually (mux/merge)
           → "Complete & Import" deletes inputs, MOVEs outputs to /Processed/
           → file appears in processed panel as independent (different inode)
           → "To Library" button sends to Radarr/Sonarr
```

### Re-processing Flow
```
/Processed file (independent)
     │
     └── "To Workspace" → opens WorkspacePickerModal
           → hardlink /Processed/* to workspace/inputs/
           → user re-processes (different mux, audio tracks, etc.)
           → "Complete & Import" MOVEs outputs to /Processed/
           → file replaced as independent
```

### Key Principles
- **Download is immutable**: never modify, never delete while seeding
- **Workspace is ephemeral**: cleaned up after each processing job
- **Processed is the source of truth**: independent files, not linked to torrents
- **Workspace outputs are MOVED** (renameSync) to Processed — not hardlinked — different inodes
- **No-preprocess hardlinks** are treated as independent even though they share inodes with Download
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

## Torrent Import (POST /:id/import)

1. User pastes magnet link OR uploads `.torrent` file + optional bypassApproval toggle
2. Backend adds to qBittorrent using `toQBittorrentPath()` for save path
3. Creates `release_candidate` with magnet/URL, status NEW, `torrent_hash = ''`
4. If `bypassApproval=true`: creates `approval_history` + sets status AWAITING_APPROVAL immediately
5. Polls qBittorrent up to 30s (1s intervals) waiting for torrent hash to appear
6. When detected: updates RC hash, and if bypassed, calls `approveRelease()` to grab + transition to DOWNLOADING
7. Frontend auto-closes modal and refreshes data

## Per-Torrent Destroy (POST /:id/destroy/:releaseId)

1. User clicks "Destroy" on TorrentPanel → opens modal explaining options
2. Modal shows: release title, "Delete downloaded files from disk?" checkbox, "Remove from qBittorrent?" checkbox
3. Backend: exports `.torrent` + `trackers.json` to `/media/Torrents/Trackers/{hash}/` (keeps metadata)
4. If remove from qBittorrent: calls `deleteTorrent(hash, deleteFiles)` — qBittorrent optionally deletes downloaded files
5. Moves content to /Processed via renameSync (NOT hardlink — torrent is gone, files are now independent)
6. Cleans up release_candidates, approval_history for that release
7. Does NOT touch Sonarr/Radarr (they remain as-is)

## Request Grouping (Dashboard)

- Series requests are grouped by `sonarr_id` in the Requests section
- Each franchise shows as a card with season pills fetched from Sonarr (`GET /managed/:sonarrId/seasons`)
- Requested seasons show status (SEARCHING/AWAITING_APPROVAL); unrequested seasons shown dimmed (opacity 0.4)
- Title shows "X/Y requested" count
- Clicking a requested season navigates to its request detail

## Key Files

| File | Purpose |
|------|---------|
| `src/services/prowlarr.ts` | Prowlarr API client (search indexers) |
| `src/services/sonarr.ts` | Sonarr API client (search, grab, unmonitor, delete) |
| `src/services/radarr.ts` | Radarr API client (search, grab, unmonitor, delete) |
| `src/services/qbittorrent.ts` | qBittorrent Web API v2 (torrents, auth) |
| `src/services/scoring.ts` | Release scoring engine |
| `src/services/processor.ts` | Hardlink processing (mkvmerge/ffmpeg), workspace management |
| `src/routes/requests.ts` | All API endpoints (~5185 lines) |
| `src/jobs/pollRadarr.ts` | Discovers wanted movies, searches |
| `src/jobs/pollSonarr.ts` | Discovers wanted series (no auto-search) |
| `src/jobs/pollStatus.ts` | Tracks torrent status, state transitions |
| `src/db/index.ts` | Schema, migrations, auto-repair |
| `src/server.ts` | App entry, startup stale RC cleanup |
| `frontend/src/components/TorrentPanel.tsx` | Shared torrent panel (progress, stats, move actions) |
| `frontend/src/components/WorkspacePickerModal.tsx` | Shared workspace picker modal (select existing + create new) |
| `frontend/src/components/WorkspaceManagerModal.tsx` | Shared workspace manager (name, notes, scripts, complete & import, delete) |
| `frontend/src/components/ScriptDropdown.tsx` | Multi-select dropdown for workspace scripts |
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
DOWNLOADS_MOVIES=/media/Torrents/download/filmy
DOWNLOADS_TV=/media/Torrents/download/serialy

# Paths — Processed (staging for Sonarr/Radarr import)
PROCESSED_MOVIES=/media/Torrents/processed/filmy
PROCESSED_TV=/media/Torrents/processed/serialy

# Paths — Workspace (ephemeral processing scratch space)
PROCESSING_WORKSPACE=/media/Torrents/Workspace

# Paths — Library (final destination, managed by Sonarr/Radarr)
MEDIA_MOVIES=/media/Filmy
MEDIA_TV=/media/Serialy

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
- qBittorrent is in a separate Docker container — volume mapping: `/media/Torrents:/Torrents:rw`. Use `toQBittorrentPath()` (strips `/media`) and `fromQBittorrentPath()` (prepends `/media`) for all path conversions
- Import endpoint FK fix: uses SELECT-then-INSERT (not INSERT OR IGNORE) to avoid `lastInsertRowid=0` causing FOREIGN KEY constraint failure on approval_history
- `form-data` npm package used for qBittorrent multipart file upload (already a direct dependency)
- Import endpoint uses `toQBittorrentPath()` for save path, `fromQBittorrentPath()` for content_path/save_path from qBittorrent
- Destroy modal is a proper modal (not 3-click confirm), shows options for delete files vs keep files
- Destroy moves Download content to /Processed via renameSync (NOT hardlink — since torrent is removed anyway)
- Processed files in /Processed are preserved by destroy either way
- `--card-bg: #1e293b` CSS variable fixes transparent modals
- **Import-library processed_files**: Always targets/creates `release_id IS NULL` AH rows (not torrent-linked rows). Skips adding files already in /processed by inode check (`alreadyImported`).
- **Scan endpoint movie import**: Skips importing the main movie file from Radarr library if the request already has a tracked torrent (`torrent_hash != ''`). Extras still imported.
- **Dashboard version count**: `release_count + processed_count`. `processed_count` queries only `release_id IS NULL` AH rows. Startup inode-dedup removes processed files that are hardlinks of torrent download files (same inode → not a separate version).
- **Processed endpoint series scanning**: Only scans the specific season subfolder matching the request's season (e.g. only `S02/` for season 2), not all seasons. No longer adds directory entries as files.
- **PollRadarr reliability**: Uses `getAllMovies()` with JS filtering instead of `getWantedMovies()` to avoid Radarr server-side filtering inconsistencies.
- **Startup DB cleanup order**: Dedup → dangling cleanup → merge null-release_id rows → migrate non-null processed_files to null rows → inode dedup

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
- [ ] TorrentPanel shows content info badge (video/bluray/multi/none) at 100%
- [ ] Content-info endpoint scans content_path for video files and BDMV directories
- [ ] titlesMatch rejects sequel numbers (e.g. "moana 2" does NOT match "moana")
- [ ] titlesMatch tolerates 1 missing word for 3+ word titles (e.g. "LEGO Ninjago" matches "Ninjago Dragons Rising")
- [ ] Import: magnet link adds to qBittorrent and polls for hash
- [ ] Import: .torrent file upload creates RC and polls for hash
- [ ] Import: bypassApproval creates AWAITING_APPROVAL status immediately
- [ ] Destroy: exports .torrent + trackers.json to /Trackers/{hash}/
- [ ] Destroy: removes from qBittorrent, moves content to /Processed
- [ ] Destroy: preserves processed files in /Processed either way
- [ ] Dashboard: franchise grouping shows all seasons from Sonarr (X/Y requested)
- [ ] Dashboard: unrequested seasons shown dimmed (opacity 0.4)
- [ ] Scan Downloads: title+season mismatch detection frees wrongly-linked RCs
