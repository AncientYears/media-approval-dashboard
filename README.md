# Media Approval Dashboard

A human-friendly approval gateway for Radarr/Sonarr that lets you review, compare, and approve media releases before they download.

## Features

- **Approval Dashboard**: Review wanted items from Radarr/Sonarr
- **Release Comparison**: Side-by-side view of candidate releases
- **Search Tweaking**: Adjust search parameters without opening Radarr
- **Debug View**: Understand why Radarr ranked releases the way it did
- **Batch Approval**: Approve multiple releases at once
- **Notifications**: ntfy integration for mobile alerts
- **TV Support**: Season-level approval for Sonarr series

## Architecture

```
Jellyseerr → Radarr/Sonarr → Media Approval Dashboard → Radarr Grab API → qBittorrent → Jellyfin
```

## Quick Start

### Backend Setup

1. Copy `.env.example` to `.env` and fill in your API keys:
```bash
cp .env.example .env
```

2. Required environment variables:
   - `RADARR_URL` and `RADARR_API_KEY`
   - `SONARR_URL` and `SONARR_API_KEY`
   - `NTFY_URL` and `NTFY_TOPIC`

3. Install and run:
```bash
npm install
npm run dev
```

The backend will start on `http://localhost:3000`

### Database

SQLite database is automatically initialized at `./data/app.db`

## Project Structure

```
.
├── src/
│   ├── server.ts              # Express app entry point
│   ├── types/                 # TypeScript interfaces
│   ├── db/                    # Database initialization & schema
│   ├── services/              # API integrations (Radarr, Sonarr, ntfy)
│   ├── routes/                # API endpoints (to be implemented)
│   └── jobs/                  # Polling jobs (to be implemented)
├── frontend/                  # React frontend (to be implemented)
├── docker-compose.yml         # Docker deployment
├── .env.example               # Environment template
└── tsconfig.json              # TypeScript config
```

## Development

### Run backend in dev mode:
```bash
npm run dev
```

### Type check:
```bash
npm run type-check
```

### Build for production:
```bash
npm run build
npm start
```

## API Endpoints (Roadmap)

- `GET /api/health` - Health check
- `GET /api/requests` - List pending requests
- `GET /api/requests/:id/releases` - Get release candidates for a request
- `POST /api/requests/:id/approve` - Approve a release
- `POST /api/requests/:id/search` - Re-search with tweaked parameters
- `GET /api/settings` - Get configuration
- `POST /api/test-connections` - Test Radarr/Sonarr connectivity

## Philosophy

This is "giving Radarr a pair of glasses 👓" — not replacing Radarr. The app:
- ✅ Shows you what Radarr found
- ✅ Lets you approve before download
- ✅ Explains Radarr''s ranking
- ❌ Does NOT manage imports, hardlinks, or folder structure
- ❌ Does NOT replicate Radarr''s search or parsing logic

Radarr keeps doing what it does best. Your app is the approval layer.

## v1 Scope

Request → Search → Explain → Approve → Download → Watch

Deferred to v2:
- Machine learning from past searches
- Release group bias scoring
- Custom rule engine

## License

MIT
