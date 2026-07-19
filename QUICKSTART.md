# 🚀 Quick Start Guide

## Step 1: Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:
```
RADARR_URL=http://192.168.1.100:7878
RADARR_API_KEY=your_api_key_here
SONARR_URL=http://192.168.1.100:8989
SONARR_API_KEY=your_api_key_here
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your_topic_here
```

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

## Docker Deployment

```bash
docker-compose build
docker-compose up -d
```

Access the app at http://localhost:3000

## Project Files

- **PROGRESS.md** - Detailed implementation summary
- **DEPLOYMENT.md** - Production deployment guide
- **README.md** - Project overview
- **.env.example** - Configuration template

## What Works Now

✅ Database initialization
✅ API server with routes
✅ Frontend dashboard layout
✅ Settings page with connection testing
✅ Docker containerization

## What's Next (Phase 3)

🔄 Polling jobs for Radarr/Sonarr
🔄 Release candidate UI
🔄 Approval flow with grab trigger
🔄 Release comparison component
🔄 Search tweaking UI
🔄 Notifications integration

## Troubleshooting

**Backend won't start?**
- Check Node.js version: `node --version` (need 20+)
- Check port 3000 is free
- Verify .env file exists

**Frontend can''t reach backend?**
- Make sure backend is running
- Check Vite proxy in `frontend/vite.config.ts`

**Database error?**
- Check `./data/` is writable
- Delete `./data/app.db` to reset

---

Happy approving! 📋✨
