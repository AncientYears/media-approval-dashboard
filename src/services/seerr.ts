import axios from "axios";
import type { Database } from "better-sqlite3";
import { fetchTMDBById } from "./tmdb";
import { cleanFranchiseTitle, nativeLibraryKey } from "../routes/requests";
import { errorSummary } from "../utils/errorSummary";

/**
 * Seerr API sync — the arr-free bridge from Seerr's own request list into the
 * app's dashboard requests. Replaces the webhook approach (which had no event
 * for request deletion) with a full bidirectional-ish reconcile:
 *
 *   - Requests present in Seerr are upserted into media_requests as native
 *     rows (library_key identity, status NEW) — idempotent on key+season.
 *   - Requests that vanished from Seerr (deleted/cancelled/declined) are
 *     removed from the app — but ONLY when they are content-less, so a
 *     request that already has a torrent, processed files or a completed
 *     library entry is never destroyed by a Seerr-side delete.
 *
 * Seerr availability is deliberately NOT used to complete rows: Seerr's
 * Jellyfin scan sees the whole library, but a release often needs the app's
 * preprocessing before it should land there — COMPLETED stays a manual
 * "move to library" signal.
 *
 * Requires SEERR_URL + SEERR_API_KEY (Seerr Settings → Main → API Key).
 */

interface SeerrRequest {
  id: number;
  status?: number | string | null;
  type?: "movie" | "tv";
  seasonNumber?: number | null;
  requestedBy?: {
    displayName?: string;
    username?: string | null;
    jellyfinUsername?: string | null;
    plexUsername?: string | null;
    email?: string;
  };
  seasons?: Array<{ seasonNumber?: number; status?: number | string | null }>;
  media?: {
    mediaType?: "movie" | "tv";
    tmdbId?: number;
    tvdbId?: number;
    seasonNumber?: number | null;
  };
}

export function isSeerrConfigured(): boolean {
  return !!(process.env.SEERR_URL && process.env.SEERR_API_KEY);
}

export interface SeerrRemoveResult {
  ok: boolean;
  method: string;
  status?: number;
  body?: string;
  error?: string;
}

/** Remove a Seerr request so the sync won't re-create its local row.
 * Tries DELETE first; when Seerr refuses (e.g. `canRemove: false` for
 * fulfilled/available media) it falls back to DECLINE — declined requests are
 * inactive in `isActive()`, so the sync treats them as absent and never
 * re-creates the row. */
export async function seerrRemoveRequest(seerrRequestId: number): Promise<SeerrRemoveResult> {
  const url = String(process.env.SEERR_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SEERR_API_KEY || "");
  if (!url || !key) {
    return { ok: false, method: "none", error: "SEERR_URL/SEERR_API_KEY unset" };
  }
  try {
    const del = await axios.delete(`${url}/api/v1/request/${seerrRequestId}`, {
      headers: { "X-Api-Key": key },
      timeout: 15000,
    });
    return { ok: true, method: "delete", status: del.status };
  } catch (err: any) {
    const delStatus = err?.response?.status;
    const delBody = typeof err?.response?.data === "string" ? err.response.data : JSON.stringify(err?.response?.data ?? "");
    console.warn(`[Seerr] DELETE request ${seerrRequestId} refused (HTTP ${delStatus}) — falling back to decline: ${String(delBody).slice(0, 300)}`);
    try {
      const decl = await axios.post(
        `${url}/api/v1/request/${seerrRequestId}/decline`,
        { requestId: seerrRequestId },
        { headers: { "X-Api-Key": key, "Content-Type": "application/json" }, timeout: 15000 }
      );
      return { ok: true, method: "decline", status: decl.status };
    } catch (err2: any) {
      const declStatus = err2?.response?.status;
      const declBody = typeof err2?.response?.data === "string" ? err2.response.data : JSON.stringify(err2?.response?.data ?? "");
      return { ok: false, method: "decline", status: declStatus, body: String(declBody).slice(0, 300), error: err2?.message };
    }
  }
}

export async function fetchSeerrRequests(): Promise<SeerrRequest[]> {
  const url = String(process.env.SEERR_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SEERR_API_KEY || "");
  const out: SeerrRequest[] = [];
  let skip = 0;
  const take = 100;
  for (;;) {
    const res = await axios.get(`${url}/api/v1/request`, {
      params: { take, skip },
      headers: { "X-Api-Key": key },
      timeout: 15000,
    });
    const batch: SeerrRequest[] = Array.isArray(res.data) ? res.data : res.data?.results || [];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < take) break;
    skip += take;
  }
  return out;
}

/** Seerr request statuses that represent an open request. Declined/failed are
 * inactive — they must not (re)create rows and get removed like deletions. */
function isActive(req: SeerrRequest): boolean {
  const s = req.status;
  if (s === 3 || s === 4) return false;
  if (typeof s === "string") {
    const ls = s.toLowerCase();
    if (["declined", "failed", "cancelled", "canceled", "removed", "deleted"].includes(ls)) return false;
  }
  return true;
}

export interface SeerrSyncResult {
  enabled: boolean;
  error?: string;
  fetched: number;
  active: number;
  added: number;
  backfilled: number;
  removed: number;
  contentKept: number;
}

