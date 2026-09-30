# Project Implementation Summary

## Current Status: Fully Arr-Free + Seerr Portal Integration Complete

The dashboard runs **without Sonarr or Radarr**. Requests flow in from **Seerr**
(request portal, arr-free) or **TMDB Discover** (Dashboard button), search hits
**Prowlarr** directly, and grabs go straight to **qBittorrent** via magnet.
Episode metadata comes from **TMDB**. Radarr/Sonarr service classes and pollers
remain in the code as optional legacy code paths — they boot only when both
`RADARR_URL`+`RADARR_API_KEY` / `SONARR_URL`+`SONARR_API_KEY` are set.

### What's Built

#### Backend (Node.js + Express + TypeScript)
- Express server with CORS, body-parser, SPA fallback
- SQLite database with migrations and auto-repair (ghost-row cleanup on boot)
- Service classes: **Prowlarr**, **Seerr**, **TMDB**, qBittorrent, notifications (ntfy); legacy Radarr/Sonarr
- Polling jobs: Seerr request sync (creation + deletion reconcile), qBittorrent status
- Native franchise metadata: `library_key` identity, TMDB season cache with `altTitle` fallback, language prefs, fix-identity repair
- Seerr sync: per-season rows, requested-by attribution, availability ignored (COMPLETED stays manual move-to-library)
- Arr-free request creation: native `media_requests` rows, TMDB candidate pre-fill in scan-downloads, Discover requests
- Library reconcile: inode-based import, audit, and adoption (never copies, never overwrites)
- Release scoring engine with profiles (balanced/audio/quality/size)
- SSE streaming for search progress
- DB viewer endpoint (any schema table, read-only)

#### Frontend (React + Vite + TypeScript)
- Dashboard with requests + managed media sections and group-based split
- Native franchise page (TMDB seasons, Specials pill, language select, Fix identity)
- Franchise detail page (series drill-down by season)
- Request detail page with release comparison table
- Discover modal (TMDB movie+series search → request)
- Workspace picker / manager modals + script dropdowns
- Seerr-aware delete modals (surfaces Seerr delete failures)
- DB viewer page with status editor
- Toast notification system
- Dark theme with responsive layout

#### Integration Flow (arr-free)
```
Seerr → sync → media_requests → Prowlarr search → user approves →
qBittorrent magnet grab → status poller tracks → Workspace/Processed →
inode library reconcile → Jellyfin
```

Also: TMDB Discover (button → native request → Prowlarr), Scan Downloads
(native title matching + TMDB candidates), Library Audit/Adoption.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| GET | /api/requests | List all requests (no limit) |
| GET | /api/requests/:id | Request detail + releases + approved |
| GET | /api/requests/managed | Managed media (franchise grouped) |
| GET | /api/requests/managed/:sonarrId | Legacy franchise detail with season releases |
| GET | /api/requests/native-franchise/:id | Native franchise detail (TMDB seasons, specials, language) |
| GET | /api/requests/discover | TMDB search (movie + series combined) |
| GET | /api/requests/discover/tv/:tmdbId/seasons | TMDB season list for a pick |
| POST | /api/requests/discover/request | Create native request (idempotent, `existed: true`) |
| POST | /api/requests/:id/search | SSE streaming search (Prowlarr) |
| POST | /api/requests/:id/approve | Approve release + grab via magnet |
| POST | /api/requests/:id/dismiss | Dismiss release (manual only, propagates to Seerr) |
| POST | /api/requests/:id/set-status | Manually fix stuck status |
| POST | /api/requests/:id/move-to-library | Marks COMPLETED + per-file processed_files |
| POST | /api/requests/:id/move-to-processed | Hardlink Download → Processed |
| POST | /api/requests/:id/move-to-workspace | Hardlink Download → workspace inputs |
| POST | /api/requests/:id/process | mkvmerge/ffmpeg processing |
| POST | /api/requests/:id/destroy/:releaseId | Export torrent metadata, delete torrent, files → /Processed |
| POST | /api/requests/seerr/sync | Manual Seerr request sync |
| POST | /api/requests/import-library/native | Arr-free library reconcile (dry run unless `apply`) |
| GET | /api/requests/library-audit | Read-only inode attribution report |
| POST | /api/requests/adopt-into-processed | Adopt orphaned library files into /Processed |
| POST | /api/requests/scan-downloads | Match/fix/backfill torrents (arr-free native matching) |
| POST | /api/requests/cleanup | Clean stuck + orphaned entries |
| POST | /api/requests/cleanup-duplicates | Find and merge duplicate requests |
| POST | /api/requests/remove-titles | Remove specific entries by title |
| GET | /api/requests/test-connections | Test Prowlarr/qBittorrent/Seerr (+ optional arrs) connectivity |
| GET | /api/requests/db/:table | Any DB table, read-only |
| GET | /api/db | All tables, columns, rows (DB viewer) |
| GET | /api/settings/naming | Naming templates + defaults + tokens (P1) |
| PUT | /api/settings/naming | Save naming templates (P1) |
| POST | /api/test-connections | Connection testing (legacy) |

### DB Schema

```
media_requests          - Requests: status, library_key, seerr_request_id, requested_by, episode_count, last_searched_at
release_candidates      - Releases: torrent_hash, info_url, radarr_release_id, parsed_episodes, save_path
approval_history        - Approval records linking request → release (release_id IS NULL = processed file set)
search_history          - Search parameter tracking
release_group_scores    - Release group bias (v2)
custom_rules            - Custom require/exclude/prefer rules (v2)
tmdb_season_cache       - Per-key season/episode metadata (works offline)
tmdb_franchise_prefs    - Language preference keyed by library_key
tmdb_external_ids       - Per-key TMDB external_ids cache (imdb/tvdb for canonical naming)
unmatched_torrents      - Torrents with no match + pre-fetched TMDB candidates
settings                - Key-value config storage (incl. naming.* templates)
media_files             - Identity layer (dev,inode) → library_key/season/episodes/role/release_name
```

