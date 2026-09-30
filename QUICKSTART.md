# 🚀 Quick Start Guide

This app is **fully arr-free** — no Sonarr or Radarr needed. The supported stack
is Prowlarr (search), Seerr (request portal), qBittorrent (downloads), TMDB
(episode metadata), and Jellyfin (library).

## Step 1: Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:
```
PROWLARR_URL=http://192.168.1.100:9696
PROWLARR_API_KEY=your_api_key_here
SEERR_URL=http://192.168.1.100:5055
SEERR_API_KEY=your_api_key_here
TMDB_API_KEY=your_tmdb_api_key_here
QBIT_URL=http://127.0.0.1:8080
QBIT_USER=kronos
QBIT_PASS=your_password_here
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your_topic_here
```

Radarr/Sonarr keys are **optional** (legacy mode only) — leave them blank.

## Step 2: Run Backend

```bash
npm run dev
```

Backend will start on **http://localhost:3000**

## Step 3: Run Frontend (in new terminal)

```bash
cd frontend
npm run dev
```

Frontend will start on **http://localhost:5173**

## Step 4: Test It

1. Visit http://localhost:5173 in your browser
2. Go to **Settings** tab
3. Click **Test Connections** button
4. You should see status indicators for each service

## Production Deployment

Bare VM with systemd units and an NFS export — see **DEPLOYMENT.md**.
The Docker path is not the supported deployment.

## Project Files

- **PROGRESS.md** - Implementation summary and requirements status
- **DEPLOYMENT.md** - Production deployment guide
- **README.md** - Project overview
- **.env.example** - Configuration template

## What Works Now

✅ Database initialization
✅ API server with routes
✅ Frontend dashboard layout
✅ Prowlarr search (custom queries, per-season, search-all)
✅ Seerr request sync + delete propagation
✅ TMDB Discover (arr-free requesting)
✅ Native franchise metadata (TMDB episodes, specials, fix-identity, language pref)
✅ Scan Downloads (arr-free native matching, TMDB candidate pre-fill)
✅ Workspaces + hardlink processing
✅ Library Audit / Adoption / native import reconcile
✅ Settings page with connection testing

## What's Next (Phase E)

🔄 "Search All Seasons" for native (arr-free) franchises
🔄 Auto-search on new `NEW` requests
🔄 Remove leftover internal "arr" field names in the UI code

## Troubleshooting

**Backend won't start?**
- Check Node.js version: `node --version` (need 20+)
- Check port 3000 is free
- Verify .env file exists

**Frontend can''t reach backend?**
- Make sure backend is running
- Check Vite proxy in `frontend/vite.config.ts`

**Seerr requests not showing up?**
- Make sure `SEERR_URL` and `SEERR_API_KEY` are set (Settings → Main → API Key)
- Check the manual trigger `POST /api/requests/seerr/sync`

**Database error?**
- Check `./data/` is writable
- Delete `./data/app.db` to reset

---

Happy approving! 📋✨