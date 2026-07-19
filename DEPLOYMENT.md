# Media Approval Dashboard - Deployment Guide

## Quick Start (Development)

### Prerequisites
- Node.js 20+
- npm or yarn
- Radarr/Sonarr running and accessible
- ntfy configured (self-hosted or ntfy.sh)

### 1. Backend Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# Set RADARR_URL, RADARR_API_KEY, SONARR_URL, SONARR_API_KEY, etc.
```

### 2. Run Backend (Development)

```bash
npm run dev
```

Backend will start on `http://localhost:3000` with hot-reload enabled.

### 3. Frontend Setup

```bash
cd frontend
npm run dev
```

Frontend will start on `http://localhost:5173` with hot-reload enabled. API calls are proxied to localhost:3000.

---

## Docker Deployment (Production)

### Prerequisites
- Docker and Docker Compose installed
- `.env` file configured with production values

### Build and Run

```bash
# Build the Docker image
docker-compose build

# Start the service
docker-compose up -d

# View logs
docker-compose logs -f media-approval-app
```

The app will be available on `http://localhost:3000`

### Database Persistence

SQLite database is stored in `./data/app.db` (mounted as a volume in Docker).

### Updating Environment Variables

Edit the `.env` file and restart:

```bash
docker-compose down
docker-compose up -d
```

---

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `RADARR_URL` | Radarr API URL | `http://192.168.1.100:7878` |
| `RADARR_API_KEY` | Radarr API Key | `abc123...` |
| `SONARR_URL` | Sonarr API URL | `http://192.168.1.100:8989` |
| `SONARR_API_KEY` | Sonarr API Key | `abc123...` |
| `JELLYSEERR_URL` | Jellyseerr URL (reference) | `http://192.168.1.100:5055` |
| `JELLYSEERR_API_KEY` | Jellyseerr API Key | `abc123...` |
| `NTFY_URL` | ntfy service URL | `https://ntfy.sh` or `http://ntfy.local:80` |
| `NTFY_TOPIC` | ntfy topic for notifications | `media_approval_123abc` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `production` or `development` |
| `DATABASE_PATH` | SQLite database path | `./data/app.db` |
| `POLL_INTERVAL_RADARR` | Radarr polling interval (seconds) | `60` |
| `POLL_INTERVAL_SONARR` | Sonarr polling interval (seconds) | `60` |
| `POLL_INTERVAL_STATUS` | Status polling interval (seconds) | `30` |

---

## Development

### Available Scripts

```bash
# Backend
npm run dev          # Start backend with hot-reload
npm run build        # Build backend TypeScript
npm run type-check   # Check TypeScript types
npm start            # Run compiled backend

# Frontend
cd frontend
npm run dev          # Start frontend dev server
npm run build        # Build frontend for production
npm run preview      # Preview production build locally
```

### Project Structure

```
.
├── src/                      # Backend TypeScript source
│   ├── server.ts            # Express app entry point
│   ├── db/                  # Database initialization
│   ├── services/            # Radarr, Sonarr, notification services
│   ├── routes/              # API endpoints
│   ├── jobs/                # Polling jobs (to implement)
│   └── types/               # TypeScript interfaces
├── frontend/                # React frontend
│   ├── src/
│   │   ├── App.tsx          # Main app component
│   │   ├── pages/           # Page components
│   │   ├── components/      # Reusable components
│   │   ├── api.ts           # API client
│   │   └── App.css          # Styling
│   ├── index.html           # HTML entry point
│   └── vite.config.ts       # Vite configuration
├── data/                     # SQLite database (created at runtime)
├── public/                   # Static files
├── docker-compose.yml        # Docker Compose configuration
├── Dockerfile               # Multi-stage Docker build
├── .env.example             # Environment template
└── README.md                # Project documentation
```

---

## API Endpoints

### Health Check
- `GET /api/health` - Health status of the service

### Requests
- `GET /api/requests` - List pending requests
- `GET /api/requests/:id` - Get specific request with release candidates
- `POST /api/requests/:id/approve` - Approve a release

### Settings
- `POST /api/test-connections` - Test connectivity to all services

---

## Troubleshooting

### Backend won't start
1. Check Node.js version: `node --version` (should be 20+)
2. Verify .env file exists and has required variables
3. Check port 3000 is not in use: `netstat -ano | findstr :3000`

### Frontend can't reach API
1. Ensure backend is running on port 3000
2. Check Vite proxy configuration in `frontend/vite.config.ts`
3. Verify CORS is enabled in backend

### Database errors
1. Check `./data/` directory is writable
2. Verify SQLite database file: `./data/app.db`
3. Check logs for SQL errors

### Radarr/Sonarr connection issues
1. Verify API URLs are correct and accessible
2. Test API keys are valid: curl to `/api/v3/system/status`
3. Check firewall rules between app and services

---

## Next Steps

After setup:

1. **Configure Radarr/Sonarr** to add media through Jellyseerr
2. **Monitor dashboard** for pending approvals
3. **Test notifications** via Settings → Test Connections
4. **Review and approve** releases before they download

---

## Version Info

- **v0.1.0** - Initial release with basic dashboard, release viewing, and approval workflow
- Backend: Node.js 20, Express 5, TypeScript 5
- Frontend: React 18, Vite 5, TypeScript 5
- Database: SQLite 3 with better-sqlite3

---

## Support

For issues or feature requests, refer to the code comments and architecture documentation in the project README.
