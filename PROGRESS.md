# Project Implementation Summary

## Current Status: Prowlarr Search Integration Complete

### What's Built

#### Backend (Node.js + Express + TypeScript)
- Express server with CORS, body-parser, SPA fallback
- SQLite database with migrations and auto-repair
- TypeScript type definitions for all domain objects
- Service classes: Radarr, Sonarr, QBittorrent, **Prowlarr**, notifications (ntfy)
- Polling jobs: Radarr wanted, Sonarr wanted missing, qBittorrent status
- Torrent name parser (S01E01, Season packs, multi-episode)
- Release scoring engine with profiles (balanced/audio/quality/size)
- SSE streaming for search progress
- DB viewer endpoint

#### Frontend (React + Vite + TypeScript)
- Dashboard with requests + managed media sections
- Franchise detail page (series drill-down by season)
- Request detail page with release comparison table
- DB viewer page with editable status dropdowns
- Toast notification system
- Custom modal dialogs (no browser alerts)
- Dark theme with responsive layout
- Filter bar: status, type, sort
- Season pills with episode coverage (e.g. "S02 | 5/12 EP")

#### Polling & Status
- Radarr poller: discovers wanted movies, searches releases, retries
- Sonarr poller: discovers wanted series seasons, searches releases
- Status poller: matches torrents by hash/title, transitions DOWNLOADING ↔ SEEDING
- All pollers: parallel Promise.all searches, 60s intervals (30s for status)

#### Integration Flow
```
Jellyseerr → Radarr/Sonarr → Poller discovers → User approves →
Radarr/Sonarr grabs → qBittorrent downloads → Status poller tracks →
Move to library (hardlinks to Jellyfin folders)
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| GET | /api/requests | List all requests (no limit) |
| GET | /api/requests/:id | Request detail + releases + approved |
| GET | /api/requests/managed | Managed media (franchise grouped) |
| GET | /api/requests/managed/:sonarrId | Franchise detail with season releases |
| POST | /api/requests/:id/search | SSE streaming search (progress events) |
| POST | /api/requests/:id/approve | Approve release + grab via Radarr/Sonarr |
| POST | /api/requests/:id/dismiss | Dismiss release (manual only) |
| POST | /api/requests/:id/reactivate | Reactivate dismissed request |
| POST | /api/requests/:id/set-status | Manually fix stuck status |
| POST | /api/requests/:id/torrent-status | Single torrent status |
| POST | /api/requests/:id/torrent-statuses | All torrent statuses |
| POST | /api/requests/:id/move-to-library | Hardlink to Jellyfin folder |
| POST | /api/requests/:id/remove-from-library | Remove from Jellyfin folder |
| POST | /api/requests/:id/torrent/pause | Pause torrent |
| POST | /api/requests/:id/torrent/resume | Resume torrent |
| DELETE | /api/requests/:id | Delete request + torrent + Radarr/Sonarr entry |
| POST | /api/requests/detect-torrents | Match qBittorrent torrents to requests |
| POST | /api/requests/import-missing | Import Radarr/Sonarr items without DB entries |
| POST | /api/requests/cleanup | No-op (dismiss is manual only) |
| POST | /api/requests/reactivate-all | Re-activate all dismissed requests |
| GET | /api/db | All tables, columns, rows (DB viewer) |
| GET | /api/settings | Get settings |
| POST | /api/test-connections | Test Radarr/Sonarr/qBittorrent/Prowlarr connectivity |

### File Structure

```
mediaAppThing/
├── src/
│   ├── server.ts                 # Express entry point + static serving
│   ├── db/index.ts              # Schema, migrations, auto-repair
│   ├── types/index.ts           # TypeScript interfaces
│   ├── services/
│   │   ├── radarr.ts            # Radarr API (search, grab, unmonitor, delete, getAll)
│   │   ├── sonarr.ts            # Sonarr API (search, grab, wanted missing)
│   │   ├── qbittorrent.ts       # qBittorrent Web API v2
│   │   ├── prowlarr.ts          # Prowlarr API (search indexers directly)
│   │   ├── scoring.ts           # Release scoring engine
│   │   └── notifications.ts     # ntfy push notifications
│   ├── jobs/
│   │   ├── pollRadarr.ts        # Discovers wanted movies, searches
│   │   ├── pollSonarr.ts        # Discovers wanted series, searches
│   │   └── pollStatus.ts        # Tracks torrent status, transitions state
│   ├── routes/
│   │   └── requests.ts          # All API endpoints (~1560 lines)
│   └── utils/
│       └── torrentParser.ts     # Parse S01E01, Season packs, multi-episode
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Router + nav + ToastProvider
│   │   ├── App.css              # All styling (~1700 lines)
│   │   ├── api.ts               # Axios client + all API functions
│   │   ├── components/
│   │   │   └── Toast.tsx        # Toast notification system
│   │   └── pages/
│   │       ├── Dashboard.tsx    # Requests + managed media + filter bar
│   │       ├── RequestDetail.tsx # Release comparison + torrent management
│   │       ├── FranchiseDetail.tsx # Series season drill-down
│   │       ├── DatabaseViewer.tsx # DB tables viewer with status editor
│   │       └── Settings.tsx     # Connection testing
│   ├── index.html
│   ├── vite.config.ts
│   └── tsconfig.json
├── Dockerfile                   # Multi-stage (frontend + backend)
├── docker-compose.yml
├── .env.example
├── README.md
├── DEPLOYMENT.md
└── QUICKSTART.md
```

### Key Technical Decisions

- **No LIMIT on requests query** — was 100, removed because imports exceeded it
- **Dismiss = manual only** — no auto-dismiss, permanent delete without file deletion
- **Dismiss blocked for active downloads** — backend rejects dismiss for DOWNLOADING/SEEDING/COMPLETED statuses
- **Status preserved on refresh** — DOWNLOADING/SEEDING requests keep status when re-searching
- **Migration auto-repair** — detects orphaned `media_requests_new` table and restores
- **SSE for search progress** — streams "querying → indexing → done" to frontend
- **Clipboard fallback** — textarea execCommand for HTTP servers (no navigator.clipboard)

### DB Schema

```
media_requests          - Requests with status, radarr_id/sonarr_id, episode_count
release_candidates      - Releases with torrent_hash, save_path, parsed_episodes
approval_history        - Approval records linking request → release
search_history          - Search parameter tracking
release_group_scores    - Release group bias (v2)
custom_rules            - Custom require/exclude/prefer rules (v2)
settings                - Key-value config storage
```

### Known Issues / Tech Debt

- Server has different DB than local dev — must deploy to test server-side changes
- `navigator.clipboard` requires HTTPS — textarea fallback handles HTTP
- DB migration could lose data if interrupted mid-transaction (auto-repair mitigates)
- Sonarr's `/api/v3/release` ignores `term` parameter — search uses Prowlarr directly
- Pollers (pollRadarr/pollSonarr) still use Sonarr/Radarr search — could migrate to Prowlarr

### Commands

```bash
npm run dev              # Backend dev server (localhost:3000)
npm run build            # Compile TypeScript
npm run type-check       # Validate types
cd frontend && npm run dev   # Frontend dev (localhost:5173)
docker compose up -d --build # Production deploy
```
