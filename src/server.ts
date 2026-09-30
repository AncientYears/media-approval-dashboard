import express from "express";
import cors from "cors";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { initializeDatabase } from "./db/index";
import { createRequestRoutes, titlesMatch } from "./routes/requests";
import { RadarrService } from "./services/radarr";
import { SonarrService } from "./services/sonarr";
import { QBittorrentService } from "./services/qbittorrent";
import { ProwlarrService } from "./services/prowlarr";
import { createRadarrPoller } from "./jobs/pollRadarr";
import { createSonarrPoller } from "./jobs/pollSonarr";
import { createStatusPoller } from "./jobs/pollStatus";
import { syncSeerr, isSeerrConfigured } from "./services/seerr";
import { errorSummary } from "./utils/errorSummary";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const DB_PATH = process.env.DATABASE_PATH || "./data/app.db";

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize database
const { db, close: closeDb } = initializeDatabase(DB_PATH);

// Initialize Radarr service and start polling (only when configured — an
// unconfigured arr is a supported state now, not an ECONNREFUSED error loop)
const radarrConfigured = !!(process.env.RADARR_URL && process.env.RADARR_API_KEY);
const radarr = new RadarrService(
  process.env.RADARR_URL || "http://localhost:7878",
  process.env.RADARR_API_KEY || ""
);
const radarrPollInterval = parseInt(process.env.POLL_INTERVAL_RADARR || "60", 10);
const radarrPoller = radarrConfigured
  ? createRadarrPoller(db, radarr, radarrPollInterval)
  : { stop: () => {} };
if (!radarrConfigured) console.log("[Radarr] Not configured (set RADARR_URL + RADARR_API_KEY) — discovery poller disabled");

// Track recently deleted franchise IDs to prevent poller from re-importing them
const deletedFranchiseIds = new Set<number>();

// Initialize Sonarr service and start polling (only when configured)
const sonarrConfigured = !!(process.env.SONARR_URL && process.env.SONARR_API_KEY);
const sonarr = new SonarrService(
  process.env.SONARR_URL || "http://localhost:8989",
  process.env.SONARR_API_KEY || ""
);
const sonarrPollInterval = parseInt(process.env.POLL_INTERVAL_SONARR || "60", 10);
const sonarrPoller = sonarrConfigured
  ? createSonarrPoller(db, sonarr, sonarrPollInterval, deletedFranchiseIds)
  : { stop: () => {} };
if (!sonarrConfigured) console.log("[Sonarr] Not configured (set SONARR_URL + SONARR_API_KEY) — discovery poller disabled");

const qbittorrent = new QBittorrentService(
  process.env.QBIT_URL || "http://localhost:8080",
  process.env.QBIT_USER || "",
  process.env.QBIT_PASS || ""
);

const prowlarr = new ProwlarrService(
  process.env.PROWLARR_URL || "http://localhost:9696",
  process.env.PROWLARR_API_KEY || ""
);

const statusPollInterval = parseInt(process.env.POLL_INTERVAL_STATUS || "30", 10);
const statusPoller = createStatusPoller(db, qbittorrent, statusPollInterval);

