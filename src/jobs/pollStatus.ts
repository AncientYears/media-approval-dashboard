import { Database } from "better-sqlite3";
import { QBittorrentService } from "../services/qbittorrent";

const DOWNLOADING_STATES = ["downloading", "forcedDL", "queuedDL", "pausedDL"];
const SEEDING_STATES = ["uploading", "stalledUP", "forcedUP", "queuedUP", "pausedUP"];

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
}

export function createStatusPoller(db: Database, qbittorrent: QBittorrentService, intervalSeconds: number) {
  let running = false;

  async function poll() {
    if (running) return;
    running = true;

    try {
      const requests = db.prepare(
        "SELECT id, title, status, type FROM media_requests " +
        "WHERE status IN ('DOWNLOADING', 'SEEDING', 'AWAITING_APPROVAL')"
      ).all() as any[];

      if (requests.length === 0) return;

      const torrents = await qbittorrent.getTorrents();
      if (torrents.length === 0) return;

      // Get all release candidates with hashes
      const releaseHashes = db.prepare(
        "SELECT rc.request_id, rc.torrent_hash, rc.id as release_id, rc.title as release_title FROM release_candidates rc " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
      ).all() as any[];

      const requestsWithHashes = new Set(releaseHashes.map((r: any) => r.request_id));

      for (const req of requests) {
        let anyFound = false;
        let anyDownloading = false;
        let allSeeding = true;

        // Path 1: Match via release_candidates with known hashes
        const hashes = releaseHashes.filter((r: any) => r.request_id === req.id);
        for (const h of hashes) {
          let torrent = null;

          if (h.torrent_hash) {
            torrent = torrents.find((t) => t.hash === h.torrent_hash);
          }

          if (!torrent && h.release_title) {
            const norm = normalizeTitle(h.release_title);
            torrent = torrents.find((t) => normalizeTitle(t.name).includes(norm) || norm.includes(normalizeTitle(t.name)));
            if (torrent) {
              db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                .run(torrent.hash, torrent.save_path, h.release_id);
              console.log(`[Status] Hash by title match for ${req.title}: ${torrent.hash}`);
            }
          }

          if (!torrent) {
            allSeeding = false;
            continue;
          }
          anyFound = true;

          if (DOWNLOADING_STATES.includes(torrent.state)) {
            anyDownloading = true;
            allSeeding = false;
          } else if (!SEEDING_STATES.includes(torrent.state)) {
            allSeeding = false;
          }
        }

        // Path 2: No release_candidates — try title-matching request title against torrents
        // This handles imported movies (import-missing) that have no release_candidates
        if (!requestsWithHashes.has(req.id)) {
          const normTitle = normalizeTitle(req.title);
          const match = torrents.find((t) => {
            const tn = normalizeTitle(t.name);
            return tn.includes(normTitle) || normTitle.includes(tn);
          });

          if (match) {
            anyFound = true;
            if (DOWNLOADING_STATES.includes(match.state)) {
              anyDownloading = true;
              allSeeding = false;
            } else if (SEEDING_STATES.includes(match.state)) {
              // already seeding, allSeeding stays true
            } else {
              allSeeding = false;
            }
          }
        }

        if (!anyFound) continue;

        const prevState = req.status;
        let newState = prevState;

        if (anyDownloading) {
          newState = "DOWNLOADING";
        } else if (allSeeding) {
          newState = "SEEDING";
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
