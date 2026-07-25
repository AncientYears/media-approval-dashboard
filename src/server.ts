import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { initializeDatabase } from "./db/index";
import { createRequestRoutes } from "./routes/requests";
import { RadarrService } from "./services/radarr";
import { SonarrService } from "./services/sonarr";
import { QBittorrentService } from "./services/qbittorrent";
import { ProwlarrService } from "./services/prowlarr";
import { createRadarrPoller } from "./jobs/pollRadarr";
import { createSonarrPoller } from "./jobs/pollSonarr";
import { createStatusPoller } from "./jobs/pollStatus";

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

// Initialize Radarr service and start polling
const radarr = new RadarrService(
  process.env.RADARR_URL || "http://localhost:7878",
  process.env.RADARR_API_KEY || ""
);
const radarrPollInterval = parseInt(process.env.POLL_INTERVAL_RADARR || "60", 10);
const radarrPoller = createRadarrPoller(db, radarr, radarrPollInterval);

// Initialize Sonarr service and start polling
const sonarr = new SonarrService(
  process.env.SONARR_URL || "http://localhost:8989",
  process.env.SONARR_API_KEY || ""
);
const sonarrPollInterval = parseInt(process.env.POLL_INTERVAL_SONARR || "60", 10);
const sonarrPoller = createSonarrPoller(db, sonarr, sonarrPollInterval);

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

    if (staleMovies.length > 0) {
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
      "SELECT rc.id as rc_id, rc.torrent_hash, rc.title as rc_title, mr.title as req_title, mr.season as req_season, rc.size_mb " +
      "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
      "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
    ).all() as any[];

    if (withHashes.length > 0) {
      const torrents = await qbittorrent.getTorrents();
      const staleRcIds: { id: number; reason: string }[] = [];
      for (const rc of withHashes) {
        const t = torrents.find((x: any) => x.hash === rc.torrent_hash);
        if (!t) continue;
        const tn = t.name.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
        const req = rc.req_title.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
        const isMatch = tn === req || tn.startsWith(req + " ") || tn.startsWith(req + ".") || (tn.startsWith(req) && tn.length > req.length && /[e\d]/.test(tn[req.length]));
        let reason = "";
        if (!isMatch) {
          reason = `title mismatch (is "${t.name}")`;
        } else if (rc.req_season != null) {
          const tnSeasonMatch = t.name.toUpperCase().match(/\bS(\d{1,2})(?:E\d|\b)/);
          if (tnSeasonMatch) {
            const torrentSeason = parseInt(tnSeasonMatch[1], 10);
            if (torrentSeason !== rc.req_season) {
              reason = `season mismatch (torrent is S${String(torrentSeason).padStart(2, "0")})`;
            }
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
app.use("/api/requests", createRequestRoutes(db, radarr, sonarr, qbittorrent, prowlarr));

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

// Test connections endpoint
app.post("/api/test-connections", async (req, res) => {
  const [qbitResult, sonarrResult, prowlarrResult] = await Promise.all([
    qbittorrent.testConnection(),
    sonarr.testConnection(),
    prowlarr.testConnection(),
  ]);
  res.json({
    radarr: { success: true },
    sonarr: sonarrResult,
    prowlarr: prowlarrResult,
    jellyseerr: { success: true },
    ntfy: { success: true },
    qbittorrent: qbitResult,
  });
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

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  radarrPoller.stop();
  sonarrPoller.stop();
  statusPoller.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});

export default app;
