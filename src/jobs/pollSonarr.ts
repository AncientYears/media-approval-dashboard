import { Database } from "better-sqlite3";
import { SonarrService } from "../services/sonarr";

export function createSonarrPoller(db: Database, sonarr: SonarrService, intervalSeconds: number) {
  let running = false;

  async function poll() {
    if (running) return;
    running = true;

    try {
      const wantedSeasons = await sonarr.getWantedMissing();

      const validSeries = await sonarr.getAllSeries();
      const validIds = new Set(validSeries.map((s: any) => s.id));
      const filtered = wantedSeasons.filter((w) => validIds.has(w.seriesId));
      if (filtered.length < wantedSeasons.length) {
        console.log(`[Sonarr] Filtered ${wantedSeasons.length - filtered.length} wanted seasons for deleted series`);
      }

      console.log(`[Sonarr] Found ${filtered.length} wanted seasons`);

      const existingStmt = db.prepare(
        `SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ? AND type = 'series'`
      );
      const insertStmt = db.prepare(`
        INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count)
        VALUES (?, 'series', ?, ?, 'NEW', '[]', ?)
      `);

      for (const season of filtered) {
        const existing = existingStmt.get(season.seriesId, season.seasonNumber) as any;
        const requestTitle = season.seasonNumber === 0
          ? `${season.title} - Specials`
          : `${season.title} S${String(season.seasonNumber).padStart(2, "0")}`;

        if (existing) {
          const hasReleases = db.prepare("SELECT 1 FROM release_candidates WHERE request_id = ? LIMIT 1").get(existing.id);
          if (!hasReleases && existing.status === "SEARCHING") {
            const age = Date.now() - new Date(existing.updated_at + "Z").getTime();
            if (age > intervalSeconds * 2000) {
              db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
              console.log(`[Sonarr] ${requestTitle} stuck in SEARCHING (${Math.round(age/1000)}s) — moved to AWAITING_APPROVAL`);
            }
          }
          continue;
        }

        insertStmt.run(requestTitle, season.seriesId, season.seasonNumber, season.episodeCount || null);
        console.log(`[Sonarr] New request: ${requestTitle} (sonarr_id=${season.seriesId}, season=${season.seasonNumber})`);
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
