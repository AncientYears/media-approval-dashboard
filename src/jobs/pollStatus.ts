import { Database } from "better-sqlite3";
import { QBittorrentService } from "../services/qbittorrent";

const SEEDING_STATES = ["uploading", "stalledUP", "forcedUP", "queuedUP", "pausedUP"];
const DOWNLOADING_STATES = ["downloading", "forcedDL", "queuedDL", "pausedDL"];
const COMPLETED_STATES = ["missingFiles", "error"];

export function createStatusPoller(db: Database, qbittorrent: QBittorrentService, intervalSeconds: number) {
  let running = false;

  async function poll() {
    if (running) return;
    running = true;

    try {
      const active = db.prepare(
        "SELECT mr.id, mr.title, rc.torrent_hash, rc.id as release_id, rc.title as release_title FROM media_requests mr " +
        "JOIN approval_history ah ON ah.request_id = mr.id " +
        "JOIN release_candidates rc ON rc.id = ah.release_id " +
        "WHERE mr.status IN ('DOWNLOADING', 'SEEDING', 'AWAITING_APPROVAL') AND rc.torrent_hash != ''"
      ).all() as any[];

      if (active.length === 0) return;

      const torrents = await qbittorrent.getTorrents();

      for (const req of active) {
        let torrent = null;

        // Try hash first
        if (req.torrent_hash) {
          torrent = torrents.find((t) => t.hash === req.torrent_hash);
        }

        // Fallback: match by title if no hash or hash not found
        if (!torrent && req.release_title) {
          const normalized = req.release_title.toLowerCase().replace(/[.\-_\[\]]/g, " ");
          torrent = torrents.find((t) => {
            const tn = t.name.toLowerCase().replace(/[.\-_\[\]]/g, " ");
            return tn.includes(normalized) || normalized.includes(tn);
          });

          if (torrent) {
            // Store the found hash for next time
            db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
              .run(torrent.hash, torrent.save_path, req.release_id);
            console.log(`[Status] Found torrent by title match for ${req.title}: hash=${torrent.hash}`);
          }
        }

        if (!torrent) continue;

        const prevState = req.status;
        let newState = prevState;

        if (SEEDING_STATES.includes(torrent.state)) {
          newState = "SEEDING";
        } else if (DOWNLOADING_STATES.includes(torrent.state)) {
          newState = "DOWNLOADING";
        } else if (COMPLETED_STATES.includes(torrent.state)) {
          newState = "SEEDING";
        }

        if (newState !== prevState) {
          db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(newState, req.id);
          console.log(`[Status] ${req.title}: ${prevState} → ${newState} (qBittorrent: ${torrent.state})`);
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