export async function syncSeerr(db: Database): Promise<SeerrSyncResult> {
  const base: SeerrSyncResult = { enabled: isSeerrConfigured(), fetched: 0, active: 0, added: 0, backfilled: 0, removed: 0, contentKept: 0 };
  if (!base.enabled) return base;

  let requests: SeerrRequest[];
  try {
    requests = await fetchSeerrRequests();
  } catch (err: any) {
    console.error("[Seerr] sync failed:", errorSummary(err));
    return { ...base, error: errorSummary(err) };
  }
  base.fetched = requests.length;

  const active = requests.filter(isActive);
  base.active = active.length;
  const presentIds = new Set(active.map((r) => r.id));

  for (const req of active) {
    const rawType = String(req.type || req.media?.mediaType || "movie").toLowerCase();
    const mediaType = rawType === "movie" ? "movie" : "series";
    const tmdbId = Number(req.media?.tmdbId || 0);
    if (!mediaType || !tmdbId) continue;

    const t = await fetchTMDBById(mediaType, tmdbId);
    if (!t?.title) continue;

    const cleaned = cleanFranchiseTitle(t.title);
    // Id-anchored via nativeLibraryKey, which also claims/upgrades any row a
    // previous slug-keyed mint left under this title — never a twin.
    const key = await nativeLibraryKey(db, mediaType, { tmdbId, title: cleaned, year: t.year ?? null });
    const user = String(
      req.requestedBy?.displayName ||
      req.requestedBy?.jellyfinUsername ||
      req.requestedBy?.plexUsername ||
      req.requestedBy?.username ||
      req.requestedBy?.email ||
      "Seerr"
    ).trim() || "Seerr";

    // Seerr creates one request per requested season and exposes it in the
    // `seasons` array — not a single seasonNumber — so don't collapse S02+ onto
    // the S01 key. Fall back to a single season when the shape lacks seasons.
    let seasonNumbers: number[] = [];
    if (Array.isArray(req.seasons) && req.seasons.length) {
      seasonNumbers = req.seasons
        .filter((s) => !(s.status === 3 || s.status === 4))
        .map((s) => Number(s.seasonNumber))
        .filter((n) => Number.isFinite(n));
    }
    if (!seasonNumbers.length) {
      const n = Number(req.seasonNumber ?? req.media?.seasonNumber ?? 1);
      seasonNumbers = [Number.isFinite(n) ? n : 1];
    }

    for (const sn of seasonNumbers) {
      let existing: any;
      let rowId: number;
      if (mediaType === "movie") {
        existing = db.prepare("SELECT id, seerr_request_id, requested_by, status FROM media_requests WHERE library_key = ? AND type = 'movie'").get(key) as any;
      } else {
        existing = db.prepare("SELECT id, seerr_request_id, requested_by, status FROM media_requests WHERE library_key = ? AND season = ?").get(key, sn) as any;
      }

      if (existing) {
        rowId = existing.id;
        // Row exists — link it back to Seerr if it wasn't created via Seerr,
        // and refresh the requested-by label when it was placeholder "Seerr".
        const needsLink = !existing.seerr_request_id;
        if (needsLink) {
          db.prepare("UPDATE media_requests SET seerr_request_id = ? WHERE id = ?").run(req.id, existing.id);
          base.backfilled++;
        }
        try {
          const cur = JSON.parse(existing.requested_by || "[]") as string[];
          if (cur.length === 0 || cur.every((u) => (u || "").trim() === "Seerr")) {
            db.prepare("UPDATE media_requests SET requested_by = ? WHERE id = ?").run(JSON.stringify([user]), existing.id);
          }
        } catch {}
      } else {
        const requestedBy = JSON.stringify([user]);
        if (mediaType === "movie") {
          const result = db.prepare(
            "INSERT INTO media_requests (title, type, library_key, status, requested_by, seerr_request_id) VALUES (?, 'movie', ?, 'NEW', ?, ?)"
          ).run(cleaned, key, requestedBy, req.id);
          rowId = Number(result.lastInsertRowid);
          base.added++;
          console.log(`[Seerr] Created movie request ${rowId}: ${cleaned} (key=${key} by ${user})`);
        } else {
          const result = db.prepare(
            "INSERT INTO media_requests (title, type, library_key, season, status, requested_by, seerr_request_id) VALUES (?, 'series', ?, ?, 'NEW', ?, ?)"
          ).run(cleaned, key, sn, requestedBy, req.id);
          rowId = Number(result.lastInsertRowid);
          base.added++;
          console.log(`[Seerr] Created series request ${rowId}: ${cleaned} (key=${key}, season=${sn} by ${user})`);
        }
      }
    }
  }

  // Reconcile deletions: rows we created for Seerr requests that Seerr no
  // longer lists. Remove only content-less rows; keep anything with a torrent,
  // processed files, or an active/completed status.
  const linked = db.prepare("SELECT id, seerr_request_id, status FROM media_requests WHERE seerr_request_id IS NOT NULL").all() as any[];
  for (const row of linked) {
    if (presentIds.has(Number(row.seerr_request_id))) continue;
    const hasTorrent = (db.prepare(
      "SELECT COUNT(*) AS c FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
    ).get(row.id) as any)?.c > 0;
    const hasProcessed = (db.prepare(
      "SELECT COUNT(*) AS c FROM approval_history WHERE request_id = ? AND release_id IS NULL AND processed_files IS NOT NULL AND processed_files != '[]'"
    ).get(row.id) as any)?.c > 0;
    if (hasTorrent || hasProcessed || ["DOWNLOADING", "SEEDING", "COMPLETED", "AWAITING_APPROVAL", "APPROVED"].includes(row.status)) {
      base.contentKept++;
      console.log(`[Seerr] Request ${row.id} deleted in Seerr but kept (has content, status=${row.status})`);
      continue;
    }
    db.prepare("DELETE FROM media_requests WHERE id = ?").run(row.id);
    base.removed++;
    console.log(`[Seerr] Removed request ${row.id} (deleted in Seerr)`);
  }

  return base;
}