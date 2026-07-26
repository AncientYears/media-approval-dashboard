import { Router, Request, Response } from "express";
import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { SonarrService } from "../services/sonarr";
import { QBittorrentService } from "../services/qbittorrent";
import { ProwlarrService, ProwlarrRelease } from "../services/prowlarr";
import { RadarrSearchResult } from "../types/index";
import { computeAppScore } from "../services/scoring";
import { parseTorrentName, formatEpisodes } from "../utils/torrentParser";
import { processToLibrary, processFile, ProcessOptions, moveToProcessedSync, moveToLibrarySync, getProcessedDir } from "../services/processor";
import fs from "fs";
import path from "path";

function normalizeTitleForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[:']/g, " ")
    .replace(/[.\-_\[\](){}!@#$%^+=|;<>?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQualityFromName(name: string): string {
  const lower = name.toLowerCase();
  let source = "";
  let resolution = "";

  if (lower.includes("remux")) source = "Remux";
  else if (lower.includes("web-dl") || lower.includes("webdl")) source = "WEBDL";
  else if (lower.includes("webrip") || lower.includes("web-rip")) source = "WEBRip";
  else if (lower.includes("bluray") || lower.includes("bdrip") || lower.includes("blu-ray")) source = "Bluray";
  else if (lower.includes("hdtv") || lower.includes("hdrip") || lower.includes("hd-rip")) source = "HDTV";
  else if (lower.includes("dvdrip") || lower.includes("dvd-rip")) source = "DVD";
  else if (lower.includes("hdtv")) source = "HDTV";
  else if (lower.includes("cam") || lower.includes("telesync")) source = "CAM";
  else if (lower.includes("scr") || lower.includes("screener")) source = "SCR";
  else source = "Bluray";

  if (lower.includes("2160p") || lower.includes("4k")) resolution = "2160p";
  else if (lower.includes("1080p")) resolution = "1080p";
  else if (lower.includes("720p")) resolution = "720p";
  else if (lower.includes("480p")) resolution = "480p";
  else resolution = "1080p";

  if (source === "Remux") return `Remux-${resolution}`;
  if (source === "CAM" || source === "SCR") return source;
  if (source === "DVD") return "DVD";
  return `${source}-${resolution}`;
}

function isSeasonPackTitle(title: string, season: number): boolean {
  const seasonPattern = new RegExp(`\\bS${String(season).padStart(2, "0")}\\b`, "i");
  return seasonPattern.test(title) && !/\bE\d{1,3}\b/i.test(title);
}

function titlesMatch(lookupNorm: string, torrentNorm: string): boolean {
  // Primary: prefix match (lookup title is start of torrent title or vice versa)
  if (torrentNorm.startsWith(lookupNorm) || lookupNorm.startsWith(torrentNorm)) return true;
  // Secondary: lookup title appears in torrent, but must be >= 10 chars to avoid false positives
  // like "Dragons" matching "Ninjago Dragons Rising"
  if (lookupNorm.length >= 10 && torrentNorm.includes(lookupNorm)) return true;
  if (torrentNorm.length >= 10 && lookupNorm.includes(torrentNorm)) return true;

  const shorter = lookupNorm.length <= torrentNorm.length ? lookupNorm : torrentNorm;
  const longer = lookupNorm.length > torrentNorm.length ? lookupNorm : torrentNorm;
  const shorterWords = shorter.split(/\s+/).filter((w: string) => w.length >= 3);
  const longerSet = new Set(longer.split(/\s+/));
  if (shorterWords.length >= 2) {
    const matched = shorterWords.filter((w: string) => longerSet.has(w));
    if (matched.length === shorterWords.length) return true;
  }

  return false;
}

function mapProwlarrToRadarrResult(r: ProwlarrRelease): RadarrSearchResult {
  const guid = r.infoHash || r.guid || r.downloadUrl || `prowlarr-${r.indexerId}-${r.title}`;
  const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
  const isTorrent = r.protocol === "torrent" || !!r.magnetUri || !!r.infoHash;
  const infoOrMagnet = r.magnetUri || r.infoUrl || "";

  const titleLower = (r.title || r.fileName || "").toLowerCase();
  let source = "";
  let resolution = "";

  if (titleLower.includes("dvdremux") || titleLower.includes("dvd remux")) source = "Remux";
  else if (titleLower.includes("remux")) source = "Remux";
  else if (titleLower.includes("web-dl") || titleLower.includes("webdl")) source = "WEBDL";
  else if (titleLower.includes("webrip") || titleLower.includes("web-rip")) source = "WEBRip";
  else if (titleLower.includes("bluray") || titleLower.includes("bdrip") || titleLower.includes("blu-ray")) source = "Bluray";
  else if (titleLower.includes("hdtv")) source = "HDTV";
  else if (titleLower.includes("hdrip") || titleLower.includes("hd-rip")) source = "HDTV";
  else if (titleLower.includes("dvdrip") || titleLower.includes("dvd-rip") || titleLower.includes("dvdr")) source = "DVD";
  else if (titleLower.includes("tvrip") || titleLower.includes("tv-rip") || titleLower.includes("tv rip")) source = "HDTV";
  else if (titleLower.includes("vhsrip") || titleLower.includes("vhs-rip")) source = "VHS";
  else if (titleLower.includes("cam") || titleLower.includes("telesync") || titleLower.includes("telecine") || titleLower.includes("ts ")) source = "CAM";
  else if (titleLower.includes("scr") || titleLower.includes("screener")) source = "SCR";
  else if (titleLower.includes("tc ")) source = "TELECINE";
  else if (titleLower.includes("pal") || titleLower.includes("ntsc")) source = "DVD";
  else source = "Bluray";

  if (titleLower.includes("2160p") || titleLower.includes("4k")) resolution = "2160p";
  else if (titleLower.includes("1080p")) resolution = "1080p";
  else if (titleLower.includes("720p")) resolution = "720p";
  else if (titleLower.includes("480p")) resolution = "480p";
  else resolution = "1080p";

  let qualityName: string;
  if (source === "Remux") qualityName = titleLower.includes("480p") ? "Remux-480p" : `Remux-${resolution}`;
  else if (source === "VHS") qualityName = "VHS";
  else if (source === "CAM" || source === "SCR" || source === "TELECINE") qualityName = source;
  else if (source === "DVD") qualityName = "DVD";
  else qualityName = `${source}-${resolution}`;

  return {
    guid,
    title: r.title || r.fileName || "",
    quality: { quality: { name: qualityName, resolution: 0, source: "", modifier: "" } },
    customFormats: [],
    customFormatScore: 0,
    indexer: r.indexer || "",
    indexerId: r.indexerId,
    size: r.size || 0,
    protocol: isTorrent ? "torrent" : "usenet",
    seeders: r.seeders,
    leechers: r.leechers,
    infoUrl: infoOrMagnet,
    magnetUrl: r.magnetUri || "",
    infoHash: r.infoHash || "",
    publishDate: r.publishDate || "",
  };
}

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

export function createRequestRoutes(db: Database, radarr: RadarrService, sonarr: SonarrService, qbittorrent: QBittorrentService, prowlarr: ProwlarrService) {
  const router = Router();

  // GET /api/requests - List all pending requests
  router.get("/", (req: Request, res: Response) => {
    try {
      const stmt = db.prepare(`
        SELECT * FROM media_requests 
        ORDER BY created_at DESC 
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

  // POST /api/requests/cleanup - Reset stale SEARCHING requests, clean up orphaned RCs
  router.post("/cleanup", (req: Request, res: Response) => {
    try {
      const stuck = db.prepare(
        `UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'SEARCHING'`
      ).run();
      const orphaned = db.prepare(
        `DELETE FROM release_candidates WHERE request_id NOT IN (SELECT id FROM media_requests)`
      ).run();
      res.json({ reset: stuck.changes, orphanedRcs: orphaned.changes });
    } catch (error) {
      console.error("Error cleaning up:", error);
      res.status(500).json({ error: "Failed to cleanup" });
    }
  });

  // POST /api/requests/cleanup-duplicates - Remove duplicate media_requests by title, keep best one
  router.post("/cleanup-duplicates", async (req: Request, res: Response) => {
    try {
      const dryRun = !!req.body?.dryRun;
      const results: Array<{ title: string; kept: number; deleted: number; movedRcs: number; sonarrDeleted: number[]; radarrDeleted: number[] }> = [];

      // Find duplicates by normalized title + type
      const dupes = db.prepare(`
        SELECT title, type, COUNT(*) as cnt
        FROM media_requests
        GROUP BY LOWER(title), type
        HAVING cnt > 1
      `).all() as any[];

      const sonarrIdsToDelete: number[] = [];
      const radarrIdsToDelete: number[] = [];

      for (const dupe of dupes) {
        const rows = db.prepare(`
          SELECT mr.*,
            (SELECT COUNT(*) FROM release_candidates rc WHERE rc.request_id = mr.id) as rc_count
          FROM media_requests mr
          WHERE LOWER(mr.title) = LOWER(?) AND mr.type = ?
          ORDER BY mr.id ASC
        `).all(dupe.title, dupe.type) as any[];

        // Keep the one with most RCs, or earliest ID
        const keep = rows.reduce((best: any, cur: any) => {
          if (cur.rc_count > best.rc_count) return cur;
          if (cur.rc_count === best.rc_count && cur.id < best.id) return cur;
          return best;
        }, rows[0]);

        const deleteRows = rows.filter((r: any) => r.id !== keep.id);
        let movedRcs = 0;

        if (!dryRun) {
          for (const del of deleteRows) {
            // Move RCs from deleted request to kept request, skip conflicts
            const orphanRcs = db.prepare("SELECT * FROM release_candidates WHERE request_id = ?").all(del.id) as any[];
            for (const rc of orphanRcs) {
              const conflict = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND radarr_release_id = ?").get(keep.id, rc.radarr_release_id);
              if (conflict) {
                // Duplicate RC — delete instead of move
                db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.id);
                db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.id);
              } else {
                db.prepare("UPDATE release_candidates SET request_id = ? WHERE id = ?").run(keep.id, rc.id);
                movedRcs++;
              }
            }
            db.prepare("DELETE FROM media_requests WHERE id = ?").run(del.id);
            if (del.sonarr_id) sonarrIdsToDelete.push(del.sonarr_id);
            if (del.radarr_id) radarrIdsToDelete.push(del.radarr_id);
          }
        } else {
          movedRcs = deleteRows.reduce((sum: number, del: any) => {
            return sum + (db.prepare("SELECT COUNT(*) as c FROM release_candidates WHERE request_id = ?").get(del.id) as any).c;
          }, 0);
          for (const del of deleteRows) {
            if (del.sonarr_id) sonarrIdsToDelete.push(del.sonarr_id);
            if (del.radarr_id) radarrIdsToDelete.push(del.radarr_id);
          }
        }

        results.push({
          title: dupe.title,
          kept: keep.id,
          deleted: deleteRows.length,
          movedRcs,
          sonarrDeleted: deleteRows.map((d: any) => d.sonarr_id).filter(Boolean),
          radarrDeleted: deleteRows.map((d: any) => d.radarr_id).filter(Boolean),
        });
      }

      // Delete duplicate Sonarr/Radarr entries
      if (!dryRun) {
        const sUrl = process.env.SONARR_URL || "";
        const sKey = process.env.SONARR_API_KEY || "";
        const rUrl = process.env.RADARR_URL || "";
        const rKey = process.env.RADARR_API_KEY || "";
        for (const sid of [...new Set(sonarrIdsToDelete)]) {
          try {
            await fetch(`${sUrl}/api/v3/series/${sid}?deleteFiles=false`, {
              method: "DELETE",
              headers: { "X-Api-Key": sKey },
            });
          } catch {}
        }
        for (const rid of [...new Set(radarrIdsToDelete)]) {
          try {
            await fetch(`${rUrl}/api/v3/movie/${rid}?deleteFiles=false&addImportListExclusion=true`, {
              method: "DELETE",
              headers: { "X-Api-Key": rKey },
            });
          } catch {}
        }
      }

      // Cleanup orphaned RCs
      if (!dryRun) {
        const orphaned = db.prepare(`
          SELECT rc.id FROM release_candidates rc
          LEFT JOIN media_requests mr ON mr.id = rc.request_id
          WHERE mr.id IS NULL
        `).all() as any[];
        if (orphaned.length > 0) {
          db.prepare(`DELETE FROM release_candidates WHERE id IN (${orphaned.map((r: any) => r.id).join(",")})`).run();
        }
      }

      const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
      console.log(`[Cleanup] ${dryRun ? "DRY RUN: " : ""}Removed ${totalDeleted} duplicate request(s), moved RCs, deleted ${sonarrIdsToDelete.length} Sonarr + ${radarrIdsToDelete.length} Radarr entries`);

      res.json({ success: true, dryRun, duplicates: results.length, results });
    } catch (error: any) {
      console.error("Error cleaning up duplicates:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/remove-titles - Remove specific entries by title (wrong matches from scan-downloads)
  router.post("/remove-titles", async (req: Request, res: Response) => {
    try {
      const titles: string[] = req.body?.titles || [];
      if (!titles.length) return res.status(400).json({ error: "No titles provided" });

      const removed: Array<{ title: string; id: number; sonarr_id?: number; radarr_id?: number }> = [];
      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";
      const rUrl = process.env.RADARR_URL || "";
      const rKey = process.env.RADARR_API_KEY || "";

      for (const title of titles) {
        const rows = db.prepare("SELECT * FROM media_requests WHERE LOWER(title) = LOWER(?)").all(title) as any[];
        for (const row of rows) {
          db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(row.id);
          db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(row.id);
          db.prepare("DELETE FROM media_requests WHERE id = ?").run(row.id);

          if (row.sonarr_id && sUrl) {
            try {
              await fetch(`${sUrl}/api/v3/series/${row.sonarr_id}?deleteFiles=false`, {
                method: "DELETE",
                headers: { "X-Api-Key": sKey },
              });
            } catch {}
          }
          if (row.radarr_id && rUrl) {
            try {
              await fetch(`${rUrl}/api/v3/movie/${row.radarr_id}?deleteFiles=false`, {
                method: "DELETE",
                headers: { "X-Api-Key": rKey },
              });
            } catch {}
          }

          removed.push({ title: row.title, id: row.id, sonarr_id: row.sonarr_id, radarr_id: row.radarr_id });
          console.log(`[RemoveTitles] Removed: ${row.title} (id=${row.id}, sonarr=${row.sonarr_id}, radarr=${row.radarr_id})`);
        }
      }

      // Cleanup orphaned RCs
      const orphaned = db.prepare(`
        SELECT rc.id FROM release_candidates rc
        LEFT JOIN media_requests mr ON mr.id = rc.request_id
        WHERE mr.id IS NULL
      `).all() as any[];
      if (orphaned.length > 0) {
        db.prepare(`DELETE FROM release_candidates WHERE id IN (${orphaned.map((r: any) => r.id).join(",")})`).run();
      }

      res.json({ success: true, removed: removed.length, results: removed });
    } catch (error: any) {
      console.error("Error removing titles:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/import-missing - Import movies/series from Radarr/Sonarr that have no request in DB
  router.post("/import-missing", async (req: Request, res: Response) => {
    try {
      const imported: Array<{ title: string; id: number }> = [];
      const skipped: Array<{ title: string; radarr_id: number; reason: string }> = [];

      // Diagnostic: log all Moana-related requests for debugging
      const allMoana = db.prepare("SELECT id, title, radarr_id, sonarr_id, type, status FROM media_requests WHERE title LIKE '%oana%'").all() as any[];
      if (allMoana.length > 0) {
        for (const m of allMoana) {
          console.log(`[Import] DEBUG Moana request: id=${m.id}, title="${m.title}", radarr_id=${m.radarr_id}, sonarr_id=${m.sonarr_id}, type=${m.type}, status=${m.status}`);
        }
      } else {
        console.log(`[Import] DEBUG No Moana request found in DB at all`);
      }

      // Import movies from Radarr
      const radarrMovies = await radarr.getAllMovies();
      const existingRadarrIds = new Set(
        db.prepare("SELECT radarr_id FROM media_requests WHERE radarr_id IS NOT NULL")
          .all().map((r: any) => r.radarr_id)
      );
      const existingTitles = new Set(
        db.prepare("SELECT title FROM media_requests WHERE type = 'movie'")
          .all().map((r: any) => r.title.toLowerCase())
      );

      console.log(`[Import] Radarr returned ${radarrMovies.length} movies. DB has ${existingRadarrIds.size} radarr_ids, ${existingTitles.size} movie titles.`);

      for (const movie of radarrMovies) {
        if (existingRadarrIds.has(movie.id)) {
          skipped.push({ title: movie.title, radarr_id: movie.id, reason: "radarr_id exists in DB" });
          continue;
        }
        if (existingTitles.has(movie.title.toLowerCase())) {
          skipped.push({ title: movie.title, radarr_id: movie.id, reason: "title exists in DB" });
          continue;
        }
        const status = movie.hasFile ? "SEEDING" : "NEW";
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, ?, '[]')"
        ).run(movie.title, movie.id, status);
        const requestId = result.lastInsertRowid as number;
        console.log(`[Import] Created movie request: ${movie.title} (radarr_id=${movie.id}, status=${status})`);

        // If SEEDING (hasFile=true), try to detect torrent hash from qBittorrent
        if (status === "SEEDING") {
          try {
            const torrents = await qbittorrent.getTorrents();
            const normTitle = movie.title.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
            const match = torrents.find((t) => {
              const tn = t.name.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
              return tn === normTitle || tn.startsWith(normTitle + " ") || tn.startsWith(normTitle + ".");
            });
            if (match) {
              db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'import', ?, ?, 'unknown')"
              ).run(requestId, `imported-${movie.id}`, movie.title, match.hash, match.save_path);
              db.prepare(
                "INSERT INTO approval_history (request_id, release_id, approved_by) VALUES (?, (SELECT id FROM release_candidates WHERE request_id = ? LIMIT 1), 'system')"
              ).run(requestId, requestId);
              console.log(`[Import] Detected torrent for ${movie.title}: hash=${match.hash}`);
            }
          } catch {}
        }

        imported.push({ title: movie.title, id: requestId });
      }

      // Import series seasons from Sonarr
      const sonarrSeries = await sonarr.getWantedMissing();
      const existingSonarrSeasons = db.prepare("SELECT sonarr_id, season FROM media_requests WHERE sonarr_id IS NOT NULL")
        .all().map((r: any) => `${r.sonarr_id}-${r.season}`);

      for (const s of sonarrSeries) {
        const key = `${s.seriesId}-${s.seasonNumber}`;
        if (existingSonarrSeasons.includes(key)) continue;
        const title = s.seasonNumber === 0 ? `${s.title} - Specials` : `${s.title} S${String(s.seasonNumber).padStart(2, "0")}`;
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count) VALUES (?, 'series', ?, ?, 'NEW', '[]', ?)"
        ).run(title, s.seriesId, s.seasonNumber, s.episodeCount || null);
        console.log(`[Import] Created series request: ${title} (sonarr_id=${s.seriesId})`);
        imported.push({ title, id: result.lastInsertRowid as number });
      }

      // Clean up orphaned requests (radarr_id exists in DB but not in Radarr)
      const radarrIdSet = new Set(radarrMovies.map((m: any) => m.id));
      const allMovieRequests = db.prepare(
        "SELECT id, title, radarr_id FROM media_requests WHERE type = 'movie' AND radarr_id IS NOT NULL"
      ).all() as any[];
      const orphanedMovies: Array<{ title: string; radarr_id: number }> = [];
      for (const req of allMovieRequests) {
        if (!radarrIdSet.has(req.radarr_id)) {
          db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(req.id);
          db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(req.id);
          db.prepare("DELETE FROM media_requests WHERE id = ?").run(req.id);
          orphanedMovies.push({ title: req.title, radarr_id: req.radarr_id });
          console.log(`[Import] Removed orphaned request: ${req.title} (radarr_id=${req.radarr_id} not in Radarr)`);
        }
      }

      res.json({ success: true, imported: imported.length, skipped: skipped.length, orphaned: orphanedMovies.length, items: imported, skippedItems: skipped, removedOrphans: orphanedMovies.map((o: any) => o.title) });
    } catch (error) {
      console.error("Error importing missing requests:", error);
      res.status(500).json({ error: "Failed to import missing requests" });
    }
  });

  // GET /api/requests/managed - Grouped managed media (series by franchise, movies individual)
  router.get("/managed", async (req: Request, res: Response) => {
    try {
      // All requests with active torrents
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT mr.*, 
            (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2 
             JOIN approval_history ah2 ON ah2.release_id = rc2.id 
             WHERE ah2.request_id = mr.id AND rc2.torrent_hash != '') as total_size_mb,
            (SELECT COUNT(*) FROM release_candidates rc3 
             JOIN approval_history ah3 ON ah3.release_id = rc3.id 
             WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '') as release_count
          FROM media_requests mr
          WHERE mr.status IN ('DOWNLOADING', 'SEEDING')
        ) sub
        WHERE sub.type = 'series' OR sub.release_count > 0
        ORDER BY sub.title
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
        // Backfill episode_count from Sonarr for any seasons missing it
        const seriesObj = await sonarr.getSeries(sonarrId).catch(() => null);
        if (seriesObj) {
          for (const s of seasons) {
            if (!s.episode_count) {
              const sn = (seriesObj.seasons || []).find((x: any) => x.seasonNumber === s.season);
              if (sn?.statistics?.episodeCount) {
                s.episode_count = sn.statistics.episodeCount;
                db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(sn.statistics.episodeCount, s.id);
              }
            }
          }
        }

        const franchiseTitle = seasons[0].title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
        const firstRequestId = seasons[0].id;
        managed.push({
          title: franchiseTitle,
          type: "series",
          sonarr_id: sonarrId,
          first_request_id: firstRequestId,
          seasons: seasons.map((s: any) => {
            // Get covered episodes from parsed_episodes on approved releases
            const coveredRows = db.prepare(`
              SELECT rc.parsed_episodes, rc.title FROM release_candidates rc
              JOIN approval_history ah ON ah.release_id = rc.id
              WHERE ah.request_id = ? AND rc.torrent_hash != ''
            `).all(s.id) as any[];
            const coveredEps = new Set<number>();
            for (const cr of coveredRows) {
              if (cr.parsed_episodes) {
                const epMatches = cr.parsed_episodes.match(/E(\d{1,3})/g);
                if (epMatches) {
                  for (const em of epMatches) coveredEps.add(parseInt(em.slice(1), 10));
                }
                const rangeMatch = cr.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
                if (rangeMatch) {
                  for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) coveredEps.add(i);
                }
              } else if (s.episode_count && s.season != null && isSeasonPackTitle(cr.title || '', s.season)) {
                for (let i = 1; i <= s.episode_count; i++) coveredEps.add(i);
              }
            }
            return {
              season: s.season,
              request_id: s.id,
              status: s.status,
              total_size_mb: s.total_size_mb,
              release_count: s.release_count,
              title: s.title,
          episode_count: s.episode_count,
              covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
            };
          }).sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0)),
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

  // DELETE /api/requests/managed/:sonarrId - Delete entire franchise (all seasons + Sonarr entry)
  router.delete("/managed/:sonarrId", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const rows = db.prepare("SELECT id, title FROM media_requests WHERE sonarr_id = ?").all(sonarrId) as any[];
      if (rows.length === 0) return res.json({ success: true, deleted: 0, title: null });

      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";

      // Delete from Sonarr
      if (sUrl) {
        try { await fetch(`${sUrl}/api/v3/series/${sonarrId}?deleteFiles=false`, { method: "DELETE", headers: { "X-Api-Key": sKey } }); } catch {}
      }

      // Delete all requests + RCs + approval history
      for (const row of rows) {
        db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(row.id);
        db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(row.id);
        db.prepare("DELETE FROM media_requests WHERE id = ?").run(row.id);
      }

      console.log(`[Delete] Deleted franchise sonarr_id=${sonarrId}: ${rows[0].title} (${rows.length} requests)`);
      res.json({ success: true, deleted: rows.length, title: rows[0].title });
    } catch (error: any) {
      console.error("Error deleting franchise:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/managed/:sonarrId - Franchise detail: all seasons + all releases
  router.get("/managed/:sonarrId", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasons = db.prepare(`
        SELECT mr.*,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           JOIN approval_history ah2 ON ah2.release_id = rc2.id AND ah2.request_id = mr.id
           WHERE rc2.torrent_hash != '') as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3
           JOIN approval_history ah3 ON ah3.release_id = rc3.id AND ah3.request_id = mr.id
           WHERE rc3.torrent_hash != '') as release_count,
          (SELECT COUNT(*) FROM release_candidates rc4
           WHERE rc4.request_id = mr.id) as total_candidates
        FROM media_requests mr
        WHERE mr.sonarr_id = ? AND mr.type = 'series'
        ORDER BY mr.season
      `).all(sonarrId) as any[];

      if (seasons.length === 0) {
        return res.status(404).json({ error: "Franchise not found" });
      }

      const franchiseTitle = seasons[0].title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");

      const seasonDetails: any[] = [];
      for (const s of seasons) {
        // Backfill episode_count from Sonarr if null
        let episodeCount = s.episode_count;
        if (!episodeCount && s.sonarr_id) {
          try {
            const series = await sonarr.getSeries(s.sonarr_id);
            const sonarrSeason = (series.seasons || []).find((sn: any) => sn.seasonNumber === s.season);
            if (sonarrSeason?.statistics?.episodeCount) {
              episodeCount = sonarrSeason.statistics.episodeCount;
              db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(episodeCount, s.id);
            }
          } catch {}
        }

        const releases = db.prepare(`
          SELECT rc.*, ah.approved_at, ah.approval_reason
          FROM release_candidates rc
          LEFT JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = ?
          WHERE rc.request_id = ?
          ORDER BY rc.app_score DESC, rc.size_mb DESC
        `).all(s.id, s.id) as any[];

        // Get covered episodes — only from approved releases with torrent_hash (actually have these episodes)
        const coveredEps = new Set<number>();
        for (const r of releases) {
          if (r.approved_at && r.torrent_hash) {
            if (r.parsed_episodes) {
              const epMatches = r.parsed_episodes.match(/E(\d{1,3})/g);
              if (epMatches) {
                for (const em of epMatches) coveredEps.add(parseInt(em.slice(1), 10));
              }
              const rangeMatch = r.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
              if (rangeMatch) {
                for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) coveredEps.add(i);
              }
            } else if (episodeCount && s.season != null && isSeasonPackTitle(r.title || '', s.season)) {
              for (let i = 1; i <= episodeCount; i++) coveredEps.add(i);
            }
          }
        }

        seasonDetails.push({
          season: s.season,
          request_id: s.id,
          status: s.status,
          total_size_mb: s.total_size_mb,
          release_count: s.release_count,
          title: s.title,
          episode_count: episodeCount,
          covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
          releases: releases.map((r: any) => ({
            id: r.id,
            title: r.title,
            size_mb: r.size_mb,
            quality: r.radarr_quality,
            seeders: r.seeders,
            leechers: r.leechers,
            release_group: r.release_group,
            torrent_hash: r.torrent_hash,
            app_score: r.app_score,
            parsed_episodes: r.parsed_episodes || '',
            approved: !!r.approved_at,
            approved_at: r.approved_at || null,
            info_url: r.info_url || '',
            indexer: r.indexer || '',
          })),
        });
      }

      res.json({
        title: franchiseTitle,
        sonarr_id: sonarrId,
        seasons: seasonDetails,
        total_size_mb: seasons.reduce((sum: number, s: any) => sum + s.total_size_mb, 0),
        total_releases: seasons.reduce((sum: number, s: any) => sum + s.release_count, 0),
      });
    } catch (error) {
      console.error("Error fetching franchise detail:", error);
      res.status(500).json({ error: "Failed to fetch franchise detail" });
    }
  });

  // GET /api/requests/managed/:sonarrId/season/:season/episodes - Episode list with coverage from Sonarr
  router.get("/managed/:sonarrId/season/:season/episodes", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasonNum = Number(req.params.season);

      const row = db.prepare(
        "SELECT id, sonarr_id, title, season, episode_count FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND season = ?"
      ).get(sonarrId, seasonNum) as any;

      if (!row) return res.status(404).json({ error: "Season not found" });

      let sonarrEpisodes: Array<{ episodeNumber: number; title: string; hasFile: boolean; airDateUtc?: string }> = [];
      try {
        const episodes = await sonarr.getSeasonEpisodes(row.sonarr_id, seasonNum);
        sonarrEpisodes = episodes.map((e) => ({
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.hasFile,
          airDateUtc: e.airDateUtc,
        }));
      } catch {
        // Sonarr might not have the series, fall back to empty
      }

      const coveredEps = new Set<number>();
      const epQuality: Record<number, string> = {};
      const releases = db.prepare(`
        SELECT rc.parsed_episodes, rc.radarr_quality, rc.title, ah.approved_at, rc.torrent_hash
        FROM release_candidates rc
        LEFT JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = ?
        WHERE rc.request_id = ?
      `).all(row.id, row.id) as any[];

      let hasSeasonPack = false;
      for (const r of releases) {
          if (r.approved_at && r.torrent_hash) {
            if (r.parsed_episodes) {
              const quality = r.radarr_quality === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
              const epMatches = r.parsed_episodes.match(/E(\d{1,3})/g);
            if (epMatches) {
              for (const em of epMatches) {
                const epNum = parseInt(em.slice(1), 10);
                coveredEps.add(epNum);
                if (!epQuality[epNum] || quality.toLowerCase().includes("remux")) epQuality[epNum] = quality;
              }
            }
            const rangeMatch = r.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
            if (rangeMatch) {
              for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) {
                coveredEps.add(i);
                if (!epQuality[i] || quality.toLowerCase().includes("remux")) epQuality[i] = quality;
              }
            }
          } else if (row.season != null && isSeasonPackTitle(r.title || '', row.season)) {
            hasSeasonPack = true;
            const quality = r.radarr_quality === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
            for (let i = 1; i <= (sonarrEpisodes.length || row.episode_count || 0); i++) {
              if (!epQuality[i] || quality.toLowerCase().includes("remux")) epQuality[i] = quality;
            }
          }
        }
      }

      if (sonarrEpisodes.length > 0) {
        if (hasSeasonPack) {
          for (const e of sonarrEpisodes) coveredEps.add(e.episodeNumber);
        }
        const episodes = sonarrEpisodes.map((e) => ({
          ...e,
          covered: coveredEps.has(e.episodeNumber),
          quality: epQuality[e.episodeNumber] || "",
        }));
        res.json({ episodeCount: episodes.length, coveredCount: coveredEps.size, episodes });
      } else {
        const epCount = row.episode_count || 0;
        if (hasSeasonPack) {
          for (let i = 1; i <= epCount; i++) coveredEps.add(i);
        }
        const episodes = Array.from({ length: epCount }, (_, i) => ({
          episodeNumber: i + 1,
          title: `Episode ${i + 1}`,
          hasFile: false,
          covered: coveredEps.has(i + 1),
        }));
        res.json({ episodeCount: epCount, coveredCount: coveredEps.size, episodes });
      }
    } catch (error: any) {
      console.error("Error fetching season episodes:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to fetch episodes" });
    }
  });

  // GET /api/requests/managed/:sonarrId/torrent-statuses - All torrent statuses across all seasons
  router.get("/managed/:sonarrId/torrent-statuses", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasons = db.prepare(
        "SELECT id, season, title, sonarr_id FROM media_requests WHERE sonarr_id = ? AND type = 'series'"
      ).all(sonarrId) as any[];

      if (seasons.length === 0) {
        return res.status(404).json({ error: "Franchise not found" });
      }

      const requestIds = seasons.map((s: any) => s.id);
      const placeholders = requestIds.map(() => "?").join(",");

      const releases = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id, rc.size_mb, ah.request_id " +
        "FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id " +
        `WHERE ah.request_id IN (${placeholders}) AND rc.torrent_hash != ''`
      ).all(...requestIds) as any[];

      if (releases.length === 0) {
        return res.json([]);
      }

      const torrents = await qbittorrent.getTorrents();
      const results: any[] = [];

      for (const release of releases) {
        const torrent = torrents.find((t: any) => t.hash === release.torrent_hash);
        if (!torrent) {
          results.push({ release_id: release.release_id, request_id: release.request_id, title: release.title, found: false });
          continue;
        }

        const season = seasons.find((s: any) => s.id === release.request_id);
        let inLibrary = false;
        let libraryPath = "";

        if (season) {
          try {
            const series = await sonarr.getSeries(season.sonarr_id);
            const seasonFolder = path.join(
              series.path || path.join(process.env.MEDIA_TV || "/media/serialy", series.title),
              `S${String(season.season).padStart(2, "0")}`
            );
            if (fs.existsSync(seasonFolder)) {
              const files = fs.readdirSync(seasonFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
              if (files.length > 0) {
                inLibrary = true;
                libraryPath = path.join(seasonFolder, files[0]);
              }
            }
          } catch {}
        }

        results.push({
          release_id: release.release_id,
          request_id: release.request_id,
          season: season?.season,
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
          content_path: torrent.content_path,
          in_library: inLibrary,
          library_path: libraryPath,
          num_seeds: torrent.num_seeds,
          num_leechs: torrent.num_leechs,
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Error fetching franchise torrent statuses:", error);
      res.status(500).json({ error: error.message });
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
      const matches: Array<{ request_id: number; request_title: string; torrent_name: string; torrent_hash: string; episodes: string }> = [];
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
          const parsed = parseTorrentName(match.name);
          const episodeStr = parsed.season !== null ? (parsed.episodes.length > 0 ? formatEpisodes(parsed) : `S${String(parsed.season).padStart(2, "0")}`) : '';

          // Dedup: check if this torrent hash already exists for this request
          const existingHash = db.prepare(
            "SELECT 1 FROM release_candidates WHERE torrent_hash = ? AND request_id = ?"
          ).get(match.hash, orphan.id);
          if (existingHash) {
            console.log(`[Detect] Skipping duplicate torrent hash for ${orphan.title}: ${match.hash}`);
            continue;
          }

          const rcResult = db.prepare(
            "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, torrent_hash, save_path, parsed_episodes) " +
            "VALUES (?, ?, ?, 'manual', ?, 'Unknown', ?, ?, ?)"
          ).run(orphan.id, `manual-${match.hash.slice(0, 12)}`, match.name, sizeMb, match.hash, match.save_path, episodeStr);

          db.prepare(
            "INSERT INTO approval_history (request_id, release_id) VALUES (?, ?)"
          ).run(orphan.id, rcResult.lastInsertRowid);

          db.prepare(
            "UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(orphan.id);

          detected++;
          matches.push({ request_id: orphan.id, request_title: orphan.title, torrent_name: match.name, torrent_hash: match.hash,           episodes: episodeStr || '' });
          console.log(`[Detect] Linked torrent for ${orphan.title} → ${match.name}${episodeStr ? ` (${episodeStr})` : ''}`);
        }
      }

      res.json({ success: true, detected, total: orphans.length, matches });
    } catch (error) {
      console.error("Error detecting torrents:", error);
      res.status(500).json({ error: "Failed to detect torrents" });
    }
  });

  // POST /api/requests/scan-downloads - Scan all qBittorrent torrents, import into Radarr/Sonarr + DB
  router.post("/scan-downloads", async (req: Request, res: Response) => {
    try {
      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {
        return res.status(500).json({ error: "qBittorrent unavailable" });
      }

      const existingHashes = new Set(
        db.prepare("SELECT torrent_hash FROM release_candidates WHERE torrent_hash != ''")
          .all().map((r: any) => r.torrent_hash)
      );

      let newTorrents = allTorrents.filter((t: any) => !existingHashes.has(t.hash));

      if (newTorrents.length === 0) {
        const qbitHashes = new Set(allTorrents.map((t: any) => t.hash));
        const orphaned = db.prepare(
          "SELECT rc.id, rc.request_id, rc.torrent_hash FROM release_candidates rc " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL " +
          "AND NOT EXISTS (SELECT 1 FROM approval_history ah WHERE ah.release_id = rc.id AND ah.request_id = rc.request_id)"
        ).all() as any[];
        let backfilled = 0;
        for (const orph of orphaned) {
          if (!qbitHashes.has(orph.torrent_hash)) continue;
          db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(orph.id, orph.request_id);
          backfilled++;
        }
        // Remove approval_history for RCs whose torrent is no longer in qBittorrent
        const allApprovedRcs = db.prepare(
          "SELECT DISTINCT ah.release_id, rc.torrent_hash FROM approval_history ah " +
          "JOIN release_candidates rc ON rc.id = ah.release_id " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
        ).all() as any[];
        const toRemove = allApprovedRcs.filter((r: any) => !qbitHashes.has(r.torrent_hash));
        if (toRemove.length > 0) {
          const removeIds = toRemove.map((r: any) => r.release_id);
          db.prepare(`DELETE FROM approval_history WHERE release_id IN (${removeIds.map(() => "?").join(",")})`).run(...removeIds);
          console.log(`[ScanDownloads] Removed ${toRemove.length} stale approval(s) for RCs not in qBittorrent`);
        }
        // Fix season mismatches: RCs attached to wrong-season requests
        const allRcWithReq = db.prepare(
          "SELECT rc.id as rc_id, rc.request_id, rc.torrent_hash, rc.title as rc_title, mr.season as req_season, mr.sonarr_id, mr.type " +
          "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL AND mr.type = 'series'"
        ).all() as any[];
        let seasonFixed = 0;
        for (const rc of allRcWithReq) {
          if (!qbitHashes.has(rc.torrent_hash)) continue;
          const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
          if (!torrent) continue;
          const parsed = parseTorrentName(torrent.name);
          const torrentSeason = parsed.season || 1;
          if (rc.req_season != null && torrentSeason !== rc.req_season) {
            db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.rc_id);
            db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.rc_id);
            console.log(`[ScanDownloads] Season mismatch: RC ${rc.rc_id} (S${rc.req_season}) <- torrent S${torrentSeason} "${torrent.name.slice(0, 60)}"`);
            seasonFixed++;
          }
        }
        // Sync request statuses — any request with approved RCs in qBittorrent should be DOWNLOADING/SEEDING
        let staleFixed = 0;
        const staleStatus = db.prepare(
          "SELECT DISTINCT mr.id, mr.status FROM media_requests mr " +
          "JOIN approval_history ah ON ah.request_id = mr.id " +
          "JOIN release_candidates rc ON rc.id = ah.release_id AND rc.request_id = mr.id " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL " +
          "AND mr.status NOT IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')"
        ).all() as any[];
        for (const row of staleStatus) {
          const rcHashes = db.prepare(
            "SELECT rc.torrent_hash FROM release_candidates rc " +
            "JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = rc.request_id " +
            "WHERE rc.request_id = ? AND rc.torrent_hash != ''"
          ).all(row.id) as any[];
          const hasInQbit = rcHashes.some((r: any) => qbitHashes.has(r.torrent_hash));
          if (hasInQbit) {
            db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
            console.log(`[ScanDownloads] Fixed status: request ${row.id} ${row.status} -> DOWNLOADING`);
            staleFixed++;
          }
        }
        if (backfilled > 0) console.log(`[ScanDownloads] Backfilled ${backfilled} orphaned RC(s) with approval_history`);
        if (seasonFixed > 0) console.log(`[ScanDownloads] Removed ${seasonFixed} season-mismatched RC(s) — re-importing...`);

        // If season mismatches were cleaned, don't return — fall through to import the freed torrents
        if (seasonFixed === 0) {
          return res.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, total: allTorrents.length, results: [], backfilled, staleRemoved: toRemove.length, statusFixed: staleFixed, seasonFixed });
        }
        // Season mismatches cleaned — recompute which torrents need importing
        const freshHashes = new Set(
          db.prepare("SELECT torrent_hash FROM release_candidates WHERE torrent_hash != ''")
            .all().map((r: any) => r.torrent_hash)
        );
        newTorrents = allTorrents.filter((t: any) => !freshHashes.has(t.hash));
      }

      if (newTorrents.length === 0) {
        return res.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, total: allTorrents.length, results: [] });
      }

      const results: Array<{ title: string; status: string; type?: string; request_id?: number; error?: string }> = [];

      let radarrProfiles: any[] = [];
      let radarrRootFolders: any[] = [];
      let sonarrProfiles: any[] = [];
      let sonarrRootFolders: any[] = [];

      try { radarrProfiles = await radarr.getQualityProfiles(); } catch {}
      try { radarrRootFolders = await radarr.getRootFolders(); } catch {}
      try { sonarrProfiles = await sonarr.getQualityProfiles(); } catch {}
      try { sonarrRootFolders = await sonarr.getRootFolders(); } catch {}

      const radarrProfileId = radarrProfiles[0]?.id;
      const radarrRootPath = radarrRootFolders[0]?.path;
      const sonarrProfileId = sonarrProfiles[0]?.id;
      const sonarrRootPath = sonarrRootFolders[0]?.path;

      // Pre-fetch all existing media to avoid duplicate imports within the same batch
      const allRadarrMovies = await radarr.getAllMovies().catch((e) => { console.error(`[ScanDownloads] getAllMovies failed: ${e.message}`); return [] as any[]; });
      const allSonarrSeries = await sonarr.getAllSeries().catch((e) => { console.error(`[ScanDownloads] getAllSeries failed: ${e.message}`); return [] as any[]; });

      console.log(`[ScanDownloads] Fetched ${allRadarrMovies.length} Radarr movies, ${allSonarrSeries.length} Sonarr series`);

      // Build lookup maps by normalized title
      const existingRadarrByTitle = new Map<string, any>();
      for (const m of allRadarrMovies) {
        existingRadarrByTitle.set(m.title.toLowerCase(), m);
      }
      const existingSonarrByTitle = new Map<string, any>();
      for (const s of allSonarrSeries) {
        existingSonarrByTitle.set(s.title.toLowerCase(), s);
      }

      for (const torrent of newTorrents) {
        const parsed = parseTorrentName(torrent.name);
        const savePath = (torrent.save_path || "").toLowerCase();

        let type: "movie" | "series" = "movie";
        if (parsed.season !== null || /\bS\d{1,2}\b/.test(torrent.name) || /season/i.test(torrent.name)) {
          type = "series";
        } else if (/serial|season|episode|ep\d/i.test(torrent.name)) {
          type = "series";
        } else if (savePath.includes("serial") || savePath.includes("series") || savePath.includes("tv")) {
          type = "series";
        } else if (savePath.includes("film") || savePath.includes("movie")) {
          type = "movie";
        }

        const titleClean = torrent.name
          .replace(/\bS\d{1,2}(?:E\d{1,3}(?:[-–]\d{1,3})?)?\b/gi, "")
          .replace(/\bSeason\s*\d+\b/gi, "")
          .replace(/\b(?:1080p|2160p|720p|480p|BluRay|WEB-?DL|WEB-?RIP|HDRip|DVDRip|REMUX|x264|x265|HEVC|AAC|FLAC|DTS|AC3|\.mkv|\.mp4|\.avi)\b/gi, "")
          .replace(/[\[\]()]/g, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const lookupTitle = torrent.name
          .replace(/\bS\d{1,2}(?:E\d{1,3}(?:[-–]\d{1,3})?)?\b/gi, "")
          .replace(/\bSeason\s*\d+\b/gi, "")
          .replace(/\b(?:1080p|2160p|720p|480p|BluRay|WEB-?DL|WEB-?RIP|HDRip|DVDRip|REMUX|x264|x265|HEVC|AAC|FLAC|DTS|AC3|DDP?\.?5\.?1|ATMOS|EAC3|DOLBY|DUBBED|DUBBING|DUB|MULTI|NF|HDR10\+?|DV|10bit|H\.?26[45]|AV1|60fps|23\.976|25fps|DDP|DD)\b/gi, "")
          .replace(/\[.*?\]/g, " ")
          .replace(/[-–/\\]+/g, " ")
          .replace(/[._]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        try {
          const season = parsed.season || 1;
          const epStr = parsed.season !== null ? (parsed.episodes.length > 0 ? formatEpisodes(parsed) : `S${String(parsed.season).padStart(2, "0")}`) : '';
          const tNorm = normalizeTitleForMatch(titleClean);

          // Step 1: Try to match against existing Radarr/Sonarr entries
          let matchedRadarr: any = null;
          let matchedSonarr: any = null;

          if (type === "movie") {
            matchedRadarr = [...existingRadarrByTitle.values()].find((m: any) => {
              const mNorm = normalizeTitleForMatch(m.title);
              return titlesMatch(mNorm, tNorm);
            });
          } else if (type === "series") {
            matchedSonarr = [...existingSonarrByTitle.values()].find((s: any) => {
              const sNorm = normalizeTitleForMatch(s.title);
              return titlesMatch(sNorm, tNorm);
            });
          }

          // Step 2: If no local match, use Sonarr/Radarr lookup — try all results until one validates
          let radarrId: number | null = null;
          let sonarrId: number | null = null;
          let matchedTitle = "";

          if (type === "movie" && !matchedRadarr && radarrProfileId) {
            try {
              const lookup = await radarr.lookupMovie(lookupTitle);
              for (const found of lookup) {
                const foundNorm = normalizeTitleForMatch(found.title);
                if (titlesMatch(foundNorm, tNorm)) {
                  try {
                    const added = await radarr.addMovie({
                      ...found,
                      qualityProfileId: radarrProfileId,
                      rootFolderPath: radarrRootPath,
                      monitored: true,
                      addOptions: { searchForMovie: false },
                    });
                    radarrId = added.id;
                    matchedTitle = found.title;
                    existingRadarrByTitle.set(found.title.toLowerCase(), { id: added.id, title: found.title });
                    console.log(`[ScanDownloads] Created Radarr: ${found.title} (radarr_id=${added.id})`);
                  } catch (addErr: any) {
                    console.error(`[ScanDownloads] Radarr addMovie failed for "${found.title}": ${addErr.message}`);
                  }
                  break;
                }
              }
              if (!radarrId) {
                const topTitles = lookup.slice(0, 3).map((f: any) => `${f.title} [${normalizeTitleForMatch(f.title)}]`).join(", ");
                console.log(`[ScanDownloads] No valid Radarr match for "${lookupTitle}" (tNorm="${tNorm}") (${lookup.length} results: ${topTitles})`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] Radarr lookup failed for "${lookupTitle}": ${err.message}`);
            }
          } else if (type === "series" && !matchedSonarr && sonarrProfileId) {
            try {
              const lookup = await sonarr.lookupSeries(lookupTitle);
              for (const found of lookup) {
                const foundNorm = normalizeTitleForMatch(found.title);
                if (titlesMatch(foundNorm, tNorm)) {
                  try {
                    const added = await sonarr.addSeries({
                      ...found,
                      qualityProfileId: sonarrProfileId,
                      path: sonarrRootPath ? `${sonarrRootPath}/${found.title}` : found.path,
                      monitored: true,
                      seasonFolder: true,
                      addOptions: { searchForMissingEpisodes: false },
                      seasons: (found.seasons || []).map((s: any) => ({ ...s, monitored: true })),
                    });
                    sonarrId = added.id;
                    matchedTitle = found.title;
                    existingSonarrByTitle.set(found.title.toLowerCase(), { id: added.id, title: found.title });
                    console.log(`[ScanDownloads] Created Sonarr: ${found.title} (sonarr_id=${added.id})`);
                  } catch (addErr: any) {
                    console.error(`[ScanDownloads] Sonarr addSeries failed for "${found.title}": ${addErr.message}`);
                  }
                  break;
                }
              }
              if (!sonarrId) {
                const topTitles = lookup.slice(0, 5).map((f: any) => `${f.title} [${normalizeTitleForMatch(f.title)}]`).join(", ");
                console.log(`[ScanDownloads] No valid Sonarr match for "${lookupTitle}" (tNorm="${tNorm}") (${lookup.length} results: ${topTitles})`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] Sonarr lookup failed for "${lookupTitle}": ${err.message}`);
            }
          }

          // Step 3: Create request + RC using matched entry
          if (type === "movie" && (matchedRadarr || radarrId)) {
            const finalRadarrId = matchedRadarr?.id || radarrId!;
            const title = matchedRadarr?.title || matchedTitle;
            const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ?").get(finalRadarrId) as any;
            if (!existingReq) {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, 'DOWNLOADING', '[]')"
              ).run(title, finalRadarrId);
              const requestId = result.lastInsertRowid as number;
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
              ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, torrent.save_path, parseQualityFromName(torrent.name));
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
              results.push({ title, status: "imported", type: "movie", request_id: Number(requestId) });
              console.log(`[ScanDownloads] Movie: ${title} (radarr_id=${finalRadarrId})`);
            } else {
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, torrent.save_path, parseQualityFromName(torrent.name));
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                console.log(`[ScanDownloads] Added RC for movie: ${title} (hash=${torrent.hash.slice(0, 12)})`);
              } else {
                const hasApproval = db.prepare("SELECT 1 FROM approval_history WHERE release_id = ? AND request_id = ?").get(existingRc.id, existingReq.id);
                if (!hasApproval) {
                  db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(existingRc.id, existingReq.id);
                  console.log(`[ScanDownloads] Backfilled approval for RC ${existingRc.id} (movie: ${title})`);
                }
              }
              results.push({ title, status: "skipped", type: "movie", error: "Already imported" });
            }
          } else if (type === "series" && (matchedSonarr || sonarrId)) {
            const finalSonarrId = matchedSonarr?.id || sonarrId!;
            const title = matchedSonarr?.title || matchedTitle;
            const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(finalSonarrId, season) as any;
            if (!existingReq) {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, sonarr_id, status, season, requested_by) VALUES (?, 'series', ?, 'DOWNLOADING', ?, '[]')"
              ).run(title, finalSonarrId, season);
              const requestId = result.lastInsertRowid as number;
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
              ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, torrent.save_path, parseQualityFromName(torrent.name), epStr);
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
              results.push({ title, status: "imported", type: "series", request_id: Number(requestId) });
              console.log(`[ScanDownloads] Series: ${title} (sonarr_id=${finalSonarrId}, S${String(season).padStart(2, "0")})`);
            } else {
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, torrent.save_path, parseQualityFromName(torrent.name), epStr);
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                console.log(`[ScanDownloads] Added RC for series: ${title} (hash=${torrent.hash.slice(0, 12)})`);
              } else {
                const hasApproval = db.prepare("SELECT 1 FROM approval_history WHERE release_id = ? AND request_id = ?").get(existingRc.id, existingReq.id);
                if (!hasApproval) {
                  db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(existingRc.id, existingReq.id);
                  console.log(`[ScanDownloads] Backfilled approval for RC ${existingRc.id} (series: ${title})`);
                }
              }
              results.push({ title, status: "skipped", type: "series", error: "Already imported" });
            }
          } else {
            results.push({ title: torrent.name, status: "no_match", type });
          }
        } catch (err: any) {
          console.error(`[ScanDownloads] Error processing ${torrent.name}:`, err.message);
          results.push({ title: torrent.name, status: "error", error: err.message });
        }
      }

      const imported = results.filter((r) => r.status === "imported").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const noMatch = results.filter((r) => r.status === "no_match").length;
      const errors = results.filter((r) => r.status === "error").length;
      console.log(`[ScanDownloads] Done: ${imported} imported, ${skipped} skipped, ${noMatch} no match, ${errors} errors (${allTorrents.length} total)`);

      res.json({ success: true, imported, skipped, noMatch, errors, total: allTorrents.length, results });
    } catch (error: any) {
      console.error("Error scanning downloads:", error);
      res.status(500).json({ error: `Failed to scan downloads: ${error.message}` });
    }
  });

  // POST /api/requests/managed/:sonarrId/search-all - Search all seasons in parallel (SSE)
  router.post("/managed/:sonarrId/search-all", async (req: Request, res: Response) => {
    const sonarrId = Number(req.params.sonarrId);
    const forceAll = !!req.body?.force;
    const SKIP_MINUTES = 5;
    const cutoff = new Date(Date.now() - SKIP_MINUTES * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    const allSeasons = db.prepare(
      "SELECT id, season, title, type, last_searched_at FROM media_requests WHERE sonarr_id = ? AND type = 'series' ORDER BY season"
    ).all(sonarrId) as any[];

    if (allSeasons.length === 0) {
      return res.status(404).json({ error: "No seasons found for this franchise" });
    }

    const seasons = forceAll ? allSeasons : allSeasons.filter(
      (s) => !s.last_searched_at || s.last_searched_at < cutoff
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (seasons.length === 0) {
      send("done", { success: true, totalFound: 0, seasons: 0, errors: 0, skipped: allSeasons.length });
      res.end();
      return;
    }

    const getSeasonData = (seasonId: number) => {
      const row = db.prepare(`
        SELECT mr.status, mr.episode_count,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           WHERE rc2.request_id = mr.id) as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3
           WHERE rc3.request_id = mr.id) as release_count
        FROM media_requests mr WHERE mr.id = ?
      `).get(seasonId) as any;
      return row || {};
    };

    const searchOneSeason = async (season: any): Promise<{ season: number; found: number; error?: string; data?: any }> => {
      const prevStatus = db.prepare("SELECT status FROM media_requests WHERE id = ?").get(season.id) as any;
      const preserveStatus = prevStatus?.status === "DOWNLOADING" || prevStatus?.status === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
      }

      let mappedCount = 0;
      try {
        const prowlarrApiKey = process.env.PROWLARR_API_KEY;
        if (prowlarrApiKey && prowlarr) {
          const query = req.body?.searchTerm || season.title.replace(/\s+S\d+$/, "");
          const results = await Promise.race([
            prowlarr.search(query, [5000]),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), 45000)),
          ]);
          const allMapped = (results as any[]).map(mapProwlarrToRadarrResult);
          const targetSeason = season.season;
          const mapped = allMapped.filter((r: RadarrSearchResult) => {
            const title = (r.title || "").toUpperCase();
            const sMatch = title.match(/\bS(\d{1,2})(?:E\d|\b)/);
            if (sMatch) {
              return parseInt(sMatch[1], 10) === targetSeason;
            }
            return true;
          });
          mappedCount = mapped.length;

          const insertStmt = db.prepare(`
            INSERT INTO release_candidates
            (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
              title = excluded.title, indexer = excluded.indexer, size_mb = excluded.size_mb,
              radarr_quality = excluded.radarr_quality, app_score = excluded.app_score,
              seeders = excluded.seeders, leechers = excluded.leechers,
              torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END,
              info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END
          `);

          for (let i = 0; i < mapped.length; i++) {
            const r = mapped[i];
            const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
            const qualityName = r.quality?.quality?.name || "Unknown";
            const cfNames = r.customFormats?.map((f: any) => f.name) || [];
            insertStmt.run(season.id, r.guid, r.title, r.indexer, sizeMb, qualityName, JSON.stringify(cfNames), computeAppScore(qualityName, cfNames, sizeMb, i + 1), i + 1, r.languages?.map((l: any) => l.name).join(", ") || "", r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");
          }

          if (!preserveStatus) {
            db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
          }
        } else if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        }

        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        const data = getSeasonData(season.id);
        return { season: season.season, found: mappedCount, data };
      } catch (err: any) {
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        }
        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        const data = getSeasonData(season.id);
        return { season: season.season, found: 0, error: err.message, data };
      }
    };

    const CONCURRENCY = 3;
    const results: { season: number; found: number; error?: string; data?: any }[] = [];
    let idx = 0;

    const runNext = async (): Promise<void> => {
      while (idx < seasons.length) {
        const current = idx++;
        send("progress", { step: "searching", season: seasons[current].season, message: `Searching S${String(seasons[current].season).padStart(2, "0")}...` });
        const result = await searchOneSeason(seasons[current]);
        results.push(result);
        const label = result.error ? `error: ${result.error}` : `${result.found} releases`;
        send("found", {
          season: result.season,
          message: `S${String(result.season).padStart(2, "0")}: ${label}`,
          found: result.found,
          ...result.data,
        });
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, seasons.length) }, () => runNext());
    await Promise.all(workers);

    const totalFound = results.reduce((sum, r) => sum + r.found, 0);
    const totalErrors = results.filter(r => r.error).length;
    send("done", { success: true, totalFound, seasons: results.length, errors: totalErrors, skipped: allSeasons.length - seasons.length });
    console.log(`[SearchAll] sonarrId=${sonarrId}: ${totalFound} releases across ${results.length} seasons (${totalErrors} errors, ${allSeasons.length - seasons.length} skipped)`);
    res.end();
  });

  // POST /api/requests/managed/search-all-movies - Search all wanted movies in parallel (SSE)
  router.post("/managed/search-all-movies", async (req: Request, res: Response) => {
    const SKIP_MINUTES = 5;
    const cutoff = new Date(Date.now() - SKIP_MINUTES * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const forceAll = !!req.body?.force;

    const allMovies = db.prepare(
      "SELECT id, title, radarr_id, last_searched_at FROM media_requests WHERE type = 'movie' ORDER BY title"
    ).all() as any[];

    const movies = forceAll ? allMovies : allMovies.filter(
      (m) => !m.last_searched_at || m.last_searched_at < cutoff
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (movies.length === 0) {
      send("done", { success: true, totalFound: 0, movies: 0, errors: 0, skipped: allMovies.length });
      res.end();
      return;
    }

    const getMovieData = (movieId: number) => {
      return db.prepare(`
        SELECT mr.status,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           JOIN approval_history ah2 ON ah2.release_id = rc2.id
           WHERE ah2.request_id = mr.id AND rc2.torrent_hash != '') as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3
           JOIN approval_history ah3 ON ah3.release_id = rc3.id
           WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '') as release_count
        FROM media_requests mr WHERE mr.id = ?
      `).get(movieId) as any || {};
    };

    const searchOneMovie = async (movie: any): Promise<{ id: number; title: string; found: number; error?: string; data?: any }> => {
      const prevStatus = db.prepare("SELECT status FROM media_requests WHERE id = ?").get(movie.id) as any;
      const preserveStatus = prevStatus?.status === "DOWNLOADING" || prevStatus?.status === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
      }

      let mappedCount = 0;
      try {
        const prowlarrApiKey = process.env.PROWLARR_API_KEY;
        if (prowlarrApiKey && prowlarr) {
          const query = req.body?.searchTerm || movie.title;
          const results = await Promise.race([
            prowlarr.search(query, [2000]),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), 45000)),
          ]);
          const mapped = (results as any[]).map(mapProwlarrToRadarrResult);
          mappedCount = mapped.length;

          const insertStmt = db.prepare(`
            INSERT INTO release_candidates
            (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
              title = excluded.title, indexer = excluded.indexer, size_mb = excluded.size_mb,
              radarr_quality = excluded.radarr_quality, app_score = excluded.app_score,
              seeders = excluded.seeders, leechers = excluded.leechers,
              torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END,
              info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END
          `);

          for (let i = 0; i < mapped.length; i++) {
            const r = mapped[i];
            const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
            const qualityName = r.quality?.quality?.name || "Unknown";
            const cfNames = r.customFormats?.map((f: any) => f.name) || [];
            insertStmt.run(movie.id, r.guid, r.title, r.indexer, sizeMb, qualityName, JSON.stringify(cfNames), computeAppScore(qualityName, cfNames, sizeMb, i + 1), i + 1, r.languages?.map((l: any) => l.name).join(", ") || "", r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");
          }

          if (!preserveStatus) {
            db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
          }
        } else if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        }

        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        const data = getMovieData(movie.id);
        return { id: movie.id, title: movie.title, found: mappedCount, data };
      } catch (err: any) {
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        }
        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        const data = getMovieData(movie.id);
        return { id: movie.id, title: movie.title, found: 0, error: err.message, data };
      }
    };

    const CONCURRENCY = 3;
    const results: { id: number; title: string; found: number; error?: string; data?: any }[] = [];
    let idx = 0;

    const runNext = async (): Promise<void> => {
      while (idx < movies.length) {
        const current = idx++;
        send("progress", { step: "searching", title: movies[current].title, message: `Searching "${movies[current].title}"...` });
        const result = await searchOneMovie(movies[current]);
        results.push(result);
        const label = result.error ? `error: ${result.error}` : `${result.found} releases`;
        send("found", { id: result.id, title: result.title, message: `"${result.title}": ${label}`, found: result.found, ...result.data });
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, movies.length) }, () => runNext());
    await Promise.all(workers);

    const totalFound = results.reduce((sum, r) => sum + r.found, 0);
    const totalErrors = results.filter(r => r.error).length;
    send("done", { success: true, totalFound, movies: results.length, errors: totalErrors, skipped: allMovies.length - movies.length });
    console.log(`[SearchAllMovies] ${totalFound} releases across ${results.length} movies (${totalErrors} errors, ${allMovies.length - movies.length} skipped)`);
    res.end();
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

  // GET /api/requests/db/:table - View raw table data for debugging
  router.get("/db/:table", (req: Request, res: Response) => {
    const table = req.params.table;
    const allowed = ["media_requests", "release_candidates", "approval_history"];
    if (!allowed.includes(table)) {
      return res.status(400).json({ error: `Invalid table. Allowed: ${allowed.join(", ")}` });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      let query = `SELECT * FROM ${table} ORDER BY id DESC LIMIT ? OFFSET ?`;
      const rows = db.prepare(query).all(limit, offset) as any[];
      const total = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      res.json({ table, columns, rows, total: total.c, limit, offset });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.json({ success: true });

      // Delete from Sonarr/Radarr
      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";
      const rUrl = process.env.RADARR_URL || "";
      const rKey = process.env.RADARR_API_KEY || "";
      if (request.sonarr_id && sUrl) {
        try { await fetch(`${sUrl}/api/v3/series/${request.sonarr_id}?deleteFiles=false`, { method: "DELETE", headers: { "X-Api-Key": sKey } }); } catch {}
      }
      if (request.radarr_id && rUrl) {
        try { await fetch(`${rUrl}/api/v3/movie/${request.radarr_id}?deleteFiles=false`, { method: "DELETE", headers: { "X-Api-Key": rKey } }); } catch {}
      }

      db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
      console.log(`[Delete] Deleted request #${id}: ${request.title} (sonarr=${request.sonarr_id}, radarr=${request.radarr_id})`);
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
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
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

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (!releaseId && ["DOWNLOADING", "SEEDING", "COMPLETED"].includes(request.status)) {
        return res.status(400).json({ error: "Cannot dismiss request with active downloads. Remove files first." });
      }

      if (releaseId) {
        // Delete a single approved release's torrent
        const release = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?"
        ).get(releaseId) as any;

        if (release?.torrent_hash) {
          try {
            await qbittorrent.deleteTorrent(release.torrent_hash, false);
            console.log(`[Dismiss] Removed torrent ${release.torrent_hash}`);
          } catch (err: any) {
            console.error(`[Dismiss] Failed to delete torrent:`, err.message);
          }
        }

        // Remove the approval_history for this release
        db.prepare("DELETE FROM approval_history WHERE release_id = ? AND request_id = ?").run(releaseId, id);

        // If no more approved releases with torrents, set status back to NEW (don't auto-delete)
        const remaining = db.prepare(
          "SELECT rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(id) as any;
        if (!remaining) {
          db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          console.log(`[Dismiss] Removed release from request #${id}, no active torrents left — set to NEW`);
        }
      } else {
        // Delete entire request: delete all torrents, unmonitor, then remove from DB

        const releases = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(id) as any[];
        for (const release of releases) {
          if (release.torrent_hash) {
            try {
              await qbittorrent.deleteTorrent(release.torrent_hash, false);
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

  // POST /api/requests/:id/move-to-processed - Hardlink files from download folder to processed staging
  router.post("/:id/move-to-processed", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const release = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) {
        if (contentPath.startsWith("/Torrents/")) contentPath = "/media" + contentPath;
      }
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      const type = request.type === "series" ? "series" : "movie";
      const result = moveToProcessedSync(contentPath, type);
      if (!result.success) return res.status(500).json({ error: result.error });

      console.log(`[MoveToProcessed] ${contentPath} → ${result.destination}`);
      res.json({ success: true, source: contentPath, destination: result.destination });
    } catch (error: any) {
      console.error("Error moving to processed:", error);
      res.status(500).json({ error: `Failed to move to processed: ${error.message}` });
    }
  });

  // POST /api/requests/:id/move-to-library - Hardlink files from processed folder to library
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

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const baseName = path.basename(contentPath);
      const processedPath = path.join(processedDir, baseName);

      if (!fs.existsSync(processedPath)) {
        moveToProcessedSync(contentPath, type);
      }

      let sourcePath = processedPath;
      if (!fs.existsSync(sourcePath)) {
        sourcePath = contentPath;
      }

      let destFolder = "";

      if (request.type === "series" && request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          destFolder = path.join(
            series.path || path.join(process.env.MEDIA_TV || "/media/serialy", series.title),
            `S${String(seasonNum).padStart(2, "0")}`
          );
        } catch {
          return res.status(500).json({ error: "Could not determine series folder from Sonarr" });
        }
      } else if (request.radarr_id) {
        const movie = await radarr.getMovie(request.radarr_id);
        destFolder = movie.path || movie.folderPath;
        if (!destFolder) {
          return res.status(500).json({ error: "Could not determine movie folder from Radarr" });
        }
      } else {
        return res.status(400).json({ error: "No Radarr or Sonarr ID associated" });
      }

      const fileName = path.basename(sourcePath);
      const destPath = path.join(destFolder, fileName);

      if (fs.existsSync(destPath)) {
        return res.json({ success: true, message: "File already exists in library", source: sourcePath, destination: destPath, alreadyExists: true });
      }

      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        hardlinkDirRecursive(sourcePath, path.join(destFolder, path.basename(sourcePath)));
      } else {
        fs.mkdirSync(destFolder, { recursive: true });
        try {
          fs.linkSync(sourcePath, destPath);
        } catch (linkErr: any) {
          if (linkErr.code === "EXDEV") {
            console.warn(`[MoveToLibrary] Cross-device link, falling back to copy`);
            fs.copyFileSync(sourcePath, destPath);
          } else {
            throw linkErr;
          }
        }
      }

      const method = fs.statSync(destPath).nlink > 1 ? "hardlinked" : "copied";
      console.log(`[MoveToLibrary] ${method} ${sourcePath} → ${destPath}`);

      res.json({ success: true, message: `Files ${method} to library`, source: sourcePath, destination: destPath });
    } catch (error: any) {
      console.error("Error moving to library:", error);
      res.status(500).json({ error: `Failed to move to library: ${error.message}` });
    }
  });

  // POST /api/requests/:id/process - Process downloaded files through workspace to processed folder
  router.post("/:id/process", async (req: Request, res: Response) => {
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

      const type = request.type === "series" ? "series" : "movie";
      const destFolder = getProcessedDir(type);

      const options: ProcessOptions = {
        stripAudioTracks: req.body?.stripAudioTracks,
        keepAudioTracks: req.body?.keepAudioTracks,
        removeSubtitles: req.body?.removeSubtitles,
        audioCodec: req.body?.audioCodec,
      };

      const result = await processToLibrary(contentPath, destFolder, options, request.id, request.title);

      if (result.success) {
        console.log(`[Process] ${result.method} ${result.sourceFiles.length} file(s) → ${destFolder}`);
      }

      res.json({
        success: result.success,
        method: result.method,
        sourceFiles: result.sourceFiles,
        outputFiles: result.outputFiles,
        workspaceDir: `${request.id}-${request.title}`,
        error: result.error,
      });
    } catch (error: any) {
      console.error("Error processing files:", error);
      res.status(500).json({ error: `Failed to process files: ${error.message}` });
    }
  });

  // POST /api/requests/:id/search - Re-search for releases (SSE progress)
  router.post("/:id/search", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const { id } = req.params;
    const { searchTerm } = req.body || {};
    const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      db.prepare("DELETE FROM release_candidates WHERE request_id = ? AND id NOT IN (SELECT release_id FROM approval_history WHERE request_id = ?)").run(id, id);
      const prevStatus = request.status;
      const preserveStatus = prevStatus === "DOWNLOADING" || prevStatus === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }

      const service = request.type === "series" ? "Sonarr" : "Radarr";
      send("progress", { step: "searching", message: `Querying Prowlarr for releases...` });

      let releases: RadarrSearchResult[] = [];

      const searchTimeout = (p: Promise<any>, ms: number) => Promise.race([
        p,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), ms))
      ]);

      const prowlarrApiKey = process.env.PROWLARR_API_KEY;
      const useProwlarr = !!prowlarrApiKey;

      try {
        if (useProwlarr) {
          const rawQuery = searchTerm || request.title;
          const episodePrefix = rawQuery.trim().match(/^(S\d{1,2}E\d{1,3}(?:E\d{1,3})*)\s*(.*)/i);
          let query: string;
          if (episodePrefix) {
            const baseTitle = request.title.replace(/\s+S\d{1,2}$/i, "").trim();
            const episodeName = episodePrefix[2] || "";
            query = `${baseTitle} ${episodePrefix[1]}${episodeName ? " " + episodeName : ""}`.trim();
          } else {
            query = rawQuery;
          }
          const categories = request.type === "movie" ? [2000] : [5000];
          send("progress", { step: "searching", message: `Searching Prowlarr: "${query}"...` });
          const prowlarrResults = await searchTimeout(prowlarr.search(query, categories), 45000);
          releases = prowlarrResults.map(mapProwlarrToRadarrResult);
          console.log(`[Search] Prowlarr returned ${releases.length} results for "${query}"`);
        } else {
          send("progress", { step: "searching", message: `Querying ${service} for releases...` });
          if (request.type === "series" && request.sonarr_id != null && request.season != null) {
            releases = await searchTimeout(sonarr.searchReleases(request.sonarr_id, request.season, searchTerm || undefined), 60000);
          } else if (request.radarr_id) {
            releases = await searchTimeout(radarr.searchReleases(request.radarr_id, searchTerm || undefined), 60000);
          } else {
            send("error", { error: "No Radarr or Sonarr ID associated with this request" });
            res.end();
            return;
          }
        }
      } catch (searchErr) {
        console.error(`[Search] ${request.title} timed out or failed:`, (searchErr as Error).message);
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        }
        send("error", { error: "Search timed out or failed" });
        res.end();
        return;
      }

      send("progress", { step: "found", message: `Found ${releases.length} release(s), scoring...`, total: releases.length });

      const insertStmt = db.prepare(`
        INSERT INTO release_candidates
        (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          radarr_indexer_id = CASE WHEN excluded.radarr_indexer_id != 0 THEN excluded.radarr_indexer_id ELSE release_candidates.radarr_indexer_id END,
          torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END
      `);

      for (let i = 0; i < releases.length; i++) {
        const r = releases[i];
        const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
        const qualityName = r.quality?.quality?.name || "Unknown";
        const cfNames = r.customFormats?.map((f: any) => f.name) || [];
        const customFormats = JSON.stringify(cfNames);
        const appScore = computeAppScore(qualityName, cfNames, sizeMb, i + 1);
        const language = r.languages?.map((l: any) => l.name).join(", ") || r.language?.name || "";

        insertStmt.run(id, r.guid, r.title, r.indexer, sizeMb, qualityName, customFormats, appScore, i + 1, language, r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");

        if ((i + 1) % 10 === 0 || i === releases.length - 1) {
          send("progress", { step: "indexing", message: `Indexed ${i + 1}/${releases.length}`, current: i + 1, total: releases.length });
        }
      }

      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }

      send("done", { success: true, releasesFound: releases.length });
      console.log(`[Search] ${request.title}: done (${releases.length} releases, ${Date.now() - startTime}ms)`);
      res.end();
    } catch (error) {
      console.error("Error searching releases:", error);
      send("error", { error: "Failed to search releases" });
      res.end();
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

      const hasProwlarrHash = release.torrent_hash && release.torrent_hash.length === 40;

      if (hasProwlarrHash) {
        const magnetUrl = release.info_url?.includes("magnet") ? release.info_url : "";
        if (magnetUrl) {
          try {
            const savePath = request.type === "movie"
              ? process.env.MEDIA_MOVIES || "/media/filmy"
              : process.env.MEDIA_TV || "/media/serialy";
            await qbittorrent.addTorrent(magnetUrl, savePath);
            console.log(`[Grab] Added torrent via magnet for ${request.title}: ${release.title}`);
          } catch (grabErr: any) {
            console.error(`[Grab] Failed to add torrent for ${request.title}:`, grabErr.message);
            return res.status(500).json({ error: "Failed to add torrent to qBittorrent", details: String(grabErr) });
          }
        } else {
          console.log(`[Grab] Prowlarr release has infoHash=${release.torrent_hash} but no magnet URL — torrent must be added manually`);
        }
      } else if (request.radarr_id && release.radarr_release_id) {
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

  // POST /api/requests/:id/set-status - Manually fix stuck request status
  router.post("/:id/set-status", (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    const valid = ["NEW", "SEARCHING", "AWAITING_APPROVAL", "APPROVED", "DOWNLOADING", "SEEDING", "COMPLETED", "REJECTED", "DISMISSED"];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(", ")}` });
    }
    const request = db.prepare("SELECT id FROM media_requests WHERE id = ?").get(id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
    res.json({ success: true, status });
  });

  return router;
}
