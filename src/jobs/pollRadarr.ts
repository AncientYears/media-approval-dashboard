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

      // Phase 1: Synchronous DB work — create/update all request rows
      const searchesToRun: Array<{ requestId: number; movieId: number; title: string }> = [];

      for (const movie of wanted) {
        const existing = existingStmt.get(movie.id) as any;

        if (existing) {
          if (existing.status === "SEARCHING" || existing.status === "NEW") {
            const hasReleases = db.prepare("SELECT 1 FROM release_candidates WHERE request_id = ? LIMIT 1").get(existing.id);
            if (!hasReleases) {
              console.log(`[Radarr] Retrying search for ${movie.title} (status=${existing.status}, releases=${!!hasReleases})`);
              searchesToRun.push({ requestId: existing.id, movieId: movie.id, title: movie.title });
            }
          }
          continue;
        }

        const result = insertStmt.run(movie.title, movie.id);
        const requestId = result.lastInsertRowid as number;
        console.log(`[Radarr] New request: ${movie.title} (radarr_id=${movie.id})`);
        searchesToRun.push({ requestId, movieId: movie.id, title: movie.title });
      }

      // Phase 2: Parallel API calls — search all requests simultaneously
      if (searchesToRun.length > 0) {
        console.log(`[Radarr] Searching ${searchesToRun.length} requests in parallel...`);
        await Promise.all(
          searchesToRun.map((s) => searchForRequest(s.requestId, s.movieId, s.title, insertReleaseStmt, awaitingStmt, searchStmt))
        );
        console.log(`[Radarr] All searches complete`);
      }
    } catch (err) {
      console.error("[Radarr] Poll error:", err);
    } finally {
      running = false;
    }
  }

  poll();
  const timer = setInterval(poll, intervalSeconds * 1000);

  return {
    stop: () => clearInterval(timer),
  };
}
