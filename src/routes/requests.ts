import { Router, Request, Response } from "express";
import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { SonarrService } from "../services/sonarr";
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

export function createRequestRoutes(db: Database, radarr: RadarrService, sonarr: SonarrService, qbittorrent: QBittorrentService) {
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
          candidate_count: (db.prepare("SELECT COUNT(*) as c FROM release_candidates WHERE request_id = ?").get(row.id) as any)?.c || 0,
        };
      });
      
      res.json(parsedRows);
    } catch (error) {
      console.error("Error fetching requests:", error);
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  });

  // POST /api/requests/cleanup - No-op (auto-dismiss removed, dismiss is manual only)
  router.post("/cleanup", (req: Request, res: Response) => {
    res.json({ success: true, dismissed: 0 });
  });

  // GET /api/requests/managed - Grouped managed media (series by franchise, movies individual)
  router.get("/managed", (req: Request, res: Response) => {
    try {
      // All requests with active torrents
      const rows = db.prepare(`
        SELECT mr.*, 
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2 
           JOIN approval_history ah2 ON ah2.release_id = rc2.id 
           WHERE ah2.request_id = mr.id AND rc2.torrent_hash != '') as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3 
           JOIN approval_history ah3 ON ah3.release_id = rc3.id 
           WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '') as release_count
        FROM media_requests mr
        WHERE mr.status IN ('DOWNLOADING', 'SEEDING')
        ORDER BY mr.title
      `).all() as any[];

      const managed: any[] = [];

      // Group series by sonarr_id (franchise)
      const seriesGroups = new Map<number, any[]>();
      const movies: any[] = [];

      for (const row of rows) {
        if (row.type === "series" && row.sonarr_id) {
          if (!seriesGroups.has(row.sonarr_id)) {
            seriesGroups.set(row.sonarr_id, []);
          }
          seriesGroups.get(row.sonarr_id)!.push(row);
        } else {
          movies.push(row);
        }
      }

      // Build franchise cards for series
      for (const [sonarrId, seasons] of seriesGroups) {
        const franchiseTitle = seasons[0].title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
        managed.push({
          title: franchiseTitle,
          type: "series",
          sonarr_id: sonarrId,
          seasons: seasons.map((s: any) => ({
            season: s.season,
            request_id: s.id,
            status: s.status,
            total_size_mb: s.total_size_mb,
            release_count: s.release_count,
            title: s.title,
          })).sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0)),
          total_size_mb: seasons.reduce((sum: number, s: any) => sum + s.total_size_mb, 0),
          total_releases: seasons.reduce((sum: number, s: any) => sum + s.release_count, 0),
        });
      }

      // Add individual movies
      for (const movie of movies) {
        managed.push({
          title: movie.title,
          type: "movie",
          request_id: movie.id,
          status: movie.status,
          total_size_mb: movie.total_size_mb,
          release_count: movie.release_count,
        });
      }

      // Sort: series first, then movies, alphabetical within each
      managed.sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === "series" ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

      res.json(managed);
    } catch (error) {
      console.error("Error fetching managed media:", error);
      res.status(500).json({ error: "Failed to fetch managed media" });
    }
  });

  // POST /api/requests/reactivate-all - Re-activate all DISMISSED requests
  // Requests with approved releases go to DOWNLOADING + re-detect torrent hashes
  router.post("/reactivate-all", async (req: Request, res: Response) => {
    try {
      const dismissed = db.prepare(
        "SELECT id, title, radarr_id, sonarr_id FROM media_requests WHERE status = 'DISMISSED'"
      ).all() as any[];

      // Get all qBittorrent torrents once for matching
      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {}

      let reactivated = 0;
      for (const r of dismissed) {
        const approvedRelease = db.prepare(
          "SELECT rc.id, rc.torrent_hash, rc.title FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? LIMIT 1"
        ).get(r.id) as any;

        if (approvedRelease) {
          // Has approved release — go to DOWNLOADING
          db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);

          // If hash is empty, try to re-detect from qBittorrent
          if (!approvedRelease.torrent_hash && allTorrents.length > 0) {
            // Match by title (fuzzy — check if torrent name contains the release title)
            const match = allTorrents.find((t: any) =>
              t.name.toLowerCase().includes(approvedRelease.title.toLowerCase().slice(0, 20)) ||
              approvedRelease.title.toLowerCase().includes(t.name.toLowerCase().slice(0, 20))
            );
            if (match) {
              db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                .run(match.hash, match.save_path, approvedRelease.id);
              console.log(`[Reactivate] Re-detected torrent for ${r.title}: ${match.hash}`);
            }
          }
        } else {
          // No approved release — go to NEW for poller to search
          db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
        }
        reactivated++;
      }

      console.log(`[Reactivate] Re-activated ${reactivated} dismissed requests`);
      res.json({ success: true, reactivated });
    } catch (error) {
      console.error("Error reactivating requests:", error);
      res.status(500).json({ error: "Failed to reactivate requests" });
    }
  });

  // POST /api/requests/delete-dismissed - Permanently delete all DISMISSED requests from DB
  router.post("/delete-dismissed", (req: Request, res: Response) => {
    try {
      const result = db.prepare(
        "DELETE FROM media_requests WHERE status = 'DISMISSED'"
      ).run();
      console.log(`[Delete] Permanently deleted ${result.changes} dismissed requests`);
      res.json({ success: true, deleted: result.changes });
    } catch (error) {
      console.error("Error deleting dismissed requests:", error);
      res.status(500).json({ error: "Failed to delete dismissed requests" });
    }
  });

  // POST /api/requests/detect-torrents - Scan qBittorrent for orphaned requests and link them
  router.post("/detect-torrents", async (req: Request, res: Response) => {
    try {
      // Find requests with no active torrent hash — includes DOWNLOADING items whose entries were wiped
      const orphans = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'DOWNLOADING') " +
        "AND NOT EXISTS (" +
        "  SELECT 1 FROM release_candidates rc " +
        "  JOIN approval_history ah ON ah.release_id = rc.id " +
        "  WHERE ah.request_id = mr.id AND rc.torrent_hash != ''" +
        ")"
      ).all() as any[];

      if (orphans.length === 0) {
        return res.json({ success: true, detected: 0, total: 0, matches: [] });
      }

      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {
        return res.json({ success: true, detected: 0, total: orphans.length, error: "qBittorrent unavailable", matches: [] });
      }

      const matchedTorrentHashes = new Set<string>();
      const matches: Array<{ request_id: number; request_title: string; torrent_name: string; torrent_hash: string }> = [];
      let detected = 0;

      for (const orphan of orphans) {
        const titleWords = orphan.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 0 && !["the", "and", "for"].includes(w));

        const match = allTorrents.find((t: any) => {
          if (matchedTorrentHashes.has(t.hash)) return false;
          const tLower = t.name.toLowerCase().replace(/[^a-z0-9\s.]/g, " ").replace(/\s+/g, " ").trim();
          // Require ALL significant title words to appear in the torrent name
          const allWordsPresent = titleWords.every((w: string) => tLower.includes(w));
          if (!allWordsPresent) return false;
          // Extra check: short titles (1-2 words) must match at the start, followed by separator+non-digit or end
          if (titleWords.length <= 2) {
            const firstWord = titleWords[0];
            if (!tLower.startsWith(firstWord)) return false;
            const afterTitle = tLower.slice(firstWord.length);
            // After the first word, expect separator then either:
            // - second word (if 2-word title), year (4+ digits), quality marker, or end
            // - NOT a single digit sequel indicator (2, 3, 4...) unless the title itself has that digit
            if (titleWords.length === 2) {
              if (!afterTitle.includes(titleWords[1])) return false;
              const idx2 = afterTitle.indexOf(titleWords[1]);
              const afterSecond = afterTitle.slice(idx2 + titleWords[1].length).trim();
              // After both words, check next char isn't a sequel number
              if (/^[.\-_\s]*\d{1,2}[.\-_\s]/.test(afterSecond) && !/^[.\-_\s]*(19|20)\d{2}/.test(afterSecond)) return false;
            } else {
              // Single word title: after matching, next should be separator then year/quality/end, NOT sequel digit
              const nextChars = afterTitle.replace(/^[\s.\-_]+/, "");
              if (/^\d{1,2}[\s.\-_]/.test(nextChars) && !/^(19|20)\d{2}/.test(nextChars)) return false;
            }
          }
          return true;
        });

        if (match) {
          matchedTorrentHashes.add(match.hash);
          const sizeMb = Math.round((match.size || 0) / (1024 * 1024));
          const rcResult = db.prepare(
            "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, torrent_hash, save_path) " +
            "VALUES (?, ?, ?, 'manual', ?, 'Unknown', ?, ?)"
          ).run(orphan.id, `manual-${match.hash.slice(0, 12)}`, orphan.title, sizeMb, match.hash, match.save_path);

          db.prepare(
            "INSERT INTO approval_history (request_id, release_id) VALUES (?, ?)"
          ).run(orphan.id, rcResult.lastInsertRowid);

          db.prepare(
            "UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(orphan.id);

          detected++;
          matches.push({ request_id: orphan.id, request_title: orphan.title, torrent_name: match.name, torrent_hash: match.hash });
          console.log(`[Detect] Linked torrent for ${orphan.title} → ${match.name}`);
        }
      }

      res.json({ success: true, detected, total: orphans.length, matches });
    } catch (error) {
      console.error("Error detecting torrents:", error);
      res.status(500).json({ error: "Failed to detect torrents" });
    }
  });

  // POST /api/requests/:id/reactivate - Re-activate a single DISMISSED request
  router.post("/:id/reactivate", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.status !== "DISMISSED") {
        return res.status(400).json({ error: "Request is not dismissed", status: request.status });
      }
      const hasApproved = db.prepare(
        "SELECT 1 FROM approval_history WHERE request_id = ? LIMIT 1"
      ).get(id);
      const newStatus = hasApproved ? "DOWNLOADING" : "NEW";
      db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newStatus, id);
      console.log(`[Reactivate] Re-activated ${request.title} → ${newStatus}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error reactivating request:", error);
      res.status(500).json({ error: "Failed to reactivate request" });
    }
  });
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

  // DELETE /api/requests/:id - Delete a single request and its releases
  router.delete("/:id", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
      console.log(`[Delete] Deleted request #${id}: ${request.title}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting request:", error);
      res.status(500).json({ error: "Failed to delete request" });
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
      } else if (request?.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/serialy", series.title);
          const seasonFolder = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            const files = fs.readdirSync(seasonFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (files.length > 0) destPath = path.join(seasonFolder, files[0]);
            else destPath = seasonFolder;
            // Check if torrent content matches any library file
            if (fs.existsSync(contentPath)) {
              const st = fs.statSync(contentPath);
              let actualSize = 0;
              if (st.isFile()) {
                actualSize = st.size;
              } else if (st.isDirectory()) {
                const vf = fs.readdirSync(contentPath).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
                if (vf.length > 0) actualSize = fs.statSync(path.join(contentPath, vf[0])).size;
              }
              // For series, just check if any file exists in the season folder
              if (actualSize > 0 && files.length > 0) {
                inLibrary = true;
              }
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
        seeding_time: torrent.seeding_time,
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

      // Fetch movie/series info ONCE for all releases
      let movieFolderPath = "";
      let libraryVideoName = "";
      let radarrFileSize = 0;
      let isSonarr = false;
      let seriesSeasonFolder = "";
      if (request?.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          movieFolderPath = movie.path || movie.folderPath || "";
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
      } else if (request?.sonarr_id) {
        isSonarr = true;
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/serialy", series.title);
          seriesSeasonFolder = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
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

        let destPath = "";
        let inLibrary = false;

        if (isSonarr) {
          // Series: check if any files exist in season folder
          destPath = seriesSeasonFolder;
          if (seriesSeasonFolder && fs.existsSync(seriesSeasonFolder)) {
            const files = fs.readdirSync(seriesSeasonFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (files.length > 0) {
              destPath = path.join(seriesSeasonFolder, files[0]);
              inLibrary = true;
            }
          }
        } else {
          // Movie: Radarr size comparison
          destPath = movieFolderPath ? path.join(movieFolderPath, libraryVideoName || "") : "";
          if (radarrFileSize > 0) {
            let actualSize = 0;
            if (fs.existsSync(contentPath)) {
              const st = fs.statSync(contentPath);
              if (st.isFile()) {
                actualSize = st.size;
              } else if (st.isDirectory()) {
                const files = fs.readdirSync(contentPath).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
                if (files.length > 0) {
                  actualSize = fs.statSync(path.join(contentPath, files[0])).size;
                }
              }
            }
            inLibrary = actualSize > 0 && Math.abs(actualSize - radarrFileSize) < radarrFileSize * 0.01;
          }
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
          seeding_time: torrent.seeding_time,
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

  // POST /api/requests/:id/dismiss?releaseId=X - Permanently delete request (or single release)
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

        // Remove the approval_history for this release
        db.prepare("DELETE FROM approval_history WHERE release_id = ? AND request_id = ?").run(releaseId, id);

        // If no more approved releases with torrents, delete the whole request
        const remaining = db.prepare(
          "SELECT rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(id) as any;
        if (!remaining) {
          // Unmonitor from Radarr/Sonarr before deleting
          const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
          if (request?.radarr_id) {
            try { await radarr.unmonitorMovie(request.radarr_id); } catch {}
          }
          if (request?.sonarr_id && request.season != null) {
            try { await sonarr.unmonitorSeason(request.sonarr_id, request.season); } catch {}
          }
          db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(id);
          db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
          console.log(`[Dismiss] Deleted request #${id}: ${request?.title}`);
        }
      } else {
        // Delete entire request: delete all torrents, unmonitor, then remove from DB
        const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

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
        }

        // Unmonitor from Radarr
        if (request?.radarr_id) {
          try {
            await radarr.unmonitorMovie(request.radarr_id);
            console.log(`[Dismiss] Unmonitored movie in Radarr: ${request.title}`);
          } catch (err: any) {
            console.error(`[Dismiss] Failed to update Radarr for ${request.title}:`, err.message);
          }
        }

        // Unmonitor from Sonarr
        if (request?.sonarr_id) {
          try {
            if (request.season != null) {
              await sonarr.unmonitorSeason(request.sonarr_id, request.season);
              console.log(`[Dismiss] Unmonitored season ${request.season} in Sonarr: ${request.title}`);
            } else {
              await sonarr.deleteSeries(request.sonarr_id, true);
              console.log(`[Dismiss] Deleted series from Sonarr: ${request.title}`);
            }
          } catch (err: any) {
            console.error(`[Dismiss] Failed to update Sonarr for ${request.title}:`, err.message);
          }
        }

        // Permanently delete from DB (CASCADE removes release_candidates, approval_history)
        db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
        console.log(`[Dismiss] Deleted request #${id}: ${request?.title}`);
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

      let destPath = "";

      if (request.sonarr_id) {
        // Sonarr series — target season folder
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/serialy", series.title);
          const seasonFolder = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            const files = fs.readdirSync(seasonFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (files.length > 0) destPath = path.join(seasonFolder, files[0]);
            else destPath = seasonFolder;
          }
        } catch {
          // ignore
        }
      } else if (request.radarr_id) {
        // Radarr movie
        const movie = await radarr.getMovie(request.radarr_id);
        const movieFolder = movie.path || movie.folderPath;
        if (movieFolder) destPath = path.join(movieFolder, path.basename(contentPath));
      }

      if (!destPath) return res.status(500).json({ error: "Could not determine library path" });

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

  // POST /api/requests/:id/move-to-library - Hardlink files from download folder to library
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

      let destFolder = "";

      if (request.type === "series" && request.sonarr_id) {
        // Sonarr series — target /media/Serialy/<name>/S01/
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          destFolder = path.join(
            series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title),
            `S${String(seasonNum).padStart(2, "0")}`
          );
        } catch {
          return res.status(500).json({ error: "Could not determine series folder from Sonarr" });
        }
      } else if (request.radarr_id) {
        // Radarr movie
        const movie = await radarr.getMovie(request.radarr_id);
        destFolder = movie.path || movie.folderPath;
        if (!destFolder) {
          return res.status(500).json({ error: "Could not determine movie folder from Radarr" });
        }
      } else {
        return res.status(400).json({ error: "No Radarr or Sonarr ID associated" });
      }

      const fileName = path.basename(contentPath);
      const destPath = path.join(destFolder, fileName);

      if (fs.existsSync(destPath)) {
        return res.json({ success: true, message: "File already exists in library", source: contentPath, destination: destPath, alreadyExists: true });
      }

      const stat = fs.statSync(contentPath);
      if (stat.isDirectory()) {
        hardlinkDirRecursive(contentPath, path.join(destFolder, path.basename(contentPath)));
      } else {
        fs.mkdirSync(destFolder, { recursive: true });
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

      let releases: RadarrSearchResult[] = [];

      if (request.type === "series" && request.sonarr_id != null && request.season != null) {
        // Sonarr search
        releases = await sonarr.searchReleases(request.sonarr_id, request.season, searchTerm || undefined);
      } else if (request.radarr_id) {
        // Radarr search
        releases = await radarr.searchReleases(request.radarr_id, searchTerm || undefined);
      } else {
        return res.status(400).json({ error: "No Radarr or Sonarr ID associated with this request" });
      }

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
      } else if (request.sonarr_id && release.radarr_release_id) {
        // Sonarr grab
        try {
          console.log(`[Sonarr] Refreshing release cache for ${request.title} before grab...`);
          let refreshedReleases: RadarrSearchResult[] = [];
          try {
            refreshedReleases = await sonarr.searchReleases(request.sonarr_id, request.season || 1);
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

          let preGrabHashes: Set<string> = new Set();
          try {
            const preTorrents = await qbittorrent.getTorrents();
            preGrabHashes = new Set(preTorrents.map((t) => t.hash));
          } catch {
            // qBittorrent might not be reachable
          }

          await sonarr.grabRelease(guid, indexerId);
          console.log(`[Sonarr] Grabbed release for ${request.title}: ${release.title}`);

          const detectTorrent = async (attempt: number) => {
            try {
              const postTorrents = await qbittorrent.getTorrents();
              const newTorrent = postTorrents.find((t) => !preGrabHashes.has(t.hash));
              if (newTorrent) {
                db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                  .run(newTorrent.hash, newTorrent.save_path, release.id);
                console.log(`[Sonarr] Detected new torrent: ${newTorrent.name} hash=${newTorrent.hash}`);
                return;
              }
            } catch {
              // retry
            }
            if (attempt < 10) {
              setTimeout(() => detectTorrent(attempt + 1), 3000);
            } else {
              console.log(`[Sonarr] Could not detect new torrent for ${request.title} after 30s`);
            }
          };
          setTimeout(() => detectTorrent(0), 3000);
        } catch (grabErr: any) {
          if (grabErr?.response?.status === 409) {
            console.log(`[Sonarr] Release already grabbed for ${request.title}`);
          } else if (grabErr?.response?.status === 404) {
            console.error(`[Sonarr] Release expired from cache for ${request.title}, needs re-search`);
            return res.status(500).json({
              error: "Release expired from Sonarr cache",
              details: "The release was found when searching but expired before grab. Please search again and approve quickly.",
            });
          } else {
            console.error(`[Sonarr] Failed to grab release for ${request.title}:`, grabErr);
            return res.status(500).json({ error: "Failed to grab release from Sonarr", details: String(grabErr) });
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

  return router;
}
