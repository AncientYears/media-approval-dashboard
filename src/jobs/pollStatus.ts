import { Database } from "better-sqlite3";
import { QBittorrentService } from "../services/qbittorrent";

const DOWNLOADING_STATES = ["downloading", "forcedDL", "queuedDL", "pausedDL"];
const SEEDING_STATES = ["uploading", "stalledUP", "forcedUP", "queuedUP", "pausedUP"];

function normalizeTitle(s: string): string {
  return s.toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[:']/g, " ")
    .replace(/[.\-_\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleWords(title: string): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length > 0 && !["the", "and", "for"].includes(w));
}

function hasSequelAfter(tn: string, matchEnd: number): boolean {
  const after = tn.slice(matchEnd).replace(/^[\s.\-_]+/, "");
  return /^\d{1,2}[\s.\-_]/.test(after) && !/^(19|20)\d{2}/.test(after);
}

function extractSeasonFromTitle(title: string): number | null {
  const norm = normalizeTitle(title);
  const match = norm.match(/\bs(\d{1,2})(?:e\d|\b)/);
  return match ? parseInt(match[1], 10) : null;
}

function torrentMatchesTitle(torrentName: string, requestTitle: string): boolean {
  const tn = normalizeTitle(torrentName);
  const normTitle = normalizeTitle(requestTitle);
  if (tn === normTitle) return true;

  const torrentSeason = extractSeasonFromTitle(torrentName);
  const requestSeason = extractSeasonFromTitle(requestTitle);
  if (torrentSeason !== null && requestSeason !== null && torrentSeason !== requestSeason) {
    return false;
  }

  const reqWords = titleWords(requestTitle);
  if (reqWords.length === 0) return false;

  if (tn.startsWith(normTitle + " ") || tn.startsWith(normTitle + ".")) {
    if (reqWords.length <= 2 && hasSequelAfter(tn, normTitle.length)) return false;
    const after = tn.slice(normTitle.length).replace(/^[\s.\-_]+/, "");
    if (/^e\d/i.test(after)) return false;
    return true;
  }

  const allPresent = reqWords.every((w) => tn.includes(w));
  if (!allPresent) return false;

  const lastWord = reqWords[reqWords.length - 1];
  const lastIdx = tn.lastIndexOf(lastWord);
  if (lastIdx >= 0) {
    const afterLast = tn.slice(lastIdx + lastWord.length).replace(/^[\s.\-_]+/, "");
    if (/^e\d/i.test(afterLast)) return false;
  }

  if (reqWords.length <= 2) {
    const firstWord = reqWords[0];
    if (!tn.startsWith(firstWord)) return false;
    const afterTitle = tn.slice(firstWord.length);
    if (reqWords.length === 2) {
      if (!afterTitle.includes(reqWords[1])) return false;
      const idx2 = afterTitle.indexOf(reqWords[1]);
      const afterSecond = afterTitle.slice(idx2 + reqWords[1].length).trim();
      if (/^[.\-_\s]*\d{1,2}[.\-_\s]/.test(afterSecond) && !/^[.\-_\s]*(19|20)\d{2}/.test(afterSecond)) return false;
    } else {
      const nextChars = afterTitle.replace(/^[\s.\-_]+/, "");
      if (/^\d{1,2}[\s.\-_]/.test(nextChars) && !/^(19|20)\d{2}/.test(nextChars)) return false;
    }
  }
  return true;
}

export function createStatusPoller(db: Database, qbittorrent: QBittorrentService, intervalSeconds: number) {
  let running = false;

  const insertRcStmt = db.prepare(
    "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'detected', ?, ?, ?, 'unknown')"
  );
  const insertAhStmt = db.prepare(
    "INSERT INTO approval_history (request_id, release_id, approved_by) VALUES (?, ?, 'system')"
  );

  async function poll() {
    if (running) return;
    running = true;

    try {
      const requests = db.prepare(
        "SELECT id, title, status, type, updated_at FROM media_requests " +
        "WHERE status IN ('DOWNLOADING', 'SEEDING', 'AWAITING_APPROVAL', 'SEARCHING')"
      ).all() as any[];

      if (requests.length === 0) return;

      const torrents = await qbittorrent.getTorrents();

      const releaseHashes = db.prepare(
        "SELECT rc.request_id, rc.torrent_hash, rc.id as release_id, rc.title as release_title FROM release_candidates rc " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
      ).all() as any[];

      const requestsWithHashes = new Set(releaseHashes.map((r: any) => r.request_id));

      for (const req of requests) {
        let anyFound = false;
        let anyDownloading = false;
        let allSeeding = true;
        const staleHashIds: number[] = [];

        const hashes = releaseHashes.filter((r: any) => r.request_id === req.id);
        for (const h of hashes) {
          let torrent = null;

          if (h.torrent_hash) {
            const candidate = torrents.length > 0 ? torrents.find((t) => t.hash === h.torrent_hash) : null;
            torrent = candidate;
          }

          if (!torrent && h.release_title && torrents.length > 0) {
            const matched = torrents.find((t) => torrentMatchesTitle(t.name, h.release_title));
            if (matched) {
              torrent = matched;
              db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                .run(matched.hash, matched.save_path, h.release_id);
            }
          }

          if (!torrent) {
            allSeeding = false;
            continue;
          }
          anyFound = true;

          if (torrent.size > 0) {
            const rcSize = db.prepare("SELECT size_mb FROM release_candidates WHERE id = ?").get(h.release_id) as any;
            if (rcSize && (!rcSize.size_mb || rcSize.size_mb === 0)) {
              const sizeMb = Math.round(torrent.size / (1024 * 1024));
              db.prepare("UPDATE release_candidates SET size_mb = ? WHERE id = ?").run(sizeMb, h.release_id);
            }
          }

          if (DOWNLOADING_STATES.includes(torrent.state)) {
            anyDownloading = true;
            allSeeding = false;
          } else if (!SEEDING_STATES.includes(torrent.state)) {
            allSeeding = false;
          }
        }

        for (const rid of staleHashIds) {
          db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rid);
          db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rid);
        }
        if (staleHashIds.length > 0) {
          requestsWithHashes.delete(req.id);
        }

        if (!requestsWithHashes.has(req.id) && torrents.length > 0) {
          const match = torrents.find((t) => torrentMatchesTitle(t.name, req.title));

          if (match) {
            anyFound = true;
            if (DOWNLOADING_STATES.includes(match.state)) {
              anyDownloading = true;
              allSeeding = false;
            } else if (SEEDING_STATES.includes(match.state)) {
              // seeding
            } else {
              allSeeding = false;
            }

            const rcResult = insertRcStmt.run(req.id, `detected-${match.hash.slice(0, 12)}`, match.name, Math.round((match.size || 0) / (1024 * 1024)), match.hash, match.save_path);
            insertAhStmt.run(req.id, rcResult.lastInsertRowid);
            console.log(`[Status] Detected torrent for ${req.title}: ${match.name} (hash=${match.hash})`);
            requestsWithHashes.add(req.id);
          }
        }

        if (!anyFound) {
          if (req.status === "SEARCHING") {
            const elapsed = (Date.now() - new Date(req.updated_at).getTime()) / 1000;
            if (elapsed > 70) {
              db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.id);
              console.log(`[Status] ${req.title}: SEARCHING → AWAITING_APPROVAL (no torrent found after ${Math.round(elapsed)}s)`);
            }
          }
          continue;
        }

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