### Key Technical Decisions

- **Fully arr-free by default** — arrs boot only when URL+key both set; legacy code stays for dual-mode
- **Seerr = one request per season** — `seasons[]` maps to per-season `media_requests` rows, never collapsed onto S01
- **Seerr availability ignored for COMPLETED** — Jellyfin scan sees only the library, not staging; COMPLETED stays manual move-to-library
- **Dashboard deletes propagate to Seerr** — DELETE with DECLINE fallback so a declined request can't resurrect on next sync
- **Group-based Managed/Requests split** — content-less requested seasons join the managed card (amber pill) once a sibling under the same `library_key` has content; ghost rows (empty/NULL status) never surface
- **Identity = inode, not title** — reconcile compares `stat().ino`; titles are localized (e.g. `Xiaolin Showdown`)
- **No LIMIT on requests query** — imports exceeded it
- **Dismiss = manual only** — blocked for DOWNLOADING/SEEDING/COMPLETED
- **Adoption has no copy fallback** — a copy would triple disk usage of the largest files; EXDEV is reported as an error
- **Workspace outputs are MOVED** — not hardlinked; new inodes after processing

### Known Issues / Tech Debt

- Server has different DB than local dev — must deploy to test server-side changes
- `navigator.clipboard` requires HTTPS — textarea fallback handles HTTP
- DB migration could lose data if interrupted mid-transaction (auto-repair mitigates)
- Internal field names still `radarr_*` / `sonarr_id` in places (legacy DB column compat) — cosmetic only, no functional impact
- Workspaces have known quirks (not addressed this round — see Workspace picker/manager flows)

### Roadmap (next)

**Primary — Processed ⇄ Library standardization (P0–P2)** — see the full
"ROADMAP — Processed ⇄ Library standardization" section in AGENTS.md:
- **P0 (implemented)**: `media_files` table keyed by `(dev,inode)`;
  `src/services/identity.ts` (`registerFileIdentity`, `registerVideoTree`,
  `identifyByPath`, `autodetectIdentity`, `deriveIdentityFromFilename`);
  registration on move-to-processed, move-to-library, workspace Complete &
  Import, destroy's renameSync, adopt-into-processed, import-library/native;
  inode-first reads in `coveredEpisodesForRequest` (numbered recovered for
  unparseable/renamed files) + `unnumberedFilesInSeasonFolder`/episode-grid
  extras guards (inode-numbered files are covered, never extras);
  `processed_files` self-heal on access (`healProcessedFilesForRequest` —
  stale path → identity lookup → rewrite AH row), wired into `GET /:id/processed`
  and every coverage read. Verified end-to-end: simulated rename → panel shows
  the renamed file and AH rows rewritten. No renames performed by the app;
  deployable alone. REMAINING: verify on the VM (coverage counts unchanged for
  a sample franchise before/after), then P1/P2 below. No xattr mirror — identity
  is DB-only; `/download` stays 100% isolated (never written to, ever).
- **P1 (implemented, pending VM verification)**: canonical naming for NEW writes
  only — `src/config/naming.ts` kernel (`parseReleaseTags` import, canonical
  movie/special/episode/dir builders, `uniqueDestPath`, token templates),
  naming templates stored in `settings` + `GET`/`PUT /api/settings/naming`
  (Settings → Naming Templates, token list, disable toggle), TMDB
  `resolveExternalIds` (`tmdb_external_ids` cache, offline fallback reuses ids
  embedded in an already-canonical target folder). **P1b: tags are probed from
  the source file first (`src/services/mediaProbe.ts` ffprobe →
  `assembleCanonicalTags`) — resolution from real pixel height, video codec +
  bit depth, HDR flags (DV/HDR10Plus/HDR10/HLG), primary audio codec + channels
  (Atmos kept from title); probe wins, title keeps source/language/group;
  `[DV HDR10Plus]`/`[TrueHD Atmos 7.1]`/`[AC3 2.0]` brackets split + merge,
  channel kept intact (`DD+5.1`), `[Unknown]` tail → group.** Applied at
  single-file `move-to-processed` and native `move-to-library` (per-file +
  torrent paths): movies/specials → `Title (YYYY) [imdbid-tt####] - [PL]
  [Bluray-1080p]...-GRP`; episodes → `Show - SxxExx - Name [tags]-GRP`
  (`{EpisodeTitle}` from `tmdb_season_cache`, offline). Dirs/workspace
  outputs/adopt/import keep their names. Native-only; arr-linked moves still
  defer to Radarr/Sonarr. Naming is cosmetic (reads stay inode-keyed).
- **P2**: "Fix names" modal — per-file checkbox rename (processed ↔ library
  twins + lone processed files), inode-verified. Movie/series/season dir
  creation (kernel builders exist) also lands here.
- Matching order: inode first → canonical-name (IDs embedded) → fuzzy title
  (backup for copied-not-hardlinked files). Release names stay in `/download`.

**Secondary — Phase E leftovers**
- Native franchise "Search All Seasons" button (only sonarr `searchAllSeasons` exists)
- Auto-search for new `NEW` rows
- Full internal rename of `radarr_*`/`sonarr_id` identifiers (cosmetic)

### Commands

```bash
npm run dev              # Backend dev server (localhost:3000)
npm run build            # Compile TypeScript
npm run type-check       # Validate types
cd frontend && npm run dev   # Frontend dev (localhost:5173)
cd frontend && npm run build # Frontend build
./setup.sh               # Production deploy (see DEPLOYMENT.md)
```