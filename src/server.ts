import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { initializeDatabase } from "./db/index";
import { createRequestRoutes } from "./routes/requests";
import { RadarrService } from "./services/radarr";
import { QBittorrentService } from "./services/qbittorrent";
import { createRadarrPoller } from "./jobs/pollRadarr";
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
app.use("/api/requests", createRequestRoutes(db, radarr, qbittorrent));

// Test connections endpoint
app.post("/api/test-connections", async (req, res) => {
  const qbitResult = await qbittorrent.testConnection();
  res.json({
    radarr: { success: true },
    sonarr: { success: true },
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
  statusPoller.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});

export default app;
