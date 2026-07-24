# Media Approval Dashboard

A self-hosted approval gateway for Radarr/Sonarr with qBittorrent integration. Review, compare, approve, and track media releases before they download.

## Features

- **Approval Dashboard** — Pending requests + managed media with franchise grouping
- **Release Comparison** — Side-by-side table with app scoring, quality breakdown, seeder counts
- **Season Packs** — Parse multi-episode torrents (S02E01-E12), track episode coverage per season
- **Live Search Progress** — SSE streaming shows "Querying → Found 10 → Indexing 5/10 → Done"
- **Torrent Management** — Pause, resume, move to library, remove from library
- **DB Viewer** — Browse all database tables, edit status with inline dropdowns
- **Import Missing** — Import Radarr/Sonarr items not yet in the DB
- **Detect Torrents** — Match existing qBittorrent torrents to pending requests
- **Toast Notifications** — Non-intrusive feedback for all actions
- **Dark Theme** — Full responsive dark UI

## Architecture

```
Jellyseerr → Radarr/Sonarr → Media Approval Dashboard → Radarr/Sonarr Grab → qBittorrent → Jellyfin
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

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests` | List all requests |
| GET | `/api/requests/:id` | Request detail + releases |
| GET | `/api/requests/managed` | Managed media (franchise grouped) |
| POST | `/api/requests/:id/search` | Search releases (SSE progress) |
| POST | `/api/requests/:id/approve` | Approve + grab |
| POST | `/api/requests/:id/dismiss` | Delete release |
| POST | `/api/requests/:id/set-status` | Manual status fix |
| POST | `/api/requests/:id/move-to-library` | Hardlink to library |
| POST | `/api/requests/detect-torrents` | Match torrents to requests |
| POST | `/api/requests/import-missing` | Import from Radarr/Sonarr |
| GET | `/api/db` | Browse all tables |
| DELETE | `/api/requests/:id` | Delete request + torrent |

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, Vite, TypeScript, React Router
- **Services**: Radarr API v3, Sonarr API v3, qBittorrent Web API v2
- **Database**: SQLite with WAL mode
- **Deployment**: Docker multi-stage build

## License

MIT
