import { Router, Request, Response } from "express";
import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { QBittorrentService } from "../services/qbittorrent";
import { RadarrSearchResult } from "../types/index";
import { computeAppScore } from "../services/scoring";
import fs from "fs";
import path from "path";

function parseReleases(rows: any[]) {
  return rows.map((r: any) => {
    const cf = JSON.parse(r.radarr_custom_formats || "[]");
    return {
      ...r,
      radarr_custom_formats: cf,
      positive_attrs: JSON.parse(r.positive_attrs || "[]"),
      negative_attrs: JSON.parse(r.negative_attrs || "[]"),
      app_score: r.user_score != null ? r.user_score : computeAppScore(r.radarr_quality, cf, r.size_mb, r.radarr_rank),
    };
  });
}

function hardlinkDirRecursive(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      hardlinkDirRecursive(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) {
        try {
          fs.linkSync(srcPath, destPath);
        } catch (err: any) {
          if (err.code === "EXDEV") {
            // Cross-device link: fall back to copy
            fs.copyFileSync(srcPath, destPath);
          } else {
            throw err;
          }
        }
      }
    }
  }
}

export function createRequestRoutes(db: Database, radarr: RadarrService, qbittorrent: QBittorrentService) {
  const router = Router();

  // GET /api/requests - List all pending requests
  router.get("/", (req: Request, res: Response) => {
    try {
      const stmt = db.prepare(`
        SELECT * FROM media_requests 
        ORDER BY created_at DESC 
        LIMIT 100
      `);
      const rows = stmt.all();
      
      const parsedRows = rows.map((row: any) => {
        const approvedRows = db.prepare(
          "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.radarr_quality, rc.size_mb " +
          "FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(row.id) as any[];
        const hasTorrent = approvedRows.some((r: any) => r.torrent_hash);

        const releaseStats = db.prepare(
          "SELECT COUNT(*) as count, COALESCE(SUM(size_mb), 0) as total_size_mb FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(row.id) as any;

        return {
          ...row,
          requested_by: JSON.parse(row.requested_by || "[]"),
          approved_release: approvedRows[0] || null,
          has_torrent: hasTorrent,
          release_count: releaseStats?.count || 0,
          total_size_mb: releaseStats?.total_size_mb || 0,
        };
      });
      
      res.json(parsedRows);
    } catch (error) {
      console.error("Error fetching requests:", error);
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  });

  // GET /api/requests/:id - Get specific request with releases
  router.get("/:id", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const stmt = db.prepare("SELECT * FROM media_requests WHERE id = ?");
      const request = stmt.get(id) as any;
      
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      request.requested_by = JSON.parse(request.requested_by || "[]");

      // Get all approved releases
      const approvedRows = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? ORDER BY ah.approved_at DESC"
      ).all(id) as any[];
      const approved_releases = approvedRows.length > 0 ? parseReleases(approvedRows) : [];
      const approvedIds = new Set(approved_releases.map((r: any) => r.id));

      // Get all releases, excluding approved ones
      const releaseStmt = db.prepare("SELECT * FROM release_candidates WHERE request_id = ? ORDER BY radarr_rank ASC");
      const allReleases = parseReleases(releaseStmt.all(id));
      const releases = allReleases.filter((r: any) => !approvedIds.has(r.id));

      res.json({ ...request, releases, approved_releases });
    } catch (error) {
      console.error("Error fetching request:", error);
      res.status(500).json({ error: "Failed to fetch request" });
    }
  });

  // GET /api/requests/:id/releases - Get releases for a request
  router.get("/:id/releases", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseStmt = db.prepare("SELECT * FROM release_candidates WHERE request_id = ? ORDER BY radarr_rank ASC");
      const releases = parseReleases(releaseStmt.all(id));
      res.json(releases);
    } catch (error) {
      console.error("Error fetching releases:", error);
      res.status(500).json({ error: "Failed to fetch releases" });
    }
  });

  // GET /api/requests/:id/torrent-status - Get live torrent status from qBittorrent
  // Optional query: ?hash=xxx to get status for a specific approved release's torrent
  router.get("/:id/torrent-status", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

      const release = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?" +
        (req.query.release_id ? " AND rc.id = ?" : "")
      ).get(...(req.query.release_id ? [id, req.query.release_id] : [id])) as any;

      if (!release || !release.torrent_hash) {
        return res.json({ found: false });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) {
        return res.json({ found: false, hash: release.torrent_hash });
      }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath) && contentPath.startsWith("/Torrents/")) {
        contentPath = "/media" + contentPath;
      }

      let destPath = "";
      let inLibrary = false;
      if (request?.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const movieFolder = movie.path || movie.folderPath;
          const radarrSize = movie.movieFile?.size || 0;
          if (movieFolder) {
            if (fs.existsSync(movieFolder)) {
              const files = fs.readdirSync(movieFolder).filter((f: string) => !f.startsWith("."));
              const videoFile = files.find((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
              if (videoFile) {
                destPath = path.join(movieFolder, videoFile);
              } else if (files.length > 0) {
                destPath = path.join(movieFolder, files[0]);
              } else {
                destPath = movieFolder;
              }
              // Compare actual content file size on disk vs Radarr's imported file size
              if (radarrSize > 0 && fs.existsSync(contentPath)) {
                const st = fs.statSync(contentPath);
                let actualSize = 0;
                if (st.isFile()) {
                  actualSize = st.size;
                } else if (st.isDirectory()) {
                  const vf = fs.readdirSync(contentPath).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
                  if (vf.length > 0) actualSize = fs.statSync(path.join(contentPath, vf[0])).size;
                }
                inLibrary = actualSize > 0 && Math.abs(actualSize - radarrSize) < radarrSize * 0.01;
              }
            } else {
              destPath = movieFolder;
            }
          }
        } catch {
          // ignore
        }
      }

      res.json({
        found: true,
        hash: torrent.hash,
        name: torrent.name,
        state: torrent.state,
        progress: Math.round(torrent.progress * 100),
        dlspeed: torrent.dlspeed,
        upspeed: torrent.upspeed,
        uploaded: torrent.uploaded,
        ratio: Math.round(torrent.ratio * 100) / 100,
        eta: torrent.eta,
        save_path: torrent.save_path,
        content_path: contentPath,
        dest_path: destPath,
        library_path: destPath,
        in_library: inLibrary,
        size: torrent.size,
        num_seeds: torrent.num_seeds,
        num_leechs: torrent.num_leechs,
        added_on: torrent.added_on,
        completion_on: torrent.completion_on,
      });
    } catch (error) {
      console.error("Error fetching torrent status:", error);
      res.status(500).json({ error: "Failed to fetch torrent status" });
    }
  });

  // GET /api/requests/:id/torrent-statuses - Get live torrent status for ALL approved releases
  router.get("/:id/torrent-statuses", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

      const releases = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id, rc.size_mb FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).all(id) as any[];

      // Fetch movie info ONCE for all releases
      let movieFolderPath = "";
      let libraryVideoName = "";
      let radarrFileSize = 0;
      if (request?.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          movieFolderPath = movie.path || movie.folderPath || "";
          // Get the actual file size from Radarr's movieFile
          if (movie.movieFile?.size) {
            radarrFileSize = movie.movieFile.size;
          }
          if (movieFolderPath && fs.existsSync(movieFolderPath)) {
            const files = fs.readdirSync(movieFolderPath).filter((f: string) => !f.startsWith("."));
            const videoFile = files.find((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (videoFile) {
              libraryVideoName = videoFile;
            } else if (files.length > 0) {
              libraryVideoName = files[0];
            }
          }
        } catch {
          // ignore
        }
      }

      const results: any[] = [];

      for (const release of releases) {
        if (!release.torrent_hash) {
          results.push({ release_id: release.release_id, title: release.title, found: false });
          continue;
        }

        const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
        if (!torrent) {
          // Stale hash — torrent was deleted from qBittorrent but hash wasn't cleared
          db.prepare("UPDATE release_candidates SET torrent_hash = '', save_path = '' WHERE id = ?").run(release.release_id);
          results.push({ release_id: release.release_id, title: release.title, found: false });
          continue;
        }

        let contentPath = torrent.content_path;
        if (!fs.existsSync(contentPath) && contentPath.startsWith("/Torrents/")) {
          contentPath = "/media" + contentPath;
        }

        const destPath = movieFolderPath ? path.join(movieFolderPath, libraryVideoName || "") : "";
        // Check if THIS torrent's actual file size matches what Radarr has in library
        let inLibrary = false;
        if (radarrFileSize > 0) {
          // Get actual file size of the torrent's content on disk
          let actualSize = 0;
          if (fs.existsSync(contentPath)) {
            const st = fs.statSync(contentPath);
            if (st.isFile()) {
              actualSize = st.size;
            } else if (st.isDirectory()) {
              // content_path is a directory, check for the main file
              const files = fs.readdirSync(contentPath).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
              if (files.length > 0) {
                actualSize = fs.statSync(path.join(contentPath, files[0])).size;
              }
            }
          }
          // Match if sizes are within 1% (accounts for metadata differences)
          inLibrary = actualSize > 0 && Math.abs(actualSize - radarrFileSize) < radarrFileSize * 0.01;
        }

        results.push({
          release_id: release.release_id,
          title: release.title,
          found: true,
          hash: torrent.hash,
          name: torrent.name,
          state: torrent.state,
          progress: Math.round(torrent.progress * 100),
          dlspeed: torrent.dlspeed,
          upspeed: torrent.upspeed,
          uploaded: torrent.uploaded,
          ratio: Math.round(torrent.ratio * 100) / 100,
          eta: torrent.eta,
          save_path: torrent.save_path,
          content_path: contentPath,
          dest_path: destPath,
          library_path: destPath,
          in_library: inLibrary,
          size: torrent.size,
          num_seeds: torrent.num_seeds,
          num_leechs: torrent.num_leechs,
          added_on: torrent.added_on,
          completion_on: torrent.completion_on,
        });
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching torrent statuses:", error);
      res.status(500).json({ error: "Failed to fetch torrent statuses" });
    }
  });

  // POST /api/requests/:id/reject - Reject a request
  router.post("/:id/reject", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updateStmt = db.prepare("UPDATE media_requests SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      updateStmt.run(id);
      res.json({ success: true, message: "Request rejected" });
    } catch (error) {
      console.error("Error rejecting request:", error);
      res.status(500).json({ error: "Failed to reject request" });
    }
  });

  // POST /api/requests/:id/dismiss?releaseId=X - Delete one torrent + files + clear hash
  router.post("/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;

      if (releaseId) {
        // Delete a single approved release's torrent
        const release = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?"
        ).get(releaseId) as any;

        if (release?.torrent_hash) {
          try {
            await qbittorrent.deleteTorrent(release.torrent_hash, true);
            console.log(`[Dismiss] Deleted torrent ${release.torrent_hash} with files`);
          } catch (err: any) {
            console.error(`[Dismiss] Failed to delete torrent:`, err.message);
          }
        }
        db.prepare("UPDATE release_candidates SET torrent_hash = '', save_path = '' WHERE id = ?").run(releaseId);

        // If no more approved releases with torrents, set DISMISSED
        const remaining = db.prepare(
          "SELECT rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(id) as any;
        if (!remaining) {
          db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        }
      } else {
        // Legacy: dismiss entire request, delete all torrents
        const releases = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(id) as any[];
        for (const release of releases) {
          if (release.torrent_hash) {
            try {
              await qbittorrent.deleteTorrent(release.torrent_hash, true);
            } catch {}
          }
          db.prepare("UPDATE release_candidates SET torrent_hash = '', save_path = '' WHERE id = ?").run(release.id);
        }
        db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error dismissing request:", error);
      res.status(500).json({ error: "Failed to dismiss request" });
    }
  });

  // POST /api/requests/:id/remove-from-library - Delete hardlinked/copied file from library
  router.post("/:id/remove-from-library", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (!request.radarr_id) return res.status(400).json({ error: "No Radarr movie ID" });

      const release = db.prepare(
        "SELECT rc.torrent_hash FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release?.torrent_hash) return res.status(400).json({ error: "No torrent tracked" });

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath) && contentPath.startsWith("/Torrents/")) {
        contentPath = "/media" + contentPath;
      }

      const movie = await radarr.getMovie(request.radarr_id);
      const movieFolder = movie.path || movie.folderPath;
      if (!movieFolder) return res.status(500).json({ error: "Could not determine movie folder" });

      const destPath = path.join(movieFolder, path.basename(contentPath));

      if (!fs.existsSync(destPath)) {
        return res.json({ success: true, message: "File not in library", path: destPath });
      }

      fs.rmSync(destPath, { recursive: false, force: true });
      console.log(`[RemoveFromLibrary] Deleted ${destPath}`);
      res.json({ success: true, message: "Removed from library", path: destPath });
    } catch (error: any) {
      console.error("Error removing from library:", error);
      res.status(500).json({ error: `Failed to remove: ${error.message}` });
    }
  });

  // POST /api/requests/:id/move-to-library - Hardlink files from download folder to Radarr movie folder
  router.post("/:id/move-to-library", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const release = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) {
        return res.status(404).json({ error: "Torrent not found in qBittorrent" });
      }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) {
        if (contentPath.startsWith("/Torrents/")) {
          contentPath = "/media" + contentPath;
        }
      }
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      if (!request.radarr_id) {
        return res.status(400).json({ error: "No Radarr movie ID associated" });
      }

      const movie = await radarr.getMovie(request.radarr_id);
      const movieFolder = movie.path || movie.folderPath;
      if (!movieFolder) {
        return res.status(500).json({ error: "Could not determine movie folder from Radarr" });
      }

      const fileName = path.basename(contentPath);
      const destPath = path.join(movieFolder, fileName);

      if (fs.existsSync(destPath)) {
        return res.json({ success: true, message: "File already exists in library", source: contentPath, destination: destPath, alreadyExists: true });
      }

      const stat = fs.statSync(contentPath);
      if (stat.isDirectory()) {
        hardlinkDirRecursive(contentPath, path.join(movieFolder, path.basename(contentPath)));
      } else {
        fs.mkdirSync(movieFolder, { recursive: true });
        try {
          fs.linkSync(contentPath, destPath);
        } catch (linkErr: any) {
          if (linkErr.code === "EXDEV") {
            console.warn(`[MoveToLibrary] Cross-device link, falling back to copy`);
            fs.copyFileSync(contentPath, destPath);
          } else {
            throw linkErr;
          }
        }
      }

      const method = fs.statSync(destPath).nlink > 1 ? "hardlinked" : "copied";
      console.log(`[MoveToLibrary] ${method} ${contentPath} → ${destPath}`);

      res.json({ success: true, message: `Files ${method} to library`, source: contentPath, destination: destPath });
    } catch (error: any) {
      console.error("Error moving to library:", error);
      res.status(500).json({ error: `Failed to move to library: ${error.message}` });
    }
  });

  // POST /api/requests/:id/search - Re-search for releases
  router.post("/:id/search", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { searchTerm } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      db.prepare("DELETE FROM release_candidates WHERE request_id = ? AND id NOT IN (SELECT release_id FROM approval_history WHERE request_id = ?)").run(id, id);
      db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      const radarrId = request.radarr_id;
      if (!radarrId) {
        return res.status(400).json({ error: "No Radarr ID associated with this request" });
      }

      const releases = await radarr.searchReleases(radarrId, searchTerm || undefined);

      const insertStmt = db.prepare(`
        INSERT INTO release_candidates
        (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
          title = excluded.title,
          indexer = excluded.indexer,
          size_mb = excluded.size_mb,
          radarr_quality = excluded.radarr_quality,
          radarr_custom_formats = excluded.radarr_custom_formats,
          app_score = excluded.app_score,
          radarr_rank = excluded.radarr_rank,
          language = CASE WHEN excluded.language != '' THEN excluded.language ELSE release_candidates.language END,
          info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END,
          seeders = excluded.seeders,
          leechers = excluded.leechers,
          release_group = CASE WHEN excluded.release_group != '' THEN excluded.release_group ELSE release_candidates.release_group END,
          edition = CASE WHEN excluded.edition != '' THEN excluded.edition ELSE release_candidates.edition END,
          protocol = CASE WHEN excluded.protocol != '' THEN excluded.protocol ELSE release_candidates.protocol END,
          publish_date = CASE WHEN excluded.publish_date != '' THEN excluded.publish_date ELSE release_candidates.publish_date END,
          radarr_indexer_id = CASE WHEN excluded.radarr_indexer_id != 0 THEN excluded.radarr_indexer_id ELSE release_candidates.radarr_indexer_id END
      `);

      for (let i = 0; i < releases.length; i++) {
        const r = releases[i];
        const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
        const qualityName = r.quality?.quality?.name || "Unknown";
        const cfNames = r.customFormats?.map((f: any) => f.name) || [];
        const customFormats = JSON.stringify(cfNames);
        const appScore = computeAppScore(qualityName, cfNames, sizeMb, i + 1);
        const language = r.languages?.map((l: any) => l.name).join(", ") || r.language?.name || "";

        insertStmt.run(id, r.guid, r.title, r.indexer, sizeMb, qualityName, customFormats, appScore, i + 1, language, r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0);
      }

      const newStatus = releases.length > 0 ? "AWAITING_APPROVAL" : "SEARCHING";
      db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newStatus, id);

      res.json({ success: true, releasesFound: releases.length });
    } catch (error) {
      console.error("Error searching releases:", error);
      res.status(500).json({ error: "Failed to search releases" });
    }
  });

  // POST /api/requests/:id/approve - Approve a release and grab via Radarr
  router.post("/:id/approve", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { releaseId, reason } = req.body;

      const release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      if (!release) {
        return res.status(404).json({ error: "Release not found" });
      }

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const stmt = db.prepare(`
        INSERT INTO approval_history (request_id, release_id, approved_by, approval_reason)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(id, releaseId, "web-user", reason || "");

      if (request.radarr_id && release.radarr_release_id) {
        try {
          console.log(`[Radarr] Refreshing release cache for ${request.title} before grab...`);
          let refreshedReleases: RadarrSearchResult[] = [];
          try {
            refreshedReleases = await radarr.searchReleases(request.radarr_id);
          } catch {
            // proceed with stale guid
          }

          let indexerId = release.radarr_indexer_id || 0;
          let guid = release.radarr_release_id;

          if (refreshedReleases.length > 0) {
            const match = refreshedReleases.find((r) => r.guid === guid);
            if (match) {
              indexerId = match.indexerId || indexerId;
            }
          }

          // Snapshot existing torrents before grab to detect the new one
          let preGrabHashes: Set<string> = new Set();
          try {
            const preTorrents = await qbittorrent.getTorrents();
            preGrabHashes = new Set(preTorrents.map((t) => t.hash));
          } catch {
            // qBittorrent might not be reachable, fall back to title search
          }

          await radarr.grabRelease(guid, indexerId);
          console.log(`[Radarr] Grabbed release for ${request.title}: ${release.title}`);

          // Find the NEW torrent in qBittorrent (poll up to 30s)
          const detectTorrent = async (attempt: number) => {
            try {
              const postTorrents = await qbittorrent.getTorrents();
              const newTorrent = postTorrents.find((t) => !preGrabHashes.has(t.hash));
              if (newTorrent) {
                db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                  .run(newTorrent.hash, newTorrent.save_path, release.id);
                console.log(`[Radarr] Detected new torrent: ${newTorrent.name} hash=${newTorrent.hash}`);
                return;
              }
            } catch {
              // retry
            }
            if (attempt < 10) {
              setTimeout(() => detectTorrent(attempt + 1), 3000);
            } else {
              console.log(`[Radarr] Could not detect new torrent for ${request.title} after 30s`);
            }
          };
          setTimeout(() => detectTorrent(0), 3000);
        } catch (grabErr: any) {
          if (grabErr?.response?.status === 409) {
            console.log(`[Radarr] Release already grabbed for ${request.title}`);
          } else if (grabErr?.response?.status === 404) {
            console.error(`[Radarr] Release expired from cache for ${request.title}, needs re-search`);
            return res.status(500).json({
              error: "Release expired from Radarr cache",
              details: "The release was found when searching but expired before grab. Please search again and approve quickly.",
            });
          } else {
            console.error(`[Radarr] Failed to grab release for ${request.title}:`, grabErr);
            return res.status(500).json({ error: "Failed to grab release from Radarr", details: String(grabErr) });
          }
        }
      }

      const updateStmt = db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      updateStmt.run("DOWNLOADING", id);

      res.json({ success: true, message: "Release approved and grabbing" });
    } catch (error) {
      console.error("Error approving release:", error);
      res.status(500).json({ error: "Failed to approve release" });
    }
  });

  // POST /api/requests/:id/torrent/pause?releaseId=X - Pause torrent
  router.post("/:id/torrent/pause", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;
      let hash: string | undefined;
      if (releaseId) {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?").get(releaseId) as any;
        hash = release?.torrent_hash;
      } else {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?").get(id) as any;
        hash = release?.torrent_hash;
      }
      if (!hash) return res.status(400).json({ error: "No torrent" });
      await qbittorrent.pauseTorrent(hash);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Pause] Error:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to pause torrent" });
    }
  });

  // POST /api/requests/:id/torrent/resume?releaseId=X - Resume torrent
  router.post("/:id/torrent/resume", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;
      let hash: string | undefined;
      if (releaseId) {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?").get(releaseId) as any;
        hash = release?.torrent_hash;
      } else {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?").get(id) as any;
        hash = release?.torrent_hash;
      }
      if (!hash) return res.status(400).json({ error: "No torrent" });
      await qbittorrent.resumeTorrent(hash);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Resume] Error:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to resume torrent" });
    }
  });

  // POST /api/requests/cleanup - Dismiss requests no longer in Radarr's wanted list
  router.post("/cleanup", async (req: Request, res: Response) => {
    try {
      const movies = await radarr.getWantedMovies();
      const wantedIds = new Set(movies.filter((m: any) => !m.hasFile && m.monitored).map((m: any) => m.id));

      const stale = db.prepare(
        "SELECT id, title, radarr_id FROM media_requests " +
        "WHERE radarr_id IS NOT NULL AND status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL')"
      ).all() as any[];

      let dismissed = 0;
      for (const req of stale) {
        if (!wantedIds.has(req.radarr_id)) {
          db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
          dismissed++;
        }
      }

      res.json({ success: true, dismissed });
    } catch (error) {
      console.error("Error cleaning up requests:", error);
      res.status(500).json({ error: "Failed to cleanup requests" });
    }
  });

  return router;
}