// Startup fixup: fix stale DOWNLOADING movies that Radarr already has
(async () => {
  try {
    // Fix movies incorrectly moved to AWAITING_APPROVAL (no release_candidates, no torrent)
    const falseAwaiting = db.prepare(
      `SELECT id, title FROM media_requests mr
       WHERE mr.status = 'AWAITING_APPROVAL' AND mr.type = 'movie'
       AND NOT EXISTS (SELECT 1 FROM release_candidates rc
         JOIN approval_history ah ON ah.release_id = rc.id
         WHERE ah.request_id = mr.id AND rc.torrent_hash != '')`
    ).all() as any[];
    for (const m of falseAwaiting) {
      db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
      console.log(`[Startup] Reverted ${m.title}: AWAITING_APPROVAL → NEW (no torrent/release)`);
    }

    const staleMovies = db.prepare(
      "SELECT id, title, radarr_id FROM media_requests WHERE type = 'movie' AND status = 'DOWNLOADING' AND radarr_id IS NOT NULL"
    ).all() as any[];

    if (staleMovies.length > 0 && radarrConfigured) {
      const radarrMovies = await radarr.getAllMovies();
      const radarrMap = new Map(radarrMovies.map((m: any) => [m.id, m]));
      let fixed = 0;

      for (const m of staleMovies) {
        const rm = radarrMap.get(m.radarr_id);
        if (rm?.hasFile) {
          db.prepare("UPDATE media_requests SET status = 'SEEDING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
          console.log(`[Startup] Fixed stale DOWNLOADING → SEEDING: ${m.title} (Radarr hasFile=true)`);
          fixed++;
        }
      }
      if (fixed > 0) console.log(`[Startup] Fixed ${fixed} stale DOWNLOADING movies`);
    }

    // Clean up stale release_candidates where hash doesn't match title
        const withHashes = db.prepare(
      "SELECT rc.id as rc_id, rc.torrent_hash, rc.title as rc_title, mr.title as req_title, mr.season as req_season, mr.sonarr_id, mr.radarr_id, rc.size_mb " +
      "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
      "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
    ).all() as any[];

    if (withHashes.length > 0) {
      const torrents = await qbittorrent.getTorrents();
      const staleRcIds: { id: number; reason: string }[] = [];
      for (const rc of withHashes) {
        const t = torrents.find((x: any) => x.hash === rc.torrent_hash);
        if (!t) continue;
        // Skip title check if linked to Sonarr/Radarr series — ID match is more reliable than string matching
        if (rc.sonarr_id || rc.radarr_id) continue;
        const tnRaw = t.name.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").trim();
        const tn = tnRaw.replace(/\bS\d{1,2}E\d{1,3}\b/gi, "").replace(/\bS\d{1,2}\b/gi, "").replace(/\s+/g, " ").trim();
        const reqRaw = rc.req_title.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").trim();
        const req = reqRaw.replace(/\bS\d{1,2}E\d{1,3}\b/gi, "").replace(/\bS\d{1,2}\b/gi, "").replace(/\s+/g, " ").trim();
        const isMatch = titlesMatch(req, tn);
        let reason = "";
        if (!isMatch) {
          reason = `title mismatch (is "${t.name}")`;
        } else if (rc.req_season != null) {
          const seasonStr = `S${String(rc.req_season).padStart(2, "0")}`;
          const seasonRegex = new RegExp(`\\b${seasonStr}\\b`, 'i');
          const anySeasonRegex = /\bS\d{1,2}\b/i;
          if (anySeasonRegex.test(t.name) && !seasonRegex.test(t.name)) {
            reason = `season mismatch (torrent lacks ${seasonStr})`;
          }
        }
        if (reason) {
          staleRcIds.push({ id: rc.rc_id, reason });
        }
      }
      if (staleRcIds.length > 0) {
        const delH = db.prepare("DELETE FROM approval_history WHERE release_id = ?");
        const delR = db.prepare("DELETE FROM release_candidates WHERE id = ?");
        for (const { id, reason } of staleRcIds) {
          delH.run(id);
          delR.run(id);
        }
        const reasons = [...new Set(staleRcIds.map((r) => r.reason))];
        console.log(`[Startup] Removed ${staleRcIds.length} stale RC(s): ${reasons.join("; ")}`);
      }

      // Backfill size_mb=0 from qBittorrent
      const zeroSizeRcs = withHashes.filter((rc: any) => {
        if (rc.size_mb && rc.size_mb > 0) return false;
        const t = torrents.find((x: any) => x.hash === rc.torrent_hash);
        return t && t.size > 0;
      });
      const updateSize = db.prepare("UPDATE release_candidates SET size_mb = ? WHERE id = ?");
      let backfilled = 0;
      for (const rc of zeroSizeRcs) {
        const t = torrents.find((x: any) => x.hash === rc.torrent_hash)!;
        const sizeMb = Math.round(t.size / (1024 * 1024));
        updateSize.run(sizeMb, rc.rc_id);
        backfilled++;
      }
      if (backfilled > 0) console.log(`[Startup] Backfilled size_mb for ${backfilled} release_candidates`);
    }
  } catch (err) {
    console.error("[Startup] Fixup error:", err);
  }
})();

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
  });
});

// API Routes
app.use("/api/requests", createRequestRoutes(db, radarr, sonarr, qbittorrent, prowlarr, deletedFranchiseIds));

// Seerr request sync — keeps dashboard requests in step with Seerr additions
// and (importantly) deletions/cancellations. Manual trigger endpoint + a poll
// guarded on SEERR_URL + SEERR_API_KEY; unlike the webhook approach there is no
// notification event for a deleted request, so a periodic reconcile is the only
// way to observe one.
app.post("/api/requests/seerr/sync", async (_req, res) => {
  try {
    res.json(await syncSeerr(db));
  } catch (err: any) {
    res.status(500).json({ error: errorSummary(err) });
  }
});
if (isSeerrConfigured()) {
  const runSeerrSync = async () => {
    try {
      await syncSeerr(db);
    } catch (err) {
      console.error("[Seerr] poll error:", errorSummary(err));
    }
  };
  const seerrPollInterval = Math.max(30, parseInt(process.env.POLL_INTERVAL_SEERR || "60", 10)) * 1000;
  runSeerrSync();
  setInterval(runSeerrSync, seerrPollInterval);
} else {
  console.log("[Seerr] Not configured (set SEERR_URL + SEERR_API_KEY) — request sync disabled");
}

