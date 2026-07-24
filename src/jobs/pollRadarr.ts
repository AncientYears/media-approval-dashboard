import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { computeAppScore } from "../services/scoring";

export function createRadarrPoller(db: Database, radarr: RadarrService, intervalSeconds: number) {
  let running = false;

  async function searchForRequest(requestId: number, movieId: number, title: string, insertReleaseStmt: any, awaitingStmt: any, searchStmt: any) {
    searchStmt.run(requestId);

    try {
      const releases = await radarr.searchReleases(movieId);

      if (releases.length === 0) {
        console.log(`[Radarr] No releases found for ${title}`);
        return;
      }

      for (let i = 0; i < releases.length; i++) {
        const r = releases[i];
        const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
        const qualityName = r.quality?.quality?.name || "Unknown";
        const cfNames = r.customFormats?.map((f: any) => f.name) || [];
        const customFormats = JSON.stringify(cfNames);
        const appScore = computeAppScore(qualityName, cfNames, sizeMb, i + 1);
        const language = r.languages?.map((l: any) => l.name).join(", ") || r.language?.name || "";

        insertReleaseStmt.run(
          requestId,
          r.guid,
          r.title,
          r.indexer,
          sizeMb,
          qualityName,
          customFormats,
          appScore,
          i + 1,
          language,
          r.infoUrl || "",
          r.seeders ?? null,
          r.leechers ?? null,
          r.releaseGroup || "",
          r.edition || "",
          r.protocol || "",
          r.publishDate || "",
          (r as any).indexerId ?? 0
        );
      }

      awaitingStmt.run(requestId);
      console.log(`[Radarr] ${releases.length} releases for ${title}`);
    } catch (err) {
      console.error(`[Radarr] Failed to search releases for ${title}:`, err);
    }
  }

  async function poll() {
    if (running) return;
    running = true;

    try {
      const movies = await radarr.getWantedMovies();
      const wanted = movies.filter((m: any) => !m.hasFile && m.monitored);
      const wantedIds = new Set(wanted.map((m: any) => m.id));

      console.log(`[Radarr] Found ${wanted.length} wanted movies`);

      // Auto-dismiss requests whose radarr_id is no longer in wanted list
      // (user deleted the request from Jellyseerr)
      const staleRequests = db.prepare(
        "SELECT id, title, radarr_id FROM media_requests " +
        "WHERE radarr_id IS NOT NULL AND status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL')"
      ).all() as any[];
      for (const req of staleRequests) {
        if (!wantedIds.has(req.radarr_id)) {
          console.log(`[Radarr] Auto-dismissing ${req.title} (radarr_id=${req.radarr_id} no longer wanted)`);
          db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
        }
      }

      // Also dismiss orphaned requests with no radarr_id and no approved releases
      const orphans = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.radarr_id IS NULL AND mr.status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL') " +
        "AND NOT EXISTS (SELECT 1 FROM approval_history ah WHERE ah.request_id = mr.id)"
      ).all() as any[];
      for (const req of orphans) {
        console.log(`[Radarr] Auto-dismissing orphan ${req.title} (no radarr_id, no releases)`);
        db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
      }

      // Dismiss requests stuck in AWAITING_APPROVAL with zero releases (stale/empty)
      const empty = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.status = 'AWAITING_APPROVAL' " +
        "AND NOT EXISTS (SELECT 1 FROM release_candidates rc WHERE rc.request_id = mr.id)"
      ).all() as any[];
      for (const req of empty) {
        console.log(`[Radarr] Auto-dismissing empty request ${req.title} (AWAITING_APPROVAL but no releases)`);
        db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
      }

      const existingStmt = db.prepare(`SELECT id, status FROM media_requests WHERE radarr_id = ? AND type = 'movie'`);
      const insertStmt = db.prepare(`
        INSERT INTO media_requests (title, type, radarr_id, status, requested_by)
        VALUES (?, 'movie', ?, 'NEW', '[]')
      `);

      const searchStmt = db.prepare(`
        UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `);

      const insertReleaseStmt = db.prepare(`
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

      const awaitingStmt = db.prepare(`
        UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'SEARCHING'
      `);

      const stuckStmt = db.prepare(`
        SELECT mr.id, mr.radarr_id, mr.title FROM media_requests mr
        LEFT JOIN release_candidates rc ON rc.request_id = mr.id
        WHERE mr.radarr_id IS NOT NULL AND mr.status = 'SEARCHING' AND rc.id IS NULL
      `);

      for (const movie of wanted) {
        const existing = existingStmt.get(movie.id) as any;

        if (existing) {
          if (existing.status === "SEARCHING") {
            console.log(`[Radarr] Retrying search for ${movie.title} (no releases yet)`);
            await searchForRequest(existing.id, movie.id, movie.title, insertReleaseStmt, awaitingStmt, searchStmt);
          }
          continue;
        }

        const result = insertStmt.run(movie.title, movie.id);
        const requestId = result.lastInsertRowid as number;

        console.log(`[Radarr] New request: ${movie.title} (radarr_id=${movie.id})`);

        await searchForRequest(requestId, movie.id, movie.title, insertReleaseStmt, awaitingStmt, searchStmt);
      }

      // Also retry any stuck SEARCHING requests with no releases (in case Radarr list changed)
      const stuck = stuckStmt.all() as any[];
      for (const req of stuck) {
        const stillWanted = wanted.find((m: any) => m.id === req.radarr_id);
        if (stillWanted) continue; // Already handled above

        console.log(`[Radarr] Retrying stuck request: ${req.title}`);
        await searchForRequest(req.id, req.radarr_id, req.title, insertReleaseStmt, awaitingStmt, searchStmt);
      }
    } catch (err) {
      console.error("[Radarr] Poll error:", err);
    } finally {
      running = false;
    }
  }

  // Run immediately, then on interval
  poll();
  const timer = setInterval(poll, intervalSeconds * 1000);

  return {
    stop: () => clearInterval(timer),
  };
}
