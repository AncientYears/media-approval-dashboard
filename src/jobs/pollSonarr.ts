import { Database } from "better-sqlite3";
import { SonarrService } from "../services/sonarr";
import { computeAppScore } from "../services/scoring";

export function createSonarrPoller(db: Database, sonarr: SonarrService, intervalSeconds: number) {
  let running = false;

  async function searchForRequest(requestId: number, seriesId: number, seasonNumber: number, title: string, insertReleaseStmt: any, awaitingStmt: any, searchStmt: any) {
    searchStmt.run(requestId);

    try {
      const releases = await sonarr.searchReleases(seriesId, seasonNumber);

      if (releases.length === 0) {
        console.log(`[Sonarr] No releases found for ${title}`);
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
      console.log(`[Sonarr] ${releases.length} releases for ${title}`);
    } catch (err) {
      console.error(`[Sonarr] Failed to search releases for ${title}:`, err);
    }
  }

  async function poll() {
    if (running) return;
    running = true;

    try {
      const wantedSeasons = await sonarr.getWantedMissing();
      const wantedKeys = new Set(wantedSeasons.map((w) => `${w.seriesId}-${w.seasonNumber}`));

      console.log(`[Sonarr] Found ${wantedSeasons.length} wanted seasons`);

      // Auto-dismiss requests whose sonarr_id+season is no longer in wanted list
      const staleRequests = db.prepare(
        "SELECT id, title, sonarr_id, season FROM media_requests " +
        "WHERE sonarr_id IS NOT NULL AND type = 'series' AND status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL')"
      ).all() as any[];
      for (const req of staleRequests) {
        if (!wantedKeys.has(`${req.sonarr_id}-${req.season}`)) {
          console.log(`[Sonarr] Auto-dismissing ${req.title} (sonarr_id=${req.sonarr_id} season=${req.season} no longer wanted)`);
          db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
        }
      }

      // Also dismiss orphaned requests with no sonarr_id and no approved releases
      const orphans = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.sonarr_id IS NULL AND mr.type = 'series' AND mr.status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL') " +
        "AND NOT EXISTS (SELECT 1 FROM approval_history ah WHERE ah.request_id = mr.id)"
      ).all() as any[];
      for (const req of orphans) {
        console.log(`[Sonarr] Auto-dismissing orphan ${req.title} (no sonarr_id, no releases)`);
        db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
      }

      // Dismiss requests stuck in AWAITING_APPROVAL with zero releases (stale/empty)
      const empty = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.type = 'series' AND mr.status = 'AWAITING_APPROVAL' " +
        "AND NOT EXISTS (SELECT 1 FROM release_candidates rc WHERE rc.request_id = mr.id)"
      ).all() as any[];
      for (const req of empty) {
        console.log(`[Sonarr] Auto-dismissing empty request ${req.title} (AWAITING_APPROVAL but no releases)`);
        db.prepare("UPDATE media_requests SET status = 'DISMISSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
      }

      const existingStmt = db.prepare(
        `SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ? AND type = 'series'`
      );
      const insertStmt = db.prepare(`
        INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by)
        VALUES (?, 'series', ?, ?, 'NEW', '[]')
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
        SELECT mr.id, mr.sonarr_id, mr.season, mr.title FROM media_requests mr
        LEFT JOIN release_candidates rc ON rc.request_id = mr.id
        WHERE mr.sonarr_id IS NOT NULL AND mr.type = 'series' AND mr.status = 'SEARCHING' AND rc.id IS NULL
      `);

      for (const season of wantedSeasons) {
        const existing = existingStmt.get(season.seriesId, season.seasonNumber) as any;
        const requestTitle = season.seasonNumber === 0
          ? `${season.title} - Specials`
          : `${season.title} S${String(season.seasonNumber).padStart(2, "0")}`;

        if (existing) {
          // If request was dismissed/rejected but series is back in wanted list, re-activate it
          if (existing.status === "DISMISSED" || existing.status === "REJECTED") {
            console.log(`[Sonarr] Re-activating ${requestTitle} (was ${existing.status}, back in wanted list)`);
            db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
            await searchForRequest(existing.id, season.seriesId, season.seasonNumber, requestTitle, insertReleaseStmt, awaitingStmt, searchStmt);
            continue;
          }

          if (existing.status === "SEARCHING" || existing.status === "NEW" || existing.status === "AWAITING_APPROVAL") {
            const hasReleases = db.prepare("SELECT 1 FROM release_candidates WHERE request_id = ? LIMIT 1").get(existing.id);
            if (!hasReleases || existing.status === "SEARCHING" || existing.status === "NEW") {
              console.log(`[Sonarr] Retrying search for ${requestTitle} (status=${existing.status}, releases=${!!hasReleases})`);
              await searchForRequest(existing.id, season.seriesId, season.seasonNumber, requestTitle, insertReleaseStmt, awaitingStmt, searchStmt);
            }
          }
          continue;
        }

        const result = insertStmt.run(requestTitle, season.seriesId, season.seasonNumber);
        const requestId = result.lastInsertRowid as number;

        console.log(`[Sonarr] New request: ${requestTitle} (sonarr_id=${season.seriesId}, season=${season.seasonNumber})`);

        await searchForRequest(requestId, season.seriesId, season.seasonNumber, requestTitle, insertReleaseStmt, awaitingStmt, searchStmt);
      }

      // Also retry any stuck SEARCHING requests with no releases
      const stuck = stuckStmt.all() as any[];
      for (const req of stuck) {
        const stillWanted = wantedSeasons.find((w) => w.seriesId === req.sonarr_id && w.seasonNumber === req.season);
        if (stillWanted) continue;

        console.log(`[Sonarr] Retrying stuck request: ${req.title}`);
        await searchForRequest(req.id, req.sonarr_id, req.season, req.title, insertReleaseStmt, awaitingStmt, searchStmt);
      }
    } catch (err) {
      console.error("[Sonarr] Poll error:", err);
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