// DB viewer endpoint - returns all tables, their schema, and rows
app.get("/api/db", (_req, res) => {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
    const result: Record<string, { columns: string[]; rows: any[] }> = {};
    for (const { name } of tables) {
      const info = db.prepare(`PRAGMA table_info("${name}")`).all() as any[];
      const columns = info.map((c: any) => c.name);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      result[name] = { columns, rows };
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ntfy has no client class, so probe the base URL directly. A GET on the root
// is read-only — posting to the topic would fire a real notification.
async function testNtfy(): Promise<{ success: boolean; message: string }> {
  const url = process.env.NTFY_URL;
  if (!url) return { success: false, message: "NTFY_URL not set" };
  try {
    await axios.get(url, { timeout: 5000 });
    return { success: true, message: "Reachable" };
  } catch (e: any) {
    return { success: false, message: errorSummary(e) };
  }
}

// Test connections endpoint. Arr-free by default: radarr/sonarr only appear
// when configured (legacy mode); the Jellyseerr placeholder entry is gone —
// Seerr is a first-class service now and is probed for real (Settings -> Main
// -> API Key header, read-only GET).
app.post("/api/test-connections", async (_req, res) => {
  const [qbitResult, prowlarrResult] = await Promise.all([
    qbittorrent.testConnection(),
    prowlarr.testConnection(),
  ]);
  res.json({
    qbittorrent: qbitResult,
    prowlarr: prowlarrResult,
    seerr: await testSeerr(),
    ntfy: await testNtfy(),
  });
});

async function testSeerr(): Promise<{ success: boolean; message: string }> {
  const url = String(process.env.SEERR_URL || "").replace(/\/+$/, "");
  const key = process.env.SEERR_API_KEY || "";
  if (!url || !key) return { success: false, message: "SEERR_URL/SEERR_API_KEY not set" };
  try {
    const r = await axios.get(`${url}/api/v1/request?take=1&skip=0`, {
      headers: { "X-Api-Key": key },
      timeout: 5000,
    });
    const ok = r.status >= 200 && r.status < 300;
    return { success: ok, message: ok ? "Reachable" : `HTTP ${r.status}` };
  } catch (e: any) {
    return { success: false, message: errorSummary(e) };
  }
}

// Read-only view of the configured environment for the Settings page.
// Secrets (keys/tokens/passwords) are masked before leaving the server.
// Radarr/Sonarr vars are the legacy path and intentionally excluded.
const SETTINGS_ENV_KEYS: { key: string; label: string }[] = [
  { key: "MEDIA_ROOT", label: "Media root" },
  { key: "DOWNLOADS_MOVIES", label: "Downloads — movies" },
  { key: "DOWNLOADS_TV", label: "Downloads — TV" },
  { key: "PROCESSED_MOVIES", label: "Processed — movies" },
  { key: "PROCESSED_TV", label: "Processed — TV" },
  { key: "PROCESSING_WORKSPACE", label: "Processing workspace" },
  { key: "TRACKERS_DIR", label: "Trackers dir" },
  { key: "MEDIA_MOVIES", label: "Library — movies" },
  { key: "MEDIA_TV", label: "Library — TV" },
  { key: "QBIT_URL", label: "qBittorrent URL" },
  { key: "QBIT_USER", label: "qBittorrent user" },
  { key: "QBIT_PASS", label: "qBittorrent password" },
  { key: "PROWLARR_URL", label: "Prowlarr URL" },
  { key: "PROWLARR_API_KEY", label: "Prowlarr API key" },
  { key: "SEERR_URL", label: "Seerr URL" },
  { key: "SEERR_API_KEY", label: "Seerr API key" },
  { key: "TMDB_API_KEY", label: "TMDB API key" },
  { key: "TMDB_LANGUAGE", label: "TMDB language" },
  { key: "NTFY_URL", label: "ntfy URL" },
  { key: "NTFY_TOPIC", label: "ntfy topic" },
  { key: "POLL_INTERVAL_STATUS", label: "Status poll (s)" },
  { key: "POLL_INTERVAL_SEERR", label: "Seerr poll (s)" },
  { key: "QBIT_PATH_PREFIX", label: "qBittorrent path prefix" },
  { key: "QBIT_HOST_PREFIX", label: "App path prefix" },
];

function maskSecret(value: string): string {
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

app.get("/api/settings/env", (_req, res) => {
  const entries = SETTINGS_ENV_KEYS.map(({ key, label }) => {
    const raw = process.env[key] || "";
    const secret = /(KEY|PASS|TOKEN|SECRET)$/i.test(key);
    return { key, label, value: raw ? (secret ? maskSecret(raw) : raw) : "", set: !!raw };
  });
  res.json({ entries });
});

// Serve frontend static files
const publicPath = path.join(__dirname, "../public");
app.use(express.static(publicPath));

// SPA fallback: serve index.html for any route not matching API
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"), (err) => {
    if (err) {
      res.status(500).send("Error loading frontend");
    }
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[${NODE_ENV}] Media Approval Dashboard running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

// Graceful shutdown. SIGTERM is what systemd sends on stop/restart; SIGINT is
// kept for interactive use.
function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  radarrPoller.stop();
  sonarrPoller.stop();
  statusPoller.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Don't let an in-flight request hold shutdown open indefinitely.
  setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 15000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
