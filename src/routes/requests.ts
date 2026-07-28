import { Router, Request, Response } from "express";
import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { SonarrService } from "../services/sonarr";
import { QBittorrentService } from "../services/qbittorrent";
import { ProwlarrService, ProwlarrRelease } from "../services/prowlarr";
import { RadarrSearchResult } from "../types/index";
import { computeAppScore } from "../services/scoring";
import { parseTorrentName, formatEpisodes, parseQualityFromName } from "../utils/torrentParser";
import { processToLibrary, processFile, ProcessOptions, moveToProcessedSync, moveToLibrarySync, moveToWorkspaceSync, getProcessedDir, listWorkspaces, writeWorkspaceMetadata, readWorkspaceMetadata, completeWorkspace, deleteWorkspaceInputs, deleteWorkspaceFile, deleteWorkspace } from "../services/processor";
import fs from "fs";
import path from "path";

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20 };

function parseSeasonNumber(dirName: string): number | null {
  // Specials, Season 00, etc.
  if (/^specials$/i.test(dirName)) return 0;
  // S01, S02, etc.
  let m = dirName.match(/\bS(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  // Season 1, Season 01, etc.
  m = dirName.match(/\bSeason\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  // Sezon 1, Sezon I, Sezon II, etc.
  m = dirName.match(/\bSezon\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  m = dirName.match(/\bSezon\s+([IVXLCDM]+)\b/i);
  if (m) return ROMAN[m[1].toUpperCase()] || null;
  return null;
}

function toQBittorrentPath(hostPath: string): string {
  // Strip /media prefix — volume maps /media/Torrents → /Torrents
  if (hostPath.startsWith("/media/")) return hostPath.slice("/media".length);
  return hostPath;
}

function fromQBittorrentPath(qbitPath: string): string {
  if (qbitPath.startsWith("/Torrents/")) return "/media" + qbitPath;
  return qbitPath;
}

function normalizeTitleForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[:']/g, " ")
    .replace(/[.\-_\[\](){}!@#$%^+=|;<>?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSeasonPackTitle(title: string, season: number): boolean {
  const seasonPattern = new RegExp(`\\bS${String(season).padStart(2, "0")}\\b`, "i");
  return seasonPattern.test(title) && !/\bE\d{1,3}\b/i.test(title);
}

function extractEpisodeFromFilename(filePath: string): number | null {
  const m = filePath.match(/[Ee](\d{1,3})/);
  if (m) return parseInt(m[1], 10);
  const base = filePath.split(/[/\\]/).pop() || filePath;
  const lead = base.match(/^(\d{1,3})\s/);
  if (lead) return parseInt(lead[1], 10);
  const ep = base.match(/[Ee]pisode\s*(\d{1,3})/);
  if (ep) return parseInt(ep[1], 10);
  return null;
}

function titlesMatch(lookupNorm: string, torrentNorm: string): boolean {
  // Primary: prefix match — but reject when suffix is a bare 1-3 digit number (sequel like "2", "3")
  if (torrentNorm.startsWith(lookupNorm)) {
    const suffix = torrentNorm.slice(lookupNorm.length).trimStart();
    if (!suffix || !/^\d{1,3}\b/.test(suffix)) return true;
  }
  if (lookupNorm.startsWith(torrentNorm)) {
    const suffix = lookupNorm.slice(torrentNorm.length).trimStart();
    if (!suffix || !/^\d{1,3}\b/.test(suffix)) return true;
  }
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
    // Allow 1 missing word for 3+ word titles (handles "LEGO" prefix differences, episode titles appended, etc.)
    const tolerance = shorterWords.length >= 3 ? 1 : 0;
    if (matched.length >= shorterWords.length - tolerance) return true;
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

  if (titleLower.includes("2160p") || titleLower.includes("4k") || titleLower.includes("uhd")) resolution = "2160p";
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

function getContentVideoInodes(contentPath: string): { inodes: Set<number>; names: Set<string> } {
  const inodes = new Set<number>();
  const names = new Set<string>();
  if (!fs.existsSync(contentPath)) return { inodes, names };
  const stat = fs.statSync(contentPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(contentPath)) {
      if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
      const fullPath = path.join(contentPath, entry);
      try { const st = fs.statSync(fullPath); inodes.add(st.ino); names.add(entry); } catch {}
    }
  } else {
    inodes.add(stat.ino);
    names.add(path.basename(contentPath));
  }
  return { inodes, names };
}

export function createRequestRoutes(db: Database, radarr: RadarrService, sonarr: SonarrService, qbittorrent: QBittorrentService, prowlarr: ProwlarrService, deletedFranchiseIds?: Set<number>) {
  const router = Router();

  // GET /api/requests - List all pending requests
  router.get("/", (req: Request, res: Response) => {
    try {
      const stmt = db.prepare(`
        SELECT * FROM media_requests 
        WHERE status NOT IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')
        AND NOT (type = 'series' AND sonarr_id IS NOT NULL)
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

  // POST /api/requests/cleanup - Reset stale SEARCHING requests, clean up orphaned RCs, remove empty dirs
  router.post("/cleanup", (req: Request, res: Response) => {
    try {
      const stuck = db.prepare(
        `UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'SEARCHING'`
      ).run();
      const orphaned = db.prepare(
        `DELETE FROM release_candidates WHERE request_id NOT IN (SELECT id FROM media_requests)`
      ).run();
      // Remove empty dirs in processed/serialy and processed/filmy
      let emptyDirsRemoved = 0;
      const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
      const processedMovieDir = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
      for (const dir of [processedTvDir, processedMovieDir]) {
        try {
          if (!fs.existsSync(dir)) continue;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const subDir = path.join(dir, entry.name);
            try {
              if (entry.name.match(/^S0*[1-9]\d*$/i)) {
                const hasFiles = fs.readdirSync(subDir).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
                if (!hasFiles) { fs.rmSync(subDir, { recursive: true, force: true }); emptyDirsRemoved++; }
              } else {
                const hasVideoFiles = (() => {
                  for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
                    if (sub.isDirectory()) {
                      const ssub = path.join(subDir, sub.name);
                      try { if (fs.readdirSync(ssub).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f))) return true; } catch {}
                    } else if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(sub.name)) return true;
                  }
                  return false;
                })();
                if (!hasVideoFiles) { fs.rmSync(subDir, { recursive: true, force: true }); emptyDirsRemoved++; }
              }
            } catch {}
          }
        } catch {}
      }
      res.json({ reset: stuck.changes, orphanedRcs: orphaned.changes, emptyDirsRemoved });
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
      const skipped: Array<{ title: string; radarr_id?: number; sonarr_id?: number; reason: string }> = [];
      let fixed = 0;

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

      // Fetch qBittorrent torrents once for all torrent detection
      let allTorrents: any[] = [];
      try { allTorrents = await qbittorrent.getTorrents(); } catch {}

      for (const movie of radarrMovies) {
        // Fix existing entries: update NEW→COMPLETED if Radarr says hasFile
        const existing = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ?").get(movie.id) as any;
        if (existing) {
          if (movie.hasFile && existing.status === "NEW") {
            db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(existing.id);
            fixed++;
            console.log(`[Import] Fixed ${movie.title}: NEW→COMPLETED (Radarr hasFile)`);
          }
          continue;
        }
        if (existingTitles.has(movie.title.toLowerCase())) {
          skipped.push({ title: movie.title, radarr_id: movie.id, reason: "title exists in DB" });
          continue;
        }
        const status = movie.hasFile ? "COMPLETED" : "NEW";
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, ?, '[]')"
        ).run(movie.title, movie.id, status);
        const requestId = Number(result.lastInsertRowid);
        console.log(`[Import] Created movie request: ${movie.title} (radarr_id=${movie.id}, status=${status})`);

        // If hasFile=true, try to detect torrent hash from qBittorrent
        if (status === "COMPLETED" && allTorrents.length > 0) {
          const normTitle = movie.title.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
          const match = allTorrents.find((t: any) => {
            const tn = t.name.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
            return tn === normTitle || tn.startsWith(normTitle + " ") || tn.startsWith(normTitle + ".");
          });
          if (match) {
            db.prepare("UPDATE media_requests SET status = 'SEEDING' WHERE id = ?").run(requestId);
            const quality = parseQualityFromName(match.name);
            db.prepare(
              "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'import', ?, ?, ?)"
            ).run(requestId, `imported-${movie.id}`, match.name, match.hash, fromQBittorrentPath(match.save_path), quality);
            db.prepare(
              "INSERT INTO approval_history (request_id, release_id, approved_by) VALUES (?, (SELECT id FROM release_candidates WHERE request_id = ? LIMIT 1), 'system')"
            ).run(requestId, requestId);
            console.log(`[Import] Detected torrent for ${movie.title}: hash=${match.hash}, status→SEEDING`);
          }
        }

        imported.push({ title: movie.title, id: requestId });
      }

      // Import ALL series from Sonarr (not just wanted/missing)
      const allSeries = await sonarr.getAllSeries();
      const existingSonarrKeys = new Set(
        db.prepare("SELECT sonarr_id, season FROM media_requests WHERE sonarr_id IS NOT NULL")
          .all().map((r: any) => `${r.sonarr_id}-${r.season}`)
      );

      for (const s of allSeries) {
        try {
          const detail = await sonarr.getSeries(s.id);
          const seasons = detail.seasons || [];
          for (const season of seasons) {
            const seasonNum = season.seasonNumber;
            const key = `${s.id}-${seasonNum}`;
            const epFileCount = season.statistics?.episodeFileCount || 0;
            const epCount = season.statistics?.episodeCount || 0;

            // Fix existing: update status based on whether files exist
            const existing = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(s.id, seasonNum) as any;
            if (existing) {
              if (epFileCount > 0 && existing.status === "NEW") {
                db.prepare("UPDATE media_requests SET status = 'COMPLETED', episode_count = ? WHERE id = ?").run(epCount || null, existing.id);
                fixed++;
                console.log(`[Import] Fixed ${detail.title} S${String(seasonNum).padStart(2, "0")}: NEW→COMPLETED (${epFileCount}/${epCount} episodes)`);
              }
              continue;
            }

            // Create new entry
            const title = `${detail.title} S${String(seasonNum).padStart(2, "0")}`;
            const status = epFileCount > 0 ? "COMPLETED" : "NEW";
            const result = db.prepare(
              "INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count) VALUES (?, 'series', ?, ?, ?, '[]', ?)"
            ).run(title, s.id, seasonNum, status, epCount || null);
            console.log(`[Import] Created series request: ${title} (sonarr_id=${s.id}, status=${status}, ${epFileCount}/${epCount} episodes)`);
            imported.push({ title, id: Number(result.lastInsertRowid) });
          }
        } catch (e: any) {
          console.error(`[Import] Failed to process series ${s.title}: ${e.message}`);
        }
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

      res.json({ success: true, imported: imported.length, skipped: skipped.length, fixed, orphaned: orphanedMovies.length, items: imported, skippedItems: skipped, removedOrphans: orphanedMovies.map((o: any) => o.title) });
    } catch (error) {
      console.error("Error importing missing requests:", error);
      res.status(500).json({ error: "Failed to import missing requests" });
    }
  });

  // GET /api/requests/processed - List files in Processed folders
  router.get("/processed", (req: Request, res: Response) => {
    try {
      const listDir = (dir: string): { name: string; size: number; isDir: boolean }[] => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
          const fullPath = path.join(dir, entry.name);
          let size = 0;
          try {
            const stat = fs.statSync(fullPath);
            size = stat.isDirectory() ? 0 : stat.size;
          } catch {}
          return { name: entry.name, size, isDir: entry.isDirectory() };
        }).filter((f) => !f.name.startsWith("."));
      };

      const moviesDir = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
      const tvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
      const movies = listDir(moviesDir);
      const tv = listDir(tvDir);
      res.json({ movies, tv, moviesDir, tvDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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
             WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '') as release_count,
             (SELECT COALESCE(SUM(json_array_length(ah4.processed_files)), 0) FROM approval_history ah4 
              WHERE ah4.request_id = mr.id
              AND ah4.processed_files IS NOT NULL AND ah4.processed_files != '[]') as processed_count
          FROM media_requests mr
          WHERE mr.status IN ('DOWNLOADING', 'SEEDING', 'COMPLETED', 'NEW')
        ) sub
        WHERE sub.type = 'series' OR sub.release_count > 0 OR sub.processed_count > 0 OR sub.status = 'COMPLETED'
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
              } else {
                try {
                  const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, s.season);
                  if (sonarrEps.length > 0) {
                    s.episode_count = sonarrEps.length;
                    db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(sonarrEps.length, s.id);
                  }
                } catch {}
              }
            }
          }
        }

      const franchiseTitleSeason = seasons.find((s: any) => s.season !== 0) || seasons[0];
      const franchiseTitle = franchiseTitleSeason.title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
        const firstRequestId = seasons[0].id;
        // Compute total size from processed files (source of truth), fall back to torrent sizes
        const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
        let processedBytes = 0;
        try {
          for (const s of seasons) {
            const ahRows = db.prepare(`
              SELECT processed_files FROM approval_history
              WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'
            `).all(s.id) as any[];
            for (const ah of ahRows) {
              const files: string[] = JSON.parse(ah.processed_files || "[]");
              for (const f of files) {
                const fullPath = path.join(processedTvDir, f);
                try { processedBytes += fs.statSync(fullPath).size; } catch {}
              }
            }
          }
        } catch {}
        let franchiseSize = processedBytes > 0
          ? processedBytes / (1024 * 1024)
          : seasons.reduce((sum: number, s: any) => sum + s.total_size_mb, 0);
        const mappedSeasons = seasons.map((s: any) => {
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
          // Also count library-imported files — parse episode numbers from processed_files paths
          const processedAh = db.prepare(`
            SELECT processed_files FROM approval_history
            WHERE request_id = ? AND (release_id IS NULL OR release_id = 0)
            AND processed_files IS NOT NULL AND processed_files != '[]'
          `).all(s.id) as any[];
          for (const pa of processedAh) {
            const files: string[] = JSON.parse(pa.processed_files || "[]");
            for (const pf of files) {
              const epNum = extractEpisodeFromFilename(pf);
              if (epNum != null) coveredEps.add(epNum);
            }
          }
          // Also scan the season folder on disk for files not yet in approval_history
          let folderSizeBytes = 0;
          const diskEps = new Set<number>();
          try {
            const seasonFolder = path.join(processedTvDir, franchiseTitle, `S${String(s.season).padStart(2, "0")}`);
            if (fs.existsSync(seasonFolder)) {
              for (const f of fs.readdirSync(seasonFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const epNum = extractEpisodeFromFilename(f);
                if (epNum != null) diskEps.add(epNum);
                try { folderSizeBytes += fs.statSync(path.join(seasonFolder, f)).size; } catch {}
              }
              // Prefer disk coverage over RC coverage when season folder exists
              for (const ep of coveredEps) {
                if (diskEps.has(ep)) continue;
                // Keep RC coverage only if the episode also exists in this season's folder
                // (RC coverage without a matching disk file is stale — file was moved)
                coveredEps.delete(ep);
              }
            }
          } catch {}
          // Also add disk-only episodes (files without RC)
          for (const ep of diskEps) coveredEps.add(ep);
          const folderSizeMb = folderSizeBytes / (1024 * 1024);
          const totalSizeMb = Math.max(s.total_size_mb || 0, folderSizeMb);
          return {
            season: s.season,
            request_id: s.id,
            status: s.status,
            total_size_mb: totalSizeMb,
            release_count: s.release_count,
            title: s.title,
            episode_count: s.episode_count,
            covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
          };
        }).sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
        // Inject unrequested seasons from Sonarr (e.g., Specials/season 0)
        if (seriesObj) {
          const existingSeasons = new Set(mappedSeasons.map((s: any) => s.season));
          for (const sn of (seriesObj.seasons || [])) {
            if (!existingSeasons.has(sn.seasonNumber)) {
              const epCount = sn.statistics?.episodeCount || 0;
              const seasonFolder = path.join(processedTvDir, franchiseTitle, `S${String(sn.seasonNumber).padStart(2, "0")}`);
              const coveredEps = new Set<number>();
              try {
                if (fs.existsSync(seasonFolder)) {
                  for (const f of fs.readdirSync(seasonFolder)) {
                    const epNum = extractEpisodeFromFilename(f);
                    if (epNum != null) coveredEps.add(epNum);
                  }
                }
              } catch {}
              let actualEpCount = epCount;
              try {
                const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, sn.seasonNumber);
                actualEpCount = Math.max(sonarrEps.length, coveredEps.size);
              } catch {
                if (!actualEpCount && coveredEps.size > 0) actualEpCount = coveredEps.size;
              }
              mappedSeasons.push({
                season: sn.seasonNumber,
                request_id: null,
                status: null,
                total_size_mb: 0,
                release_count: 0,
                title: franchiseTitle,
                episode_count: actualEpCount,
                covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
              });
            }
          }
          mappedSeasons.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
        }
        if (processedBytes === 0) {
          franchiseSize = mappedSeasons.reduce((sum: number, s: any) => sum + (s.total_size_mb || 0), 0);
        }
        const totalCovered = mappedSeasons.reduce((sum: number, s: any) => sum + (s.covered_episodes?.length || 0), 0);
        managed.push({
          title: franchiseTitle,
          type: "series",
          sonarr_id: sonarrId,
          first_request_id: firstRequestId,
          seasons: mappedSeasons,
          total_size_mb: franchiseSize,
          total_releases: seasons.reduce((sum: number, s: any) => sum + s.release_count, 0),
          total_covered: totalCovered,
        });
      }

      // Add individual movies
      const processedMoviesDir = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
      for (const movie of movies) {
        let pSize = movie.total_size_mb;
        if ((movie.processed_count || 0) > 0) {
          try {
            const ahRows = db.prepare(`
              SELECT processed_files FROM approval_history
              WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'
            `).all(movie.id) as any[];
            let totalBytes = 0;
            for (const ah of ahRows) {
              const files: string[] = JSON.parse(ah.processed_files || "[]");
              for (const f of files) {
                const fullPath = path.join(processedMoviesDir, f);
                try { totalBytes += fs.statSync(fullPath).size; } catch {}
              }
            }
            if (totalBytes > 0) pSize += totalBytes / (1024 * 1024);
          } catch {}
        }
        managed.push({
          title: movie.title,
          type: "movie",
          request_id: movie.id,
          status: movie.status,
          total_size_mb: pSize,
          release_count: movie.release_count,
          processed_count: movie.processed_count || 0,
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
      deletedFranchiseIds?.add(sonarrId);
      res.json({ success: true, deleted: rows.length, title: rows[0].title });
    } catch (error: any) {
      console.error("Error deleting franchise:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/managed/:sonarrId/seasons - Lightweight: all seasons from Sonarr + which are requested
  router.get("/managed/:sonarrId/seasons", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const series = await sonarr.getSeries(sonarrId).catch(() => null);
      if (!series) return res.status(404).json({ error: "Series not found in Sonarr" });
      const sonarrSeasons = (series.seasons || []).map((s: any) => s.seasonNumber);

      const requestedSeasons = db.prepare(
        "SELECT season, id, status, title FROM media_requests WHERE sonarr_id = ? AND type = 'series'"
      ).all(sonarrId) as any[];

      const requestedMap = new Map<number, any>();
      for (const rs of requestedSeasons) requestedMap.set(rs.season, rs);

      const seasons = sonarrSeasons.map((sn: number) => ({
        season: sn,
        requested: requestedMap.get(sn) || null,
      }));

      res.json({ title: series.title, sonarr_id: sonarrId, seasons });
    } catch (error: any) {
      console.error("Error fetching franchise seasons:", error);
      res.status(500).json({ error: error.message || "Failed to fetch seasons" });
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

        const franchiseTitleSeason = seasons.find((s: any) => s.season !== 0) || seasons[0];
        const franchiseTitle = franchiseTitleSeason.title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");

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

        // Also count library-imported files — parse episode numbers from processed_files paths (verify on disk)
        const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
        const processedAh = db.prepare(`
          SELECT processed_files FROM approval_history
          WHERE request_id = ? AND (release_id IS NULL OR release_id = 0)
          AND processed_files IS NOT NULL AND processed_files != '[]'
        `).all(s.id) as any[];
        for (const pa of processedAh) {
          const files: string[] = JSON.parse(pa.processed_files || "[]");
          for (const pf of files) {
            const fullPath = path.join(processedTvDir, franchiseTitle, pf);
            if (!fs.existsSync(fullPath)) continue;
            const epNum = extractEpisodeFromFilename(pf);
            if (epNum != null) coveredEps.add(epNum);
          }
        }
        // Also scan the season folder on disk for files not yet in approval_history
        let folderSizeBytes = 0;
        const diskEps = new Set<number>();
        try {
          const seasonFolder = path.join(processedTvDir, franchiseTitle, `S${String(s.season).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const epNum = extractEpisodeFromFilename(f);
              if (epNum != null) diskEps.add(epNum);
              try { folderSizeBytes += fs.statSync(path.join(seasonFolder, f)).size; } catch {}
            }
            // Prefer disk coverage over RC coverage when season folder exists
            for (const ep of coveredEps) {
              if (diskEps.has(ep)) continue;
              coveredEps.delete(ep);
            }
          }
        } catch {}
        // Also add disk-only episodes (files without RC)
        for (const ep of diskEps) coveredEps.add(ep);
        const folderSizeMb = folderSizeBytes / (1024 * 1024);
        const totalSizeMb = Math.max(s.total_size_mb || 0, folderSizeMb);

        seasonDetails.push({
          season: s.season,
          request_id: s.id,
          status: s.status,
          total_size_mb: totalSizeMb,
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

      // Inject unrequested seasons from Sonarr (e.g., Specials)
      const seriesObj2 = await sonarr.getSeries(sonarrId).catch(() => null);
      if (seriesObj2) {
        const existingSeasons = new Set(seasonDetails.map((s: any) => s.season));
        const processedTvDir2 = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
        for (const sn of (seriesObj2.seasons || [])) {
          if (!existingSeasons.has(sn.seasonNumber)) {
            const epCount = sn.statistics?.episodeCount || 0;
            const seasonFolder2 = path.join(processedTvDir2, franchiseTitle, `S${String(sn.seasonNumber).padStart(2, "0")}`);
            const coveredEps3 = new Set<number>();
            let folderSize = 0;
            try {
              if (fs.existsSync(seasonFolder2)) {
                for (const f of fs.readdirSync(seasonFolder2)) {
                  const fp = path.join(seasonFolder2, f);
                  try { folderSize += fs.statSync(fp).size; } catch {}
                  const epNum = extractEpisodeFromFilename(f);
                  if (epNum != null) coveredEps3.add(epNum);
                }
              }
            } catch {}
            // Use filesystem count if Sonarr returns 0 but files exist
            let actualEpCount = epCount;
            if (!actualEpCount && coveredEps3.size > 0) {
              try {
                const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, sn.seasonNumber);
                actualEpCount = Math.max(sonarrEps.length, coveredEps3.size);
              } catch { actualEpCount = coveredEps3.size; }
            }
            seasonDetails.push({
              season: sn.seasonNumber,
              request_id: null,
              status: null,
              total_size_mb: folderSize / (1024 * 1024),
              release_count: 0,
              title: franchiseTitle,
              episode_count: actualEpCount,
              covered_episodes: Array.from(coveredEps3).sort((a, b) => a - b),
              releases: [],
            });
          }
        }
        seasonDetails.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
      }

      res.json({
        title: franchiseTitle,
        sonarr_id: sonarrId,
        seasons: seasonDetails,
        total_size_mb: seasonDetails.reduce((sum: number, s: any) => sum + (s.total_size_mb || 0), 0),
        total_releases: seasonDetails.reduce((sum: number, s: any) => sum + (s.release_count || 0), 0),
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

      if (!row) {
        // No DB entry — fetch from Sonarr + filesystem (e.g., Specials)
        let sonarrEpisodes2: Array<{ episodeNumber: number; title: string; hasFile: boolean; airDateUtc?: string }> = [];
        try {
          const episodes2 = await sonarr.getSeasonEpisodes(sonarrId, seasonNum);
          sonarrEpisodes2 = episodes2.map((e: any) => ({
            episodeNumber: e.episodeNumber,
            title: e.title,
            hasFile: e.hasFile,
            airDateUtc: e.airDateUtc,
          }));
        } catch {}
        // Scan processed filesystem for files in S00 folder
        const seriesObj3 = await sonarr.getSeries(sonarrId).catch(() => null);
        const franchiseTitle3 = seriesObj3?.title || `Series ${sonarrId}`;
        const processedTvDir3 = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
        const seasonFolder3 = path.join(processedTvDir3, franchiseTitle3, `S${String(seasonNum).padStart(2, "0")}`);
        const coveredEpsFS = new Set<number>();
        const epQualityFS: Record<number, string> = {};
        try {
          if (fs.existsSync(seasonFolder3)) {
            for (const f of fs.readdirSync(seasonFolder3)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const epNum = extractEpisodeFromFilename(f);
              if (epNum != null) {
                coveredEpsFS.add(epNum);
                if (!epQualityFS[epNum]) epQualityFS[epNum] = "WEB-DL";
              }
            }
          }
        } catch {}
        const episodes3 = sonarrEpisodes2.map((e: any) => ({
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.hasFile,
          covered: coveredEpsFS.has(e.episodeNumber),
          quality: epQualityFS[e.episodeNumber] || "",
          airDateUtc: e.airDateUtc || "",
        }));
        // Also add filesystem-only eps not in Sonarr
        for (const epNum of coveredEpsFS) {
          if (!episodes3.some((e: any) => e.episodeNumber === epNum)) {
            episodes3.push({
              episodeNumber: epNum,
              title: "",
              hasFile: false,
              covered: true,
              quality: epQualityFS[epNum] || "",
              airDateUtc: "",
            });
          }
        }
        episodes3.sort((a: any, b: any) => a.episodeNumber - b.episodeNumber);
        return res.json({
          episodeCount: sonarrEpisodes2.length,
          coveredCount: coveredEpsFS.size,
          episodes: episodes3,
        });
      }

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
              const quality = r.radarr_quality?.toLowerCase() === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
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
            const quality = r.radarr_quality?.toLowerCase() === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
            for (let i = 1; i <= (sonarrEpisodes.length || row.episode_count || 0); i++) {
              if (!epQuality[i] || quality.toLowerCase().includes("remux")) epQuality[i] = quality;
            }
          }
        }
      }

      // Also count library-imported files (no RC) as full season coverage
      const processedAh2 = db.prepare(`
        SELECT processed_files FROM approval_history
        WHERE request_id = ? AND (release_id IS NULL OR release_id = 0)
        AND processed_files IS NOT NULL AND processed_files != '[]'
      `).all(row.id) as any[];
      for (const pa of processedAh2) {
        const files: string[] = JSON.parse(pa.processed_files || "[]");
        for (const pf of files) {
          const epNum = extractEpisodeFromFilename(pf);
          if (epNum != null) {
            coveredEps.add(epNum);
            const quality = "WEB-DL";
            if (!epQuality[epNum] || quality.toLowerCase().includes("remux")) epQuality[epNum] = quality;
          }
        }
      }

      // Also count files on disk in the season folder (prefer disk over RC)
      const diskEps2 = new Set<number>();
      try {
        const series = await sonarr.getSeries(row.sonarr_id);
        const fTitle = series.title;
        const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
        const seasonFolder = path.join(processedTvDir, fTitle, `S${String(seasonNum).padStart(2, "0")}`);
        if (fs.existsSync(seasonFolder)) {
          for (const f of fs.readdirSync(seasonFolder)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            const epNum = extractEpisodeFromFilename(f);
            if (epNum != null) diskEps2.add(epNum);
          }
          // Prefer disk coverage over RC coverage when season folder exists
          for (const ep of coveredEps) {
            if (diskEps2.has(ep)) continue;
            coveredEps.delete(ep);
          }
        }
      } catch {}
      // Add disk-only episodes
      for (const ep of diskEps2) {
        coveredEps.add(ep);
        if (!epQuality[ep]) epQuality[ep] = "WEB-DL";
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
              series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title),
              `S${String(season.season).padStart(2, "0")}`
            );
            if (fs.existsSync(seasonFolder)) {
              let contentPath = fromQBittorrentPath(torrent.content_path);
              if (!fs.existsSync(contentPath)) contentPath = torrent.content_path;
              const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);
              for (const f of fs.readdirSync(seasonFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const fPath = path.join(seasonFolder, f);
                try {
                  if (contentInodes.size > 0 && contentInodes.has(fs.statSync(fPath).ino)) {
                    inLibrary = true;
                    libraryPath = fPath;
                    break;
                  }
                } catch {}
              }
              // Fallback: filename match
              if (!inLibrary) {
                const match = fs.readdirSync(seasonFolder).find((f: string) => contentNames.has(f));
                if (match) { inLibrary = true; libraryPath = path.join(seasonFolder, match); }
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
          save_path: fromQBittorrentPath(torrent.save_path),
          content_path: fromQBittorrentPath(torrent.content_path),
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
                .run(match.hash, fromQBittorrentPath(match.save_path), approvedRelease.id);
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

          const quality = parseQualityFromName(match.name);

          const rcResult = db.prepare(
            "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, torrent_hash, save_path, parsed_episodes) " +
            "VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)"
          ).run(orphan.id, `manual-${match.hash.slice(0, 12)}`, match.name, sizeMb, quality, match.hash, fromQBittorrentPath(match.save_path), episodeStr);

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

      // Always run title+season mismatch detection (even when there are new torrents)
      const qbitHashesForCheck = new Set(allTorrents.map((t: any) => t.hash));
      // Fix season mismatches: RCs attached to wrong-season requests
      const allRcWithReq = db.prepare(
        "SELECT rc.id as rc_id, rc.request_id, rc.torrent_hash, rc.title as rc_title, mr.season as req_season, mr.sonarr_id, mr.type " +
        "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL AND mr.type = 'series'"
      ).all() as any[];
      let seasonFixed = 0;
      for (const rc of allRcWithReq) {
        if (!qbitHashesForCheck.has(rc.torrent_hash)) continue;
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
      // Fix title mismatches: RCs attached to wrong-title requests (e.g. Moana 2 torrent matched to Moana, or Ninjago linked to "The Rising")
      const allRcWithTitle = db.prepare(
        "SELECT rc.id as rc_id, rc.request_id, rc.torrent_hash, rc.title as rc_title, mr.title as req_title, mr.type " +
        "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
      ).all() as any[];
      let titleFixed = 0;
      for (const rc of allRcWithTitle) {
        if (!qbitHashesForCheck.has(rc.torrent_hash)) continue;
        const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
        if (!torrent) continue;
        const torrentNorm = normalizeTitleForMatch(torrent.name);
        const reqNorm = normalizeTitleForMatch(rc.req_title);
        if (!titlesMatch(reqNorm, torrentNorm)) {
          db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.rc_id);
          db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.rc_id);
          console.log(`[ScanDownloads] Title mismatch: RC ${rc.rc_id} (request "${rc.req_title}") <- torrent "${torrent.name.slice(0, 60)}"`);
          titleFixed++;
        }
      }
      if (seasonFixed > 0) console.log(`[ScanDownloads] Removed ${seasonFixed} season-mismatched RC(s)`);
      if (titleFixed > 0) console.log(`[ScanDownloads] Removed ${titleFixed} title-mismatched RC(s)`);

      let newTorrents = allTorrents.filter((t: any) => !existingHashes.has(t.hash));

      // Also include freed torrents from mismatch cleanup
      if (seasonFixed > 0 || titleFixed > 0) {
        const freshHashes = new Set(
          db.prepare("SELECT torrent_hash FROM release_candidates WHERE torrent_hash != ''")
            .all().map((r: any) => r.torrent_hash)
        );
        newTorrents = allTorrents.filter((t: any) => !freshHashes.has(t.hash));
      }

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
        // Fix RCs with wrong title or Unknown quality
        const rcToFix = db.prepare(
          "SELECT rc.id, rc.title, rc.torrent_hash, rc.radarr_quality FROM release_candidates rc " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
        ).all() as any[];
        let rcFixed = 0;
        for (const rc of rcToFix) {
          if (!qbitHashes.has(rc.torrent_hash)) continue;
          const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
          if (!torrent) continue;
          const correctQuality = parseQualityFromName(torrent.name);
          if (rc.title !== torrent.name || rc.radarr_quality?.toLowerCase() === 'unknown') {
            db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, rc.id);
            console.log(`[ScanDownloads] Fixed RC ${rc.id}: title="${torrent.name.slice(0, 60)}", quality="${correctQuality}"`);
            rcFixed++;
          }
        }
        if (rcFixed > 0) console.log(`[ScanDownloads] Fixed ${rcFixed} RC(s) with wrong title/quality`);
        if (backfilled > 0) console.log(`[ScanDownloads] Backfilled ${backfilled} orphaned RC(s) with approval_history`);

        return res.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, total: allTorrents.length, results: [], backfilled, staleRemoved: toRemove.length, statusFixed: staleFixed, rcFixed });
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
        const savePath = (fromQBittorrentPath(torrent.save_path) || "").toLowerCase();

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
              if (deletedFranchiseIds?.has(s.id)) return false;
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
              ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name));
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
              results.push({ title, status: "imported", type: "movie", request_id: Number(requestId) });
              console.log(`[ScanDownloads] Movie: ${title} (radarr_id=${finalRadarrId})`);
            } else {
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id, title, radarr_quality FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name));
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                console.log(`[ScanDownloads] Added RC for movie: ${title} (hash=${torrent.hash.slice(0, 12)})`);
              } else {
                const correctQuality = parseQualityFromName(torrent.name);
                if (existingRc.title !== torrent.name || existingRc.radarr_quality?.toLowerCase() === 'unknown') {
                  db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, existingRc.id);
                  console.log(`[ScanDownloads] Fixed RC ${existingRc.id}: title="${torrent.name}", quality="${correctQuality}"`);
                }
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
            if (deletedFranchiseIds?.has(finalSonarrId)) continue;
            const title = matchedSonarr?.title || matchedTitle;
            const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(finalSonarrId, season) as any;
            if (!existingReq) {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, sonarr_id, status, season, requested_by) VALUES (?, 'series', ?, 'DOWNLOADING', ?, '[]')"
              ).run(title, finalSonarrId, season);
              const requestId = result.lastInsertRowid as number;
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
              ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name), epStr);
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
              results.push({ title, status: "imported", type: "series", request_id: Number(requestId) });
              console.log(`[ScanDownloads] Series: ${title} (sonarr_id=${finalSonarrId}, S${String(season).padStart(2, "0")})`);
            } else {
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id, title, radarr_quality FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name), epStr);
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                console.log(`[ScanDownloads] Added RC for series: ${title} (hash=${torrent.hash.slice(0, 12)})`);
              } else {
                const correctQuality = parseQualityFromName(torrent.name);
                if (existingRc.title !== torrent.name || existingRc.radarr_quality?.toLowerCase() === 'unknown') {
                  db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, existingRc.id);
                  console.log(`[ScanDownloads] Fixed RC ${existingRc.id}: title="${torrent.name}", quality="${correctQuality}"`);
                }
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

  // POST /api/requests/import-library - Scan Radarr/Sonarr library, hardlink files into processed dirs
  router.post("/import-library", async (req: Request, res: Response) => {
    try {
      const results: Array<{ title: string; status: string; path?: string; error?: string }> = [];
      const processedMoviesDir = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
      const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";

      // Scan Radarr movies
      try {
        const movies = await radarr.getAllMovies();
        for (const m of movies) {
          if (!m.hasFile) continue;
          try {
            const movie = await radarr.getMovie(m.id);
            const filePath = movie.movieFile?.path;
            if (!filePath || !fs.existsSync(filePath)) {
              results.push({ title: m.title, status: "skipped", path: filePath, error: "file not found on disk" });
              continue;
            }
            const fileName = path.basename(filePath);
            const destPath = path.join(processedMoviesDir, fileName);
            // Dedup: check by inode across ALL files in processed dir (Radarr renames files)
            let alreadyImported = false;
            const srcIno = (() => { try { return fs.statSync(filePath).ino; } catch { return 0; } })();
            if (srcIno > 0) {
              for (const existing of fs.readdirSync(processedMoviesDir)) {
                try {
                  if (fs.statSync(path.join(processedMoviesDir, existing)).ino === srcIno) {
                    alreadyImported = true;
                    break;
                  }
                } catch {}
              }
            } else if (fs.existsSync(destPath)) {
              alreadyImported = true;
            }
            if (!alreadyImported) {
              fs.linkSync(filePath, destPath);
              console.log(`[ImportLibrary] Hardlinked ${fileName} → processed/filmy`);
              results.push({ title: m.title, status: "imported", path: destPath });
            } else {
              results.push({ title: m.title, status: "exists", path: filePath });
            }
          try {
            let req = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ? AND type = 'movie'").get(m.id) as any;
            if (!req) {
              req = db.prepare("SELECT id, status FROM media_requests WHERE title = ? AND type = 'movie'").get(m.title) as any;
            }
            if (!req) {
              const result = db.prepare("INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, 'COMPLETED', '[]')").run(m.title, m.id);
              console.log(`[ImportLibrary] Created media_request for ${m.title} (COMPLETED)`);
              req = { id: Number(result.lastInsertRowid), status: 'COMPLETED' };
            }
            if (req.status !== 'COMPLETED' && req.status !== 'DOWNLOADING' && req.status !== 'SEEDING') {
              db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(req.id);
              console.log(`[ImportLibrary] Updated ${m.title} status to COMPLETED (was ${req.status})`);
            }
            const processedFiles: string[] = [];
            // Add Radarr-managed file
            if (!processedFiles.includes(fileName)) processedFiles.push(fileName);
            // Also scan movie folder for additional video files not tracked by Radarr
            const movieFolder = movie.path || path.dirname(filePath);
            if (fs.existsSync(movieFolder)) {
              for (const entry of fs.readdirSync(movieFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
                if (entry === fileName) continue; // already imported above
                const extraPath = path.join(movieFolder, entry);
                const extraDest = path.join(processedMoviesDir, entry);
                const extraIno = (() => { try { return fs.statSync(extraPath).ino; } catch { return 0; } })();
                let alreadyExtra = false;
                if (extraIno > 0) {
                  for (const existing of fs.readdirSync(processedMoviesDir)) {
                    try {
                      if (fs.statSync(path.join(processedMoviesDir, existing)).ino === extraIno) {
                        alreadyExtra = true;
                        break;
                      }
                    } catch {}
                  }
                } else if (fs.existsSync(extraDest)) {
                  alreadyExtra = true;
                }
                if (!alreadyExtra) {
                  try {
                    fs.linkSync(extraPath, extraDest);
                    console.log(`[ImportLibrary] Hardlinked extra ${entry} → processed/filmy`);
                  } catch (e2: any) {
                    console.error(`[ImportLibrary] Failed to hardlink extra ${entry}: ${e2.message}`);
                  }
                }
                if (!processedFiles.includes(entry)) processedFiles.push(entry);
              }
            }
            const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? ORDER BY approved_at DESC LIMIT 1").get(req.id) as any;
            if (ah) {
              const existing = JSON.parse(ah.processed_files || "[]");
              for (const pf of processedFiles) {
                if (!existing.includes(pf)) existing.push(pf);
              }
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
            } else {
              db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(req.id, JSON.stringify(processedFiles));
            }
          } catch (e: any) {
            console.error(`[ImportLibrary] Failed to associate ${m.title}:`, e.message);
          }
          } catch (e: any) {
            results.push({ title: m.title, status: "error", error: e.message });
          }
        }
      } catch (e: any) {
        results.push({ title: "(Radarr)", status: "error", error: `Failed to fetch movies: ${e.message}` });
      }

      // Helper: ensure media_requests exists for a series season, create COMPLETED if not
      function ensureSeriesRequest(sonarrId: number, seasonNum: number, title: string): number | null {
        let req = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND season = ?").get(sonarrId, seasonNum) as any;
        if (!req) {
          req = db.prepare("SELECT id, status FROM media_requests WHERE title LIKE ? AND type = 'series' AND season = ?").get(`%${title}%`, seasonNum) as any;
        }
        if (!req) {
          const result = db.prepare("INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count) VALUES (?, 'series', ?, ?, 'COMPLETED', '[]', ?)").run(title, sonarrId, seasonNum, null);
          console.log(`[ImportLibrary] Created media_request for ${title} S${String(seasonNum).padStart(2, "0")} (COMPLETED)`);
          return Number(result.lastInsertRowid);
        }
        if (req.status !== 'COMPLETED' && req.status !== 'DOWNLOADING' && req.status !== 'SEEDING') {
          db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(req.id);
          console.log(`[ImportLibrary] Updated ${title} S${String(seasonNum).padStart(2, "0")} status to COMPLETED (was ${req.status})`);
        }
        return req.id;
      }

      // Scan Sonarr series
      try {
        const seriesList = await sonarr.getAllSeries();
        for (const s of seriesList) {
          try {
            const detail = await sonarr.getSeries(s.id);
            let seriesPath = detail.path;
            if (!seriesPath || !fs.existsSync(seriesPath)) {
              const mediaTv = process.env.MEDIA_TV || "/media/Serialy";
              const fallback = path.join(mediaTv, path.basename(seriesPath || ""), s.title);
              const fallback2 = path.join(mediaTv, s.title);
              if (seriesPath && fs.existsSync(fallback)) seriesPath = fallback;
              else if (fs.existsSync(fallback2)) seriesPath = fallback2;
              else {
                // Fuzzy match: find a dir in MEDIA_TV containing the series title (case-insensitive)
                const titleLower = s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                try {
                  for (const entry of fs.readdirSync(mediaTv, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    const entryLower = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                    if (entryLower.includes(titleLower) || titleLower.includes(entryLower)) {
                      const candidate = path.join(mediaTv, entry.name);
                      seriesPath = candidate;
                      console.log(`[ImportLibrary] ${s.title}: fuzzy matched to "${entry.name}"`);
                      break;
                    }
                  }
                } catch {}
                if (!seriesPath || !fs.existsSync(seriesPath)) {
                  console.log(`[ImportLibrary] Skipping ${s.title}: Sonarr path "${detail.path}" not found on host`);
                  continue;
                }
              }
            }
            // Create series subfolder in processed
            const seriesDest = path.join(processedTvDir, s.title);
            if (!fs.existsSync(seriesDest)) fs.mkdirSync(seriesDest, { recursive: true });
            // Pre-create S00 folder for specials only if Sonarr has season 0
            const hasSpecials = detail.seasons?.some((sn: any) => Number(sn.seasonNumber) === 0);
            if (hasSpecials) {
              const specialsDest = path.join(seriesDest, "S00");
              if (!fs.existsSync(specialsDest)) {
                fs.mkdirSync(specialsDest, { recursive: true });
                console.log(`[ImportLibrary] Created S00 folder for ${s.title} (specials)`);
              }
            }
            const seriesEntries = fs.readdirSync(seriesPath, { withFileTypes: true });
            const seasonDirs = seriesEntries.filter(e => e.isDirectory() && parseSeasonNumber(e.name) !== null);
            let seriesFiles = 0;
            // Walk season dirs for video files
            for (const entry of seasonDirs) {
              const seasonNum = parseSeasonNumber(entry.name);
              const seasonDir = path.join(seriesPath, entry.name);
              const seasonDest = path.join(seriesDest, `S${String(seasonNum).padStart(2, "0")}`);
              if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
              for (const f of fs.readdirSync(seasonDir)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                seriesFiles++;
                const srcPath = path.join(seasonDir, f);
                const destPath = path.join(seasonDest, f);
                const relPath = path.join(s.title, `S${String(seasonNum).padStart(2, "0")}`, f);
                const alreadyImported = (() => {
                  if (!fs.existsSync(destPath)) return false;
                  try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
                })();
                if (!alreadyImported) {
                  try {
                    fs.linkSync(srcPath, destPath);
                    console.log(`[ImportLibrary] Hardlinked ${s.title} ${entry.name}/${f} → processed/serialy`);
                    results.push({ title: `${s.title} ${entry.name}/${f}`, status: "imported", path: destPath });
                  } catch (linkErr: any) {
                    console.error(`[ImportLibrary] Failed to hardlink ${s.title} ${entry.name}/${f}:`, linkErr.message);
                    results.push({ title: `${s.title} ${entry.name}/${f}`, status: "error", error: linkErr.message });
                    continue;
                  }
                }
                // Always try association, even for already-imported files
                try {
                  const reqId = ensureSeriesRequest(s.id, seasonNum!, s.title);
                  if (reqId) {
                    const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                    if (ah) {
                      const existing = JSON.parse(ah.processed_files || "[]");
                      if (!existing.includes(relPath)) {
                        existing.push(relPath);
                        db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
                      }
                    } else {
                      db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                    }
                  }
                } catch (e: any) {
                  console.error(`[ImportLibrary] Failed to associate ${s.title} ${f}:`, e.message);
                }
              }
            }
            // Also handle video files directly in series root (no season subdirs)
            const rootVideoFiles = seriesEntries.filter(e => !e.isDirectory() && /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e.name));
            for (const vf of rootVideoFiles) {
              const seasonNum = parseSeasonNumber(vf.name) || 1;
              const srcPath = path.join(seriesPath, vf.name);
              const seasonDest = path.join(seriesDest, `S${String(seasonNum).padStart(2, "0")}`);
              if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
              const destPath = path.join(seasonDest, vf.name);
              const relPath = path.join(s.title, `S${String(seasonNum).padStart(2, "0")}`, vf.name);
              seriesFiles++;
              const alreadyImported = (() => {
                if (!fs.existsSync(destPath)) return false;
                try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
              })();
              if (!alreadyImported) {
                try {
                  fs.linkSync(srcPath, destPath);
                  console.log(`[ImportLibrary] Hardlinked ${s.title} root/${vf.name} → processed/serialy`);
                  results.push({ title: `${s.title} ${vf.name}`, status: "imported", path: destPath });
                } catch (linkErr: any) {
                  console.error(`[ImportLibrary] Failed to hardlink ${s.title} root/${vf.name}:`, linkErr.message);
                  results.push({ title: `${s.title} ${vf.name}`, status: "error", error: linkErr.message });
                }
              }
              try {
                const reqId = ensureSeriesRequest(s.id, seasonNum, s.title);
                if (reqId) {
                  const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                  if (ah) {
                    const existing = JSON.parse(ah.processed_files || "[]");
                    if (!existing.includes(relPath)) { existing.push(relPath); db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id); }
                  } else {
                    db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                  }
                }
              } catch {}
            }
            // Also scan unmatched dirs that may contain video files (e.g. "Show S01 (720p)[Group]/")
            const unmatchedDirs = seriesEntries.filter(e => e.isDirectory() && !seasonDirs.includes(e));
            for (const ud of unmatchedDirs) {
              const udSeason = parseSeasonNumber(ud.name);
              if (udSeason === null) continue;
              const udPath = path.join(seriesPath, ud.name);
              const udFiles = (() => { try { return fs.readdirSync(udPath); } catch { return []; } })();
              for (const f of udFiles) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const seasonDest = path.join(seriesDest, `S${String(udSeason).padStart(2, "0")}`);
                if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
                const srcPath = path.join(udPath, f);
                const destPath = path.join(seasonDest, f);
                const relPath = path.join(s.title, `S${String(udSeason).padStart(2, "0")}`, f);
                seriesFiles++;
                const alreadyImported = (() => {
                  if (!fs.existsSync(destPath)) return false;
                  try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
                })();
                if (!alreadyImported) {
                  try {
                    fs.linkSync(srcPath, destPath);
                    console.log(`[ImportLibrary] Hardlinked ${s.title} ${ud.name}/${f} → processed/serialy`);
                    results.push({ title: `${s.title} ${ud.name}/${f}`, status: "imported", path: destPath });
                  } catch (linkErr: any) {
                    console.error(`[ImportLibrary] Failed to hardlink ${s.title} ${ud.name}/${f}:`, linkErr.message);
                    results.push({ title: `${s.title} ${ud.name}/${f}`, status: "error", error: linkErr.message });
                  }
                }
                try {
                  const reqId = ensureSeriesRequest(s.id, udSeason, s.title);
                  if (reqId) {
                    const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                    if (ah) {
                      const existing = JSON.parse(ah.processed_files || "[]");
                      if (!existing.includes(relPath)) { existing.push(relPath); db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id); }
                    } else {
                      db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                    }
                  }
                } catch {}
              }
            }
            if (seasonDirs.length === 0) {
              const allDirs = seriesEntries.filter(e => e.isDirectory()).map(e => e.name);
              console.log(`[ImportLibrary] ${s.title}: path="${seriesPath}" — no S## dirs found. Dirs: [${allDirs.join(", ")}]`);
            } else if (seriesFiles === 0) {
              console.log(`[ImportLibrary] ${s.title}: ${seasonDirs.length} season dirs but 0 video files. Checking extensions...`);
              for (const sd of seasonDirs.slice(0, 2)) {
                const files = fs.readdirSync(path.join(seriesPath, sd.name));
                console.log(`[ImportLibrary]   ${sd.name}: [${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}] (${files.length} total)`);
              }
            } else {
              console.log(`[ImportLibrary] ${s.title}: ${seasonDirs.length} seasons, ${seriesFiles} video files`);
            }
            // Upgrade any remaining NEW/AWAITING_APPROVAL seasons for this series to COMPLETED
            try {
              const remaining = db.prepare("SELECT id, title, season, status FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND status NOT IN ('COMPLETED', 'DOWNLOADING', 'SEEDING')").all(s.id) as any[];
              for (const r of remaining) {
                db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(r.id);
                console.log(`[ImportLibrary] Updated ${r.title} status to COMPLETED (was ${r.status})`);
              }
            } catch {}
          } catch (e: any) {
            results.push({ title: s.title, status: "error", error: e.message });
          }
        }
      } catch (e: any) {
        results.push({ title: "(Sonarr)", status: "error", error: `Failed to fetch series: ${e.message}` });
      }

      // Cleanup: remove flat video files in processed/serialy that are now inside subfolders (duplicates from first import)
      try {
        const topEntries = fs.readdirSync(processedTvDir, { withFileTypes: true });
        for (const te of topEntries) {
          if (te.isDirectory() || !/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(te.name)) continue;
          const flatPath = path.join(processedTvDir, te.name);
          const flatIno = (() => { try { return fs.statSync(flatPath).ino; } catch { return 0; } })();
          // Check if this file exists inside any series subfolder (same inode = duplicate)
          for (const se of topEntries) {
            if (!se.isDirectory()) continue;
            const seasonBase = path.join(processedTvDir, se.name);
            for (const sub of fs.readdirSync(seasonBase, { withFileTypes: true })) {
              if (!sub.isDirectory() || !/^S\d+$/i.test(sub.name)) continue;
              const seasonDir = path.join(seasonBase, sub.name);
              for (const f of fs.readdirSync(seasonDir)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const subPath = path.join(seasonDir, f);
                const subIno = (() => { try { return fs.statSync(subPath).ino; } catch { return 0; } })();
                if (flatIno > 0 && flatIno === subIno) {
                  fs.unlinkSync(flatPath);
                  console.log(`[ImportLibrary] Cleaned up flat duplicate: ${te.name}`);
                  break;
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.error(`[ImportLibrary] Cleanup error:`, e.message);
      }

      // Cleanup: remove empty season dirs and series dirs in processed/serialy
      try {
        const topEntries2 = fs.readdirSync(processedTvDir, { withFileTypes: true });
        for (const se of topEntries2) {
          if (!se.isDirectory()) continue;
          const seriesDir = path.join(processedTvDir, se.name);
          const seasonDirs = fs.readdirSync(seriesDir, { withFileTypes: true }).filter(d => d.isDirectory() && /^S0*[1-9]\d*$/i.test(d.name));
          for (const sd of seasonDirs) {
            const seasonDir = path.join(seriesDir, sd.name);
            const hasFiles = fs.readdirSync(seasonDir).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (!hasFiles) {
              fs.rmSync(seasonDir, { recursive: true, force: true });
              console.log(`[ImportLibrary] Removed empty season dir: ${se.name}/${sd.name}`);
            }
          }
          // Remove series dir if now empty
          if (fs.readdirSync(seriesDir).length === 0) {
            fs.rmSync(seriesDir, { recursive: true, force: true });
            console.log(`[ImportLibrary] Removed empty series dir: ${se.name}`);
          }
        }
      } catch (e: any) {
        console.error(`[ImportLibrary] Empty dir cleanup error:`, e.message);
      }

      const imported = results.filter(r => r.status === "imported").length;
      const exists = results.filter(r => r.status === "exists").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const errors = results.filter(r => r.status === "error").length;
      res.json({ imported, exists, skipped, errors, total: results.length, results });
    } catch (error: any) {
      console.error("Error importing library:", error);
      res.status(500).json({ error: `Failed to import library: ${error.message}` });
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

  // GET /api/workspaces/active - List all active workspaces across all requests
  router.get("/workspaces/active", async (req: Request, res: Response) => {
    try {
      const requests = db.prepare("SELECT id, title, type FROM media_requests").all() as any[];
      const allWorkspaces: any[] = [];
      for (const req2 of requests) {
        const ws = listWorkspaces(req2.id, req2.title);
        for (const w of ws) {
          allWorkspaces.push({
            ...w,
            requestId: req2.id,
            mediaTitle: req2.title,
            mediaType: req2.type,
          });
        }
      }
      res.json({ workspaces: allWorkspaces });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/workspaces/scan - Scan all workspace dirs, report orphaned/empty
  router.post("/workspaces/scan", async (req: Request, res: Response) => {
    try {
      const workspaceBase = process.env.PROCESSING_WORKSPACE || "/media/Torrents/Workspace";
      if (!fs.existsSync(workspaceBase)) return res.json({ workspaces: [], empty: true });

      const requests = db.prepare("SELECT id, title, type FROM media_requests").all() as any[];
      const requestMap = new Map<number, any>();
      for (const r of requests) requestMap.set(r.id, r);

      const entries = fs.readdirSync(workspaceBase, { withFileTypes: true });
      const results: any[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wsDir = path.join(workspaceBase, entry.name);
        const match = entry.name.match(/^(\d+)-/);
        const requestId = match ? parseInt(match[1], 10) : null;
        const request = requestId ? requestMap.get(requestId) : null;

        const inputsDir = path.join(wsDir, "inputs");
        const outputDir = path.join(wsDir, "output");
        const metaPath = path.join(wsDir, "metadata.json");

        let inputCount = 0;
        let outputCount = 0;
        let metadata: any = null;

        try { inputCount = fs.readdirSync(inputsDir).length; } catch {}
        try { outputCount = fs.readdirSync(outputDir).length; } catch {}
        try { metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}

        let status = "active";
        if (!request) status = "orphaned";
        else if (inputCount === 0 && outputCount === 0) status = "empty";

        results.push({
          dirName: entry.name,
          path: wsDir,
          requestId,
          requestTitle: request?.title || null,
          requestType: request?.type || null,
          inputCount,
          outputCount,
          metadata,
          status,
        });
      }

      res.json({ workspaces: results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/workspaces/cleanup - Delete orphaned/empty workspace dirs
  router.post("/workspaces/cleanup", async (req: Request, res: Response) => {
    try {
      const { dirNames } = req.body as { dirNames?: string[] };
      if (!dirNames || !Array.isArray(dirNames) || dirNames.length === 0) {
        return res.status(400).json({ error: "dirNames array required" });
      }

      const workspaceBase = process.env.PROCESSING_WORKSPACE || "/media/Torrents/Workspace";
      let deleted = 0;
      const errors: string[] = [];

      for (const name of dirNames) {
        const dirPath = path.join(workspaceBase, name);
        if (!dirPath.startsWith(workspaceBase)) continue;
        if (!fs.existsSync(dirPath)) continue;
        try {
          deleteWorkspace(dirPath);
          deleted++;
        } catch (err: any) {
          errors.push(`${name}: ${err.message}`);
        }
      }

      res.json({ deleted, errors });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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

  // POST /api/requests/:id/destroy/:releaseId - Per-torrent destroy: export torrent+trackers, delete from qbit, clean DB/processed
  router.post("/:id/destroy/:releaseId", async (req: Request, res: Response) => {
    try {
      const { id, releaseId } = req.params;
      const { deleteFiles } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const rel = db.prepare("SELECT * FROM release_candidates WHERE id = ? AND request_id = ?").get(releaseId, id) as any;
      if (!rel) return res.status(404).json({ error: "Release not found" });

      const TRACKERS_DIR = "/media/Torrents/Trackers";
      let exported = false;

      // Export .torrent + trackers
      if (rel.torrent_hash) {
        const hash = rel.torrent_hash;
        const dir = path.join(TRACKERS_DIR, hash);
        fs.mkdirSync(dir, { recursive: true });

        const torrentBuf = await qbittorrent.exportTorrent(hash);
        if (torrentBuf) {
          fs.writeFileSync(path.join(dir, `${rel.title || hash}.torrent`), torrentBuf);
        }

        const trackers = await qbittorrent.getTrackers(hash);
        fs.writeFileSync(path.join(dir, "trackers.json"), JSON.stringify({
          title: rel.title,
          hash,
          release_group: rel.release_group,
          size_mb: rel.size_mb,
          trackers: trackers.map((t) => t.url),
          exported_at: new Date().toISOString(),
        }, null, 2));

        exported = true;
        console.log(`[Destroy] Exported torrent+trackers for ${rel.title} → ${dir}`);

        // If keeping files, move content to processed before removing from qBit
        if (!deleteFiles && rel.torrent_hash) {
          const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
          if (torrent?.content_path && fs.existsSync(torrent.content_path)) {
            const type = request.type === "series" ? "series" : "movie";
            const destDir = getProcessedDir(type);
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, path.basename(torrent.content_path));
            const stat = fs.statSync(torrent.content_path);
            if (stat.isDirectory()) {
              fs.renameSync(torrent.content_path, dest);
            } else {
              fs.renameSync(torrent.content_path, dest);
            }
            console.log(`[Destroy] Moved kept files ${torrent.content_path} → ${dest}`);
            const names: string[] = stat.isDirectory()
              ? fs.readdirSync(dest)
              : [path.basename(dest)];
            try {
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE release_id = ?")
                .run(JSON.stringify(names), releaseId);
            } catch {}
          }
        }

        // Delete from qBittorrent
        try { await qbittorrent.deleteTorrent(hash, !!deleteFiles); } catch {}
      }

      // Delete this release from DB
      db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(releaseId);
      db.prepare("DELETE FROM release_candidates WHERE id = ?").run(releaseId);

      console.log(`[Destroy] Deleted release #${releaseId} (${rel.title}) from request #${id} (exported=${exported}, deleteFiles=${!!deleteFiles})`);
      res.json({ success: true, exported, title: rel.title });
    } catch (error: any) {
      console.error("Error destroying release:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id - Delete a single request and its releases
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deleteFiles = req.query.deleteFiles === "true";
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.json({ success: true });

      // Delete processed files
      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const approvals = db.prepare(
        "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
      ).all(id) as any[];
      for (const ah of approvals) {
        try {
          const names = JSON.parse(ah.processed_files);
          for (const name of names) {
            const fp = path.join(processedDir, name);
            if (fs.existsSync(fp)) {
              const st = fs.statSync(fp);
              if (st.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
              else fs.unlinkSync(fp);
            }
          }
        } catch {}
      }

      // Delete workspaces
      const wsDirs = listWorkspaces(request.id, request.title);
      for (const ws of wsDirs) {
        try { deleteWorkspace(ws.path); } catch {}
      }

      // Delete from Sonarr/Radarr
      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";
      const rUrl = process.env.RADARR_URL || "";
      const rKey = process.env.RADARR_API_KEY || "";
      if (request.sonarr_id && sUrl) {
        try { await fetch(`${sUrl}/api/v3/series/${request.sonarr_id}?deleteFiles=${deleteFiles}`, { method: "DELETE", headers: { "X-Api-Key": sKey } }); } catch {}
      }
      if (request.radarr_id && rUrl) {
        try { await fetch(`${rUrl}/api/v3/movie/${request.radarr_id}?deleteFiles=${deleteFiles}`, { method: "DELETE", headers: { "X-Api-Key": rKey } }); } catch {}
      }

      db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
      console.log(`[Delete] Deleted request #${id}: ${request.title} (deleteFiles=${deleteFiles})`);
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
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);

      let destPath = "";
      let inLibrary = false;
      const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);
      if (request?.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const movieFolder = movie.path || movie.movieFile?.folderPath || movie.folderPath || "";
          if (movieFolder && fs.existsSync(movieFolder)) {
            for (const f of fs.readdirSync(movieFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const fPath = path.join(movieFolder, f);
              try {
                const st = fs.statSync(fPath);
                if ((contentInodes.size > 0 && contentInodes.has(st.ino)) || contentNames.has(f)) {
                  destPath = fPath;
                  inLibrary = true;
                  break;
                }
              } catch {}
            }
          }
          if (!destPath && movieFolder) destPath = movieFolder;
        } catch {
          // ignore
        }
      } else if (request?.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title);
          const seasonFolder = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const fPath = path.join(seasonFolder, f);
              try {
                const st = fs.statSync(fPath);
                if ((contentInodes.size > 0 && contentInodes.has(st.ino)) || contentNames.has(f)) {
                  destPath = fPath;
                  inLibrary = true;
                  break;
                }
              } catch {}
            }
          }
          if (!destPath && seasonFolder) destPath = seasonFolder;
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
        save_path: fromQBittorrentPath(torrent.save_path),
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
      let isSonarr = false;
      let seriesSeasonFolder = "";
      if (request?.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          movieFolderPath = movie.path || movie.folderPath || "";
        } catch {
          // ignore
        }
      } else if (request?.sonarr_id) {
        isSonarr = true;
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title);
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
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);

        let destPath = "";
        let inLibrary = false;

        const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);

        if (isSonarr) {
          // Series: inode match against season folder
          destPath = seriesSeasonFolder;
          if (seriesSeasonFolder && fs.existsSync(seriesSeasonFolder)) {
            for (const f of fs.readdirSync(seriesSeasonFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const fPath = path.join(seriesSeasonFolder, f);
              try {
                if (contentInodes.size > 0 && contentInodes.has(fs.statSync(fPath).ino)) {
                  destPath = fPath;
                  inLibrary = true;
                  break;
                }
              } catch {}
            }
            // Fallback: filename match
            if (!inLibrary) {
              const match = fs.readdirSync(seriesSeasonFolder).find((f: string) => contentNames.has(f));
              if (match) { destPath = path.join(seriesSeasonFolder, match); inLibrary = true; }
            }
          }
        } else {
          // Movie: scan library dir for actual video files, match by inode/filename
          destPath = movieFolderPath ? path.join(movieFolderPath, "") : "";
          if (movieFolderPath && fs.existsSync(movieFolderPath)) {
            for (const f of fs.readdirSync(movieFolderPath)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const fPath = path.join(movieFolderPath, f);
              try {
                const st = fs.statSync(fPath);
                if ((contentInodes.size > 0 && contentInodes.has(st.ino)) || contentNames.has(f)) {
                  destPath = fPath;
                  inLibrary = true;
                  break;
                }
              } catch {}
            }
          }
          if (!destPath && movieFolderPath) destPath = movieFolderPath;
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
          save_path: fromQBittorrentPath(torrent.save_path),
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

  // GET /api/requests/:id/content-info - Scan content path for video files
  router.get("/:id/content-info", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.json({ type: "none", videoFiles: [], hasBdmv: false, needsProcessing: false });
      }

      const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv"]);
      const videoFiles: { name: string; size: number; path: string }[] = [];
      let hasBdmv = false;

      function scanDir(dir: string, depth: number = 0) {
        if (depth > 3) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "BDMV") {
              const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
              if (subEntries.some((e: any) => e.isDirectory() && e.name === "STREAM")) hasBdmv = true;
            }
            if (entry.name !== "CERTIFICATE" && entry.name !== "BDMV") scanDir(fullPath, depth + 1);
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTS.has(ext)) {
              const stat = fs.statSync(fullPath);
              videoFiles.push({ name: entry.name, size: stat.size, path: fullPath });
            }
          }
        }
      }

      const stat = fs.statSync(contentPath);
      if (stat.isDirectory()) {
        scanDir(contentPath);
      } else {
        const ext = path.extname(contentPath).toLowerCase();
        if (VIDEO_EXTS.has(ext)) {
          videoFiles.push({ name: path.basename(contentPath), size: stat.size, path: contentPath });
        }
      }

      let type: "video" | "bluray" | "multi" | "none";
      if (hasBdmv) type = "bluray";
      else if (videoFiles.length === 1) type = "video";
      else if (videoFiles.length > 1) type = "multi";
      else type = "none";

      res.json({
        type,
        videoFiles: videoFiles.map((f) => ({ name: f.name, size: f.size })),
        hasBdmv,
        needsProcessing: hasBdmv || videoFiles.length > 1,
      });
    } catch (error: any) {
      console.error("Error scanning content info:", error);
      res.status(500).json({ error: `Failed to scan content: ${error.message}` });
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
      const { fileName } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      // If fileName is provided, find the processed file and match by inode to library
      if (fileName) {
        const type = request.type === "series" ? "series" : "movie";
        const processedDir = getProcessedDir(type);
        const processedFile = path.join(processedDir, fileName);

        if (!fs.existsSync(processedFile)) {
          return res.status(404).json({ error: "Processed file not found" });
        }

        const processedIno = fs.statSync(processedFile).ino;

        // Find library folder
        let libraryDir = "";
        if (request.sonarr_id) {
          try {
            const series = await sonarr.getSeries(request.sonarr_id);
            const seasonNum = request.season || 1;
            const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title);
            libraryDir = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
          } catch {}
        } else if (request.radarr_id) {
          try {
            const movie = await radarr.getMovie(request.radarr_id);
            libraryDir = movie.path || movie.folderPath;
          } catch {}
        }

        if (!libraryDir || !fs.existsSync(libraryDir)) {
          return res.status(500).json({ error: "Could not determine library path" });
        }

        // Match by inode, filename, or file size (copies don't share inodes)
        let destPath = "";
        const processedSize = fs.statSync(processedFile).size;
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          const fPath = path.join(libraryDir, f);
          try {
            const st = fs.statSync(fPath);
            if (st.ino === processedIno && st.ino > 0) { destPath = fPath; break; }
          } catch {}
        }
        if (!destPath) {
          const candidate = path.join(libraryDir, fileName);
          if (fs.existsSync(candidate)) destPath = candidate;
        }
        if (!destPath && processedSize > 0) {
          for (const f of fs.readdirSync(libraryDir)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            const fPath = path.join(libraryDir, f);
            try {
              const st = fs.statSync(fPath);
              if (st.size === processedSize) { destPath = fPath; break; }
            } catch {}
          }
        }

        if (!destPath) {
          return res.json({ success: true, message: "File not in library", path: "" });
        }

        fs.rmSync(destPath, { recursive: false, force: true });
        console.log(`[RemoveFromLibrary] Deleted ${destPath}`);
        return res.json({ success: true, message: "Removed from library", path: destPath });
      }

      // Legacy path: remove torrent content from library (no fileName)
      const release = db.prepare(
        "SELECT rc.torrent_hash FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release?.torrent_hash) { console.log(`[RemoveFromLib] No torrent hash for request ${id}`); return res.status(400).json({ error: "No torrent tracked" }); }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) { console.log(`[RemoveFromLib] Torrent ${release.torrent_hash.slice(0,8)} not found in qBittorrent`); return res.status(404).json({ error: "Torrent not found in qBittorrent" }); }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      console.log(`[RemoveFromLib] contentPath=${contentPath} exists=${fs.existsSync(contentPath)} torrentSize=${torrent.size}`);

      let libraryDir = "";

      if (request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title);
          libraryDir = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
        } catch {}
      } else if (request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          libraryDir = movie.path || movie.folderPath;
        } catch {}
      }
      console.log(`[RemoveFromLib] libraryDir=${libraryDir} exists=${libraryDir ? fs.existsSync(libraryDir) : false}`);

      if (!libraryDir || !fs.existsSync(libraryDir)) {
        return res.status(500).json({ error: "Could not determine library path" });
      }

      // Match by inode, filename, or file size (copies don't share inodes)
      let destPath = "";
      const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);
      console.log(`[RemoveFromLib] contentInodes=${[...contentInodes].join(",")}`);
      for (const f of fs.readdirSync(libraryDir)) {
        if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
        const fPath = path.join(libraryDir, f);
        try {
          const st = fs.statSync(fPath);
          if (contentInodes.size > 0 && contentInodes.has(st.ino)) { destPath = fPath; break; }
        } catch {}
      }
      if (!destPath) {
        const match = fs.readdirSync(libraryDir).find((f: string) => contentNames.has(f));
        if (match) destPath = path.join(libraryDir, match);
      }
      if (!destPath && torrent.size > 0) {
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          const fPath = path.join(libraryDir, f);
          try {
            const st = fs.statSync(fPath);
            if (st.size === torrent.size) { destPath = fPath; break; }
          } catch {}
        }
      }

      // Fallback: scan processed dir for files matching request title, use their sizes
      if (!destPath) {
        const procDirs = [
          path.join(process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy"),
          path.join(process.env.PROCESSED_TV || "/media/Torrents/processed/serialy"),
        ];
        for (const procDir of procDirs) {
          if (!fs.existsSync(procDir)) continue;
          for (const f of fs.readdirSync(procDir)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            if (!titlesMatch(request.title, f)) continue;
            const fPath = path.join(procDir, f);
            try {
              const procSize = fs.statSync(fPath).size;
              if (procSize > 0) {
                for (const lf of fs.readdirSync(libraryDir)) {
                  if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(lf)) continue;
                  const lfPath = path.join(libraryDir, lf);
                  try {
                    if (fs.statSync(lfPath).size === procSize) { destPath = lfPath; break; }
                  } catch {}
                }
              }
              if (destPath) break;
            } catch {}
          }
          if (destPath) break;
        }
      }

      // Last resort: any video file in the library dir (user wants it gone from library)
      if (!destPath) {
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          destPath = path.join(libraryDir, f);
          break;
        }
      }

      if (!destPath) {
        console.log(`[RemoveFromLib] No match in ${libraryDir} (contentInodes=${contentInodes.size}, torrentSize=${torrent.size})`);
        const libFiles = fs.readdirSync(libraryDir).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)).map((f: string) => {
          try { const s = fs.statSync(path.join(libraryDir, f)); return `${f} size=${s.size} ino=${s.ino}`; } catch { return f; }
        });
        console.log(`[RemoveFromLib] Library files: ${libFiles.join(", ") || "(empty)"}`);
        return res.json({ success: true, message: "File not in library", path: "" });
      }

      fs.rmSync(destPath, { recursive: false, force: true });
      console.log(`[RemoveFromLib] Deleted ${destPath}`);
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
      const { releaseId } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
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

  // GET /api/requests/:id/move-status - Detect existing hardlinks in processed/workspace
  router.get("/:id/move-status", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const releases = db.prepare(
        "SELECT rc.id, rc.torrent_hash FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).all(id) as any[];

      const results: Record<number, { source?: string; destination?: string; inWorkspace?: boolean; workspaceIndex?: number; processedOutputs?: string[] } | null> = {};
      const type = request.type === "series" ? "series" : "movie";
      const processedDir = type === "movie" ? (process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy") : (process.env.PROCESSED_TV || "/media/Torrents/processed/serialy");
      const workspaceBase = process.env.PROCESSING_WORKSPACE || "/media/Torrents/Workspace";

      for (const rel of releases) {
        if (!rel.torrent_hash) { results[rel.id] = null; continue; }
        const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
        if (!torrent) { results[rel.id] = null; continue; }

        let contentPath = torrent.content_path;
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
        if (!fs.existsSync(contentPath)) { results[rel.id] = null; continue; }

        const basename = path.basename(contentPath);

        const processedPath = path.join(processedDir, basename);
        if (fs.existsSync(processedPath)) {
          try {
            const contentStat = fs.statSync(contentPath);
            const processedStat = fs.statSync(processedPath);
            if (contentStat.ino === processedStat.ino && contentStat.dev === processedStat.dev) {
              results[rel.id] = { source: contentPath, destination: processedPath };
              continue;
            }
          } catch {}
        }

        const wsDirs = listWorkspaces(request.id, request.title);
        let foundInWorkspace = false;
        for (const ws of wsDirs) {
          const wsInput = path.join(ws.path, "inputs", basename);
          if (fs.existsSync(wsInput)) {
            try {
              const contentStat = fs.statSync(contentPath);
              const wsInputStat = fs.statSync(wsInput);
              if (contentStat.isDirectory() || (contentStat.ino === wsInputStat.ino && contentStat.dev === wsInputStat.dev)) {
                results[rel.id] = { source: contentPath, destination: wsInput, inWorkspace: true, workspaceIndex: ws.index };
                foundInWorkspace = true;
                break;
              }
            } catch {}
          }
        }

        if (!foundInWorkspace && !results[rel.id]) {
          const processedOutputs: string[] = [];
          for (const ws of wsDirs) {
            if (ws.metadata?.outputPaths) {
              for (const op of ws.metadata.outputPaths) {
                if (fs.existsSync(op) && path.basename(op) === basename) processedOutputs.push(op);
              }
            }
          }
          if (processedOutputs.length > 0) {
            results[rel.id] = { source: contentPath, destination: processedOutputs[0], processedOutputs };
          } else if (fs.existsSync(processedPath)) {
            results[rel.id] = { source: contentPath, destination: processedPath, processedOutputs: [processedPath] };
          } else {
            results[rel.id] = null;
          }
        }
      }

      res.json({ moves: results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/:id/processed - List processed files for this specific request
  router.get("/:id/processed", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);

      if (!fs.existsSync(processedDir)) return res.json({ files: [] });

      // Get approved releases for this request to match by content basename
      const releases = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).all(id) as any[];

      const matchedNames = new Set<string>();
      for (const rel of releases) {
        if (!rel.torrent_hash) continue;
        try {
          const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
          if (torrent) {
            matchedNames.add(path.basename(torrent.content_path));
          }
        } catch {}
      }

      const wsDirs = listWorkspaces(request.id, request.title);
      for (const ws of wsDirs) {
        if (ws.metadata?.outputPaths) {
          for (const op of ws.metadata.outputPaths) {
            if (fs.existsSync(op)) matchedNames.add(path.basename(op));
          }
        }
      }

      const approvals = db.prepare(
        "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
      ).all(id) as any[];
      for (const ah of approvals) {
        try {
          const names = JSON.parse(ah.processed_files);
          for (const n of names) matchedNames.add(n);
        } catch {}
      }

      // Fallback: scan the season-specific folder when no explicit associations
      if (matchedNames.size === 0 && request.sonarr_id != null && request.type === 'series') {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const fTitle = series.title;
          const seasonFolder = path.join(processedDir, fTitle, `S${String(request.season).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                matchedNames.add(f);
                matchedNames.add(path.join(fTitle, `S${String(request.season).padStart(2, "0")}`, f));
              }
            }
          }
        } catch {}
      }

      // Determine library files for per-file in-library checks — match by inode (hardlinks share inode)
      const libraryInodes = new Set<number>();
      const libraryNameByInode = new Map<number, string>();
      const libraryFiles = new Set<string>();
      const librarySizes = new Map<number, string>();
      if (request.type === "series" && request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seasonFolder = path.join(
            series.path || path.join(process.env.MEDIA_TV || "/media/Serialy", series.title),
            `S${String(seasonNum).padStart(2, "0")}`
          );
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(path.join(seasonFolder, f));
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, f);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, f);
                } catch {}
              }
            }
          }
        } catch {}
      } else if (request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const movieFolder = movie.path || movie.folderPath;
          if (movieFolder && fs.existsSync(movieFolder)) {
            for (const f of fs.readdirSync(movieFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(path.join(movieFolder, f));
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, f);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, f);
                } catch {}
              }
            }
          }
        } catch {}
      }

      const requestTitleNorm = (request.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

      // Collect all files from processedDir — flat or nested (series use SeriesName/S##/ structure)
      type ProcessedEntry = { name: string; relPath: string; fullPath: string; isDir: boolean };
      const allEntries: ProcessedEntry[] = [];
      for (const entry of fs.readdirSync(processedDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(processedDir, entry.name);
        if (entry.isDirectory()) {
          // Series subfolder — scan for season subdirs and video files
          for (const sub of fs.readdirSync(fullPath, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            if (!/^S\d+$/i.test(sub.name)) continue;
            const seasonDir = path.join(fullPath, sub.name);
            for (const f of fs.readdirSync(seasonDir)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              allEntries.push({ name: f, relPath: path.join(entry.name, sub.name, f), fullPath: path.join(seasonDir, f), isDir: false });
            }
          }
          // Also check if the dir itself is a workspace or other relevant dir
          allEntries.push({ name: entry.name, relPath: entry.name, fullPath, isDir: true });
        } else {
          allEntries.push({ name: entry.name, relPath: entry.name, fullPath, isDir: false });
        }
      }

      const files: { name: string; size: number; isDir: boolean; inLibrary: boolean; libraryPath: string }[] = [];
      const hasExplicitAssociations = matchedNames.size > 0;

      for (const e of allEntries) {
        // Match by: exact name in matchedNames, relative path in matchedNames
        if (!matchedNames.has(e.name) && !matchedNames.has(e.relPath)) {
          // Title-match fallback ONLY when request has zero explicit associations
          // (avoids sequel bleed like NeverEnding Story I matching II and III files)
          if (!hasExplicitAssociations) {
            const entryNorm = e.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (!titlesMatch(requestTitleNorm, entryNorm)) continue;
          } else {
            continue;
          }
        }
        const fullPath = e.fullPath;
        let size = 0;
        let ino = 0;
        try {
          const st = fs.statSync(fullPath);
          size = st.size;
          ino = st.ino;
        } catch {}
        const inLibrary = (ino > 0 && libraryInodes.has(ino))
          || libraryFiles.has(e.name)
          || (e.isDir && [...libraryFiles].some((lf) => lf.startsWith(e.name)))
          || (size > 0 && librarySizes.has(size));
        let libraryMatch = "";
        if (inLibrary) {
          libraryMatch = libraryNameByInode.get(ino) || [...libraryFiles].find((lf) => lf === e.name || lf.startsWith(e.name)) || librarySizes.get(size) || "";
        }
        files.push({ name: e.relPath, size, isDir: e.isDir, inLibrary, libraryPath: libraryMatch });
      }

      res.json({ files, processedDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/scan - Return unlinked files in processed dir (exclude files already matched to other requests)
  // For movies with radarr_id, also imports from Radarr library into processed first
  router.post("/:id/processed/scan", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      // For movie requests with radarr_id, try to import from Radarr library first
      if (request.type === "movie" && request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const processedDir2 = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
          const imported: string[] = [];
          const filePath = movie.movieFile?.path;
          if (filePath && fs.existsSync(filePath)) {
            const fileName = path.basename(filePath);
            const destPath = path.join(processedDir2, fileName);
            const srcIno = (() => { try { return fs.statSync(filePath).ino; } catch { return 0; } })();
            let already = false;
            if (srcIno > 0) {
              for (const existing of fs.readdirSync(processedDir2)) {
                try { if (fs.statSync(path.join(processedDir2, existing)).ino === srcIno) { already = true; break; } } catch {}
              }
            } else if (fs.existsSync(destPath)) { already = true; }
            if (!already) {
              fs.linkSync(filePath, destPath);
              imported.push(fileName);
            }
          }
          const movieFolder = movie.path || path.dirname(filePath || "");
          if (fs.existsSync(movieFolder)) {
            for (const entry of fs.readdirSync(movieFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
              if (entry === path.basename(filePath || "")) continue;
              const extraPath = path.join(movieFolder, entry);
              const extraDest = path.join(processedDir2, entry);
              const extraIno = (() => { try { return fs.statSync(extraPath).ino; } catch { return 0; } })();
              let alreadyExtra = false;
              if (extraIno > 0) {
                for (const existing of fs.readdirSync(processedDir2)) {
                  try { if (fs.statSync(path.join(processedDir2, existing)).ino === extraIno) { alreadyExtra = true; break; } } catch {}
                }
              } else if (fs.existsSync(extraDest)) { alreadyExtra = true; }
              if (!alreadyExtra) {
                try { fs.linkSync(extraPath, extraDest); imported.push(entry); } catch {}
              }
            }
          }
          if (imported.length > 0) {
            if (request.status !== 'COMPLETED' && request.status !== 'DOWNLOADING' && request.status !== 'SEEDING') {
              db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(request.id);
            }
            const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(request.id) as any;
            if (ah) {
              const existing = JSON.parse(ah.processed_files || "[]");
              for (const f of imported) { if (!existing.includes(f)) existing.push(f); }
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
            } else {
              db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(request.id, JSON.stringify(imported));
            }
          }
        } catch {}
      }

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      if (!fs.existsSync(processedDir)) return res.json({ files: [] });

      // Collect names already matched to OTHER requests
      const otherNames = new Set<string>();
      const otherRequests = db.prepare("SELECT id, type FROM media_requests WHERE id != ?").all(id) as any[];
      for (const other of otherRequests) {
        const otherType = other.type === "series" ? "series" : "movie";
        if (otherType !== type) continue;
        const rels = db.prepare(
          "SELECT rc.* FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(other.id) as any[];
        for (const rel of rels) {
          if (!rel.torrent_hash) continue;
          try {
            const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
            if (torrent) otherNames.add(path.basename(torrent.content_path));
          } catch {}
        }
        const otherApprovals = db.prepare(
          "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
        ).all(other.id) as any[];
        for (const ah of otherApprovals) {
          try {
            const names = JSON.parse(ah.processed_files);
            for (const n of names) otherNames.add(n);
          } catch {}
        }
      }

      const entries = fs.readdirSync(processedDir, { withFileTypes: true });
      const files: { name: string; size: number; isDir: boolean }[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (otherNames.has(entry.name)) continue;
        const fullPath = path.join(processedDir, entry.name);
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch {}
        files.push({ name: entry.name, size, isDir: entry.isDirectory() });
      }

      res.json({ files, processedDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/associate - Associate processed file(s) with this request
  router.post("/:id/processed/associate", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { fileNames } = req.body || {};
      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return res.status(400).json({ error: "fileNames array required" });
      }

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      // Collect all already-associated filenames across ALL AH rows for this request
      const allExisting = new Set<string>();
      const allAh = db.prepare("SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(id) as any[];
      for (const ah of allAh) {
        try { JSON.parse(ah.processed_files).forEach((f: string) => allExisting.add(f)); } catch {}
      }

      // Filter out filenames already associated
      const newNames = fileNames.filter((f: string) => !allExisting.has(f));
      if (newNames.length === 0) return res.json({ success: true, message: "Already associated" });

      // Use or create an AH row with release_id IS NULL (library import row)
      const approval = db.prepare(
        "SELECT ah.id, ah.processed_files FROM approval_history ah WHERE ah.request_id = ? AND ah.release_id IS NULL ORDER BY ah.approved_at DESC LIMIT 1"
      ).get(id) as any;

      if (approval) {
        const existing = JSON.parse(approval.processed_files || "[]");
        const merged = [...new Set([...existing, ...newNames])];
        db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(merged), approval.id);
        res.json({ success: true });
      } else {
        const ahId = db.prepare(
          "INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)"
        ).run(id, JSON.stringify(newNames)).lastInsertRowid;
        res.json({ success: true, approvalId: ahId });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/processed/:fileName - Delete a processed file from disk and DB
  router.delete("/:id/processed/:fileName", (req: Request, res: Response) => {
    try {
      const { id, fileName } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const decoded = decodeURIComponent(fileName);
      const filePath = path.join(processedDir, decoded);

      if (!filePath.startsWith(processedDir)) {
        return res.status(400).json({ error: "Invalid path" });
      }

      // Remove from processed_files arrays in ALL AH rows for this request
      const allAh = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(id) as any[];
      for (const ah of allAh) {
        try {
          const arr = JSON.parse(ah.processed_files);
          const filtered = arr.filter((f: string) => f !== decoded);
          if (filtered.length !== arr.length) {
            db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(filtered), ah.id);
          }
        } catch {}
      }

      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
      console.log(`[Processed] Deleted ${filePath}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/:fileName/to-workspace - Hardlink a processed file to workspace
  router.post("/:id/processed/:fileName/to-workspace", async (req: Request, res: Response) => {
    try {
      const { id, fileName } = req.params;
      const { name, notes, scripts, workspaceIndex } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const filePath = path.join(processedDir, decodeURIComponent(fileName));

      if (!filePath.startsWith(processedDir)) {
        return res.status(400).json({ error: "Invalid path" });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found in processed" });
      }

      const wsConfig: any = {};
      if (name) wsConfig.name = name;
      if (notes) wsConfig.notes = notes;
      if (scripts) wsConfig.scripts = scripts;

      const result = moveToWorkspaceSync(filePath, request.id, request.title, workspaceIndex, undefined, undefined, Object.keys(wsConfig).length > 0 ? wsConfig : undefined);
      if (!result.success) return res.status(500).json({ error: result.error });

      console.log(`[ProcessedToWorkspace] ${filePath} → ${result.destination}`);
      res.json({ success: true, source: filePath, destination: result.destination });
    } catch (error: any) {
      console.error("Error moving processed to workspace:", error);
      res.status(500).json({ error: `Failed to move to workspace: ${error.message}` });
    }
  });

  // GET /api/requests/:id/workspaces - List existing workspaces for this request
  router.get("/:id/workspaces", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      const workspaces = listWorkspaces(request.id, request.title);
      res.json({ workspaces });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/requests/:id/workspaces/:index - Update workspace metadata
  router.patch("/:id/workspaces/:index", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const { name, notes, status } = req.body || {};
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;

      writeWorkspaceMetadata(ws.path, updates);
      const updated = readWorkspaceMetadata(ws.path);
      res.json({ success: true, metadata: updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/workspaces/:index/complete - Complete workspace: delete inputs, move outputs to processed
  router.post("/:id/workspaces/:index/complete", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const type = request.type === "series" ? "series" : "movie";
      const result = completeWorkspace(ws.path, type);
      if (!result.success) return res.status(400).json({ error: result.error });

      const outputBasenames = result.processedPaths.map((p) => path.basename(p));

      const approval = db.prepare(
        "SELECT ah.id FROM approval_history ah WHERE ah.request_id = ? ORDER BY ah.approved_at DESC LIMIT 1"
      ).get(id) as any;
      if (approval) {
        const existing = JSON.parse((db.prepare("SELECT processed_files FROM approval_history WHERE id = ?").get(approval.id) as any)?.processed_files || "[]");
        const merged = [...new Set([...existing, ...outputBasenames])];
        db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(merged), approval.id);
      }

      const processedDir = getProcessedDir(type);
      if (type === "movie" && request.radarr_id) {
        radarr.scanDownloadedMovie(processedDir, request.radarr_id).catch(() => {});
      } else if (type === "series" && request.sonarr_id) {
        sonarr.scanDownloadedEpisodes(processedDir, request.sonarr_id).catch(() => {});
      }

      console.log(`[Workspace] Completed ${ws.dirName}: inputs removed, ${result.processedPaths.length} output(s) moved to processed`);
      res.json({ success: true, processedPaths: result.processedPaths });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/workspaces/:index/clean - Delete inputs only (keep outputs)
  router.post("/:id/workspaces/:index/clean", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const count = deleteWorkspaceInputs(ws.path);
      console.log(`[Workspace] Cleaned ${count} input(s) from ${ws.dirName}`);
      res.json({ success: true, deleted: count });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/workspaces/:index/file/:subDir/:fileName - Delete a single file from workspace
  router.delete("/:id/workspaces/:index/file/:subDir/:fileName", async (req: Request, res: Response) => {
    try {
      const { id, index, subDir, fileName } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (subDir !== "inputs" && subDir !== "output") return res.status(400).json({ error: "subDir must be 'inputs' or 'output'" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const deleted = deleteWorkspaceFile(ws.path, subDir, decodeURIComponent(fileName));
      if (!deleted) return res.status(404).json({ error: "File not found" });

      console.log(`[Workspace] Deleted ${subDir}/${decodeURIComponent(fileName)} from ${ws.dirName}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/workspaces/:index - Delete entire workspace
  router.delete("/:id/workspaces/:index", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      deleteWorkspace(ws.path);
      console.log(`[Workspace] Deleted entire workspace ${ws.dirName}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/move-to-workspace - Hardlink files from download folder to workspace for manual preprocessing
  router.post("/:id/move-to-workspace", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { releaseId, name, notes, scripts } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      const wsConfig: any = {};
      if (name) wsConfig.name = name;
      if (notes) wsConfig.notes = notes;
      if (scripts) wsConfig.scripts = scripts;

      const result = moveToWorkspaceSync(contentPath, request.id, request.title, req.body?.workspaceIndex, release.id, release.torrent_hash, Object.keys(wsConfig).length > 0 ? wsConfig : undefined);
      if (!result.success) return res.status(500).json({ error: result.error });

      console.log(`[MoveToWorkspace] ${contentPath} → ${result.destination}`);
      res.json({ success: true, source: contentPath, destination: result.destination });
    } catch (error: any) {
      console.error("Error moving to workspace:", error);
      res.status(500).json({ error: `Failed to move to workspace: ${error.message}` });
    }
  });

  // POST /api/requests/:id/move-to-library - Hardlink files from processed folder to library
  router.post("/:id/move-to-library", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { fileName } = req.body as { fileName?: string };
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);

      let sourcePath = "";
      let destFolder = "";

      if (fileName) {
        // Direct file lookup in processed dir — used by processed panel
        sourcePath = path.join(processedDir, fileName);
        if (!fs.existsSync(sourcePath)) {
          return res.status(404).json({ error: `Processed file not found: ${fileName}` });
        }
      } else {
        // TorrentPanel: hardlink directly from download content to library (no processed entry)
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
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
        if (!fs.existsSync(contentPath)) {
          return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
        }

        sourcePath = contentPath;
      }

      if (request.type === "series" && request.sonarr_id) {
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
        const movie = await radarr.getMovie(request.radarr_id);
        destFolder = movie.path || movie.folderPath;
        if (!destFolder) {
          return res.status(500).json({ error: "Could not determine movie folder from Radarr" });
        }
      } else {
        return res.status(400).json({ error: "No Radarr or Sonarr ID associated" });
      }

      const destFileName = path.basename(sourcePath);
      const destPath = path.join(destFolder, destFileName);

      if (fs.existsSync(destPath)) {
        return res.json({ success: true, message: "File already exists in library", source: sourcePath, destination: destPath, alreadyExists: true });
      }

      // Check if any file in library folder has the same inode (already there, possibly renamed)
      try {
        const srcStat = fs.statSync(sourcePath);
        if (srcStat.ino > 0) {
          const libFiles = fs.readdirSync(destFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv|bdmv)$/i.test(f));
          for (const lf of libFiles) {
            try {
              const lfStat = fs.statSync(path.join(destFolder, lf));
              if (lfStat.ino === srcStat.ino && lfStat.ino > 0) {
                return res.json({ success: true, message: "File already in library", source: sourcePath, destination: path.join(destFolder, lf), alreadyExists: true });
              }
            } catch {}
          }
          // Also check BDMV directories
          for (const lf of libFiles) {
            if (lf === "BDMV") {
              try {
                const bdPath = path.join(destFolder, lf);
                const bdStat = fs.statSync(bdPath);
                if (bdStat.ino === srcStat.ino && bdStat.ino > 0) {
                  return res.json({ success: true, message: "File already in library", source: sourcePath, destination: path.join(destFolder, lf), alreadyExists: true });
                }
              } catch {}
            }
          }
        }
      } catch {}

      const stat = fs.statSync(sourcePath);

      // Let Radarr/Sonarr handle the file placement + rename
      let importResult = { success: false, error: "" };
      if (request.type === "series" && request.sonarr_id) {
        importResult = await sonarr.manualImport(sourcePath, request.sonarr_id, request.season || 1) as any;
      } else if (request.radarr_id) {
        importResult = await radarr.manualImport(sourcePath, request.radarr_id) as any;
      }

      if (!importResult.success) {
        // Fallback: hardlink ourselves
        console.log(`[MoveToLibrary] Manual import failed, falling back to hardlink`);
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
      }

      const finalDest = importResult.success ? sourcePath : destPath;
      const method = importResult.success ? "imported via Radarr/Sonarr" : (fs.existsSync(destPath) && fs.statSync(destPath).nlink > 1 ? "hardlinked" : "copied");
      console.log(`[MoveToLibrary] ${method} ${sourcePath}`);

      res.json({ success: true, message: `Files ${method} to library`, source: sourcePath, destination: finalDest });
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
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
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
              ? process.env.MEDIA_MOVIES || "/media/Filmy"
              : process.env.MEDIA_TV || "/media/Serialy";
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

  // POST /api/requests/:id/import - Import a .torrent file or magnet link
  router.post("/:id/import", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { magnetUrl, torrentFileBase64, torrentFilename, bypassApproval } = req.body || {};

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (!magnetUrl && !torrentFileBase64) {
        return res.status(400).json({ error: "Provide magnetUrl or torrentFileBase64" });
      }

      const type = request.type === "series" ? "series" : "movie";
      const downloadDir = type === "series"
        ? (process.env.DOWNLOADS_TV || "/media/Torrents/download/serialy")
        : (process.env.DOWNLOADS_MOVIES || "/media/Torrents/download/filmy");
      const qbitSavePath = toQBittorrentPath(downloadDir);

      // Snapshot existing qBittorrent hashes before adding
      const preHashes = new Set((await qbittorrent.getTorrents()).map((t) => t.hash));

      let addedTitle = "";
      let addedHash = "";

      if (magnetUrl) {
        await qbittorrent.addTorrent(magnetUrl, qbitSavePath);
        addedTitle = request.title || "Imported";
      } else if (torrentFileBase64) {
        const buf = Buffer.from(torrentFileBase64, "base64");
        const filename = torrentFilename || "imported.torrent";
        await qbittorrent.addTorrentFile(buf, filename, qbitSavePath);
        addedTitle = filename.replace(/\.torrent$/i, "") || request.title || "Imported";
      }

      // Poll qBittorrent up to 10 times, 3s apart, to find the new torrent
      let newTorrent = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const torrents = await qbittorrent.getTorrents();
        newTorrent = torrents.find((t) => !preHashes.has(t.hash)) || null;
        if (newTorrent) break;
      }

      if (newTorrent) {
        addedHash = newTorrent.hash;
        addedTitle = newTorrent.name || addedTitle;
        newTorrent.content_path = fromQBittorrentPath(newTorrent.content_path);
        newTorrent.save_path = fromQBittorrentPath(newTorrent.save_path);
      }

      // Create release_candidate
      const radarrReleaseId = addedHash || `imported-${Date.now()}`;
      let releaseId: number;

      const existing = db.prepare(
        "SELECT id FROM release_candidates WHERE request_id = ? AND radarr_release_id = ?"
      ).get(id, radarrReleaseId) as any;

      if (existing) {
        releaseId = existing.id;
        db.prepare(`
          UPDATE release_candidates SET title = ?, torrent_hash = ?, save_path = ?, size_mb = ?
          WHERE id = ?
        `).run(addedTitle, addedHash, newTorrent?.save_path || downloadDir,
          newTorrent ? Math.round(newTorrent.size / (1024 * 1024)) : 0, releaseId);
      } else {
        const rcResult = db.prepare(`
          INSERT INTO release_candidates
          (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, protocol, info_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          radarrReleaseId,
          addedTitle,
          "imported",
          newTorrent ? Math.round(newTorrent.size / (1024 * 1024)) : 0,
          addedHash,
          newTorrent?.save_path || downloadDir,
          "",
          "torrent",
          magnetUrl || "",
        );
        releaseId = Number(rcResult.lastInsertRowid);
      }

      if (bypassApproval) {
        db.prepare(`
          INSERT INTO approval_history (request_id, release_id, approved_by, approval_reason)
          VALUES (?, ?, ?, ?)
        `).run(id, releaseId, "web-user", "imported");
        db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run("DOWNLOADING", id);
      }

      console.log(`[Import] ${addedTitle} (${addedHash || "pending"}) → request #${id} (bypass=${!!bypassApproval})`);
      res.json({ success: true, releaseId, title: addedTitle, hash: addedHash });
    } catch (error: any) {
      console.error("Error importing torrent:", error);
      res.status(500).json({ error: error.message || "Failed to import torrent" });
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
