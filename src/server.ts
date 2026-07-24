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

const statusPollInterval = parseInt(process.env.POLL_INTERVAL_STATUS || "30", 10);
const statusPoller = createStatusPoller(db, qbittorrent, statusPollInterval);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
  });
});

// API Routes
app.use("/api/requests", createRequestRoutes(db, radarr, sonarr, qbittorrent));

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
  const [qbitResult, sonarrResult] = await Promise.all([
    qbittorrent.testConnection(),
    sonarr.testConnection(),
  ]);
  res.json({
    radarr: { success: true },
    sonarr: sonarrResult,
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
