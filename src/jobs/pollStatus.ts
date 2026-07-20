import { Database } from "better-sqlite3";
import { QBittorrentService } from "../services/qbittorrent";

const DOWNLOADING_STATES = ["downloading", "forcedDL", "queuedDL", "pausedDL"];
const SEEDING_STATES = ["uploading", "stalledUP", "forcedUP", "queuedUP", "pausedUP"];

export function createStatusPoller(db: Database, qbittorrent: QBittorrentService, intervalSeconds: number) {
  let running = false;

  async function poll() {
    if (running) return;
    running = true;

    try {
      // Get unique requests with torrents
      const requests = db.prepare(
        "SELECT DISTINCT mr.id, mr.title, mr.status FROM media_requests mr " +
        "JOIN approval_history ah ON ah.request_id = mr.id " +
        "JOIN release_candidates rc ON rc.id = ah.release_id " +
        "WHERE mr.status IN ('DOWNLOADING', 'AWAITING_APPROVAL') AND rc.torrent_hash != ''"
      ).all() as any[];

      if (requests.length === 0) return;

      const torrents = await qbittorrent.getTorrents();

      // Get all approved release hashes per request
      const releaseHashes = db.prepare(
        "SELECT ah.request_id, rc.torrent_hash, rc.id as release_id, rc.title as release_title FROM approval_history ah " +
        "JOIN release_candidates rc ON rc.id = ah.release_id WHERE rc.torrent_hash != ''"
      ).all() as any[];

      for (const req of requests) {
        const hashes = releaseHashes.filter((r: any) => r.request_id === req.id);
        if (hashes.length === 0) continue;

        // Find the "worst" state among all torrents for this request
        // If any is still downloading → DOWNLOADING. Only if ALL are seeding → SEEDING.
        let anyFound = false;
        let anyDownloading = false;
        let allSeeding = true;

        for (const h of hashes) {
          const torrent = torrents.find((t) => t.hash === h.torrent_hash);
          if (!torrent) continue;
          anyFound = true;

          // Store found hash if we matched by title earlier
          if (!h.torrent_hash && h.release_title) {
            const normalized = h.release_title.toLowerCase().replace(/[.\-_\[\]]/g, " ");
            const matched = torrents.find((t) => {
              const tn = t.name.toLowerCase().replace(/[.\-_\[\]]/g, " ");
              return tn.includes(normalized) || normalized.includes(tn);
            });
            if (matched) {
              db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                .run(matched.hash, matched.save_path, h.release_id);
            }
          }

          if (DOWNLOADING_STATES.includes(torrent.state)) {
            anyDownloading = true;
            allSeeding = false;
          } else if (!SEEDING_STATES.includes(torrent.state)) {
            allSeeding = false;
          }
        }

        if (!anyFound) continue;

        const prevState = req.status;
        let newState = prevState;

        if (anyDownloading) {
          newState = "DOWNLOADING";
        } else if (allSeeding) {
          newState = "AWAITING_APPROVAL";
        }

        if (newState !== prevState) {
          db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(newState, req.id);
          console.log(`[Status] ${req.title}: ${prevState} → ${newState}`);
        }
      }
    } catch (err) {
      console.error("[Status] Poll error:", err);
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
