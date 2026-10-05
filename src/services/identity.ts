import fs from "fs";
import path from "path";
import { Database } from "better-sqlite3";

/**
 * Identity layer (P0 of the processed/library standardization roadmap).
 *
 * The source of truth for "what file is this" is the media_files table keyed
 * by (dev, inode), NOT the folder name or filename. Every write path registers
 * the inodes it creates (moves make NEW inodes, hardlinks share one), so reads
 * can recover coverage/pills/episode grids even after a manual `mv`/rename.
 * Names are only the fallback for files whose inode is "doomed" (copied, not
 * hardlinked — a new inode that was never registered).
 */

export type FileRole = "numbered" | "special" | "extra";

export interface FileIdentity {
  library_key: string;
  title: string;
  season: number;
  episodeNumbers: number[];
  role: FileRole;
  releaseName: string;
}

export interface MediaFileRow {
  dev: number;
  inode: number;
  library_key: string;
  title: string;
  season: number;
  episode_nums: string;
  role: string;
  release_name: string;
  updated_at: string;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|ts|wmv)$/i;

/** Role + episode numbers for a basename, mirroring extractEpisodeFromFilename:
 * S0X specials are deliberately unnumbered, E##/Episode N/leading number are
 * numbered episodes, anything else is an unclassified extra. */
export function deriveIdentityFromFilename(fileBase: string): { role: FileRole; episodeNumbers: number[] } {
  if (/[Ss]0[Xx]/.test(fileBase)) return { role: "special", episodeNumbers: [] };
  const m = fileBase.match(/[Ee](\d{1,3})/);
  if (m) return { role: "numbered", episodeNumbers: [parseInt(m[1], 10)] };
  const lead = fileBase.match(/^(\d{1,3})\s/);
  if (lead) return { role: "numbered", episodeNumbers: [parseInt(lead[1], 10)] };
  const ep = fileBase.match(/[Ee]pisode\s*(\d{1,3})/);
  if (ep) return { role: "numbered", episodeNumbers: [parseInt(ep[1], 10)] };
  return { role: "extra", episodeNumbers: [] };
}

/** Whether a file embedding a DIFFERENT IMDb id than the owner genuinely
 *  contradicts that owner.
 *
 *  It does for a MOVIE (a movie folder holds exactly one film) and for a
 *  NUMBERED episode (S01E01 belongs to exactly one show - that is the DuckTales
 *  1987/2017 and Mufasa/Lion King protection, and it stays).
 *
 *  It does NOT for an UNNUMBERED special. A show's S00 legitimately holds films,
 *  shorts and crossovers, so a special carrying its own id is the expected shape
 *  rather than a misfile. DuckTales' S00 holds a bonus feature carrying
 *  `[imdbid-tt0099472]`; vetoing that refused the whole show folder, and because
 *  a season row inherits the show folder's verdict, one bonus film then blocked
 *  every `Season N -> SN` rename in the show.
 *
 *  Derived from the NAME rather than the stored role because this runs exactly
 *  when identity is in doubt - a registered row is what is being second-guessed.
 */
export function embeddedIdContradicts(isSeries: boolean, fileBase: string): boolean {
  if (!isSeries) return true;
  return deriveIdentityFromFilename(fileBase).role === "numbered";
}

/** Upsert the identity of one file. Best effort: never throws, never blocks a
 *  caller on a stat/DB failure. Skip registration for directories. */
export function registerFileIdentity(db: Database, absPath: string, identity: FileIdentity): MediaFileRow | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.ino || st.isDirectory()) return null;
    db.prepare(
      `INSERT INTO media_files (dev, inode, library_key, title, season, episode_nums, role, release_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(dev, inode) DO UPDATE SET
         library_key = excluded.library_key,
         title = excluded.title,
         season = excluded.season,
         episode_nums = excluded.episode_nums,
         role = excluded.role,
         release_name = excluded.release_name,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      st.dev,
      st.ino,
      identity.library_key,
      identity.title,
      identity.season,
      JSON.stringify(identity.episodeNumbers),
      identity.role,
      identity.releaseName,
    );
    return {
      dev: st.dev,
      inode: st.ino,
      library_key: identity.library_key,
      title: identity.title,
      season: identity.season,
      episode_nums: JSON.stringify(identity.episodeNumbers),
      role: identity.role,
      release_name: identity.releaseName,
      updated_at: "",
    };
  } catch {
    return null;
  }
}

/** Look up a file's registered identity by inode. Null when unregistered. */
export function identifyByPath(db: Database, absPath: string): MediaFileRow | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.ino || st.isDirectory()) return null;
    return (
      (db
        .prepare(
          "SELECT dev, inode, library_key, title, season, episode_nums, role, release_name, updated_at FROM media_files WHERE dev = ? AND inode = ?",
        )
        .get(st.dev, st.ino) as MediaFileRow) || null
    );
  } catch {
    return null;
  }
}

/** Map of filename -> registered identity for every video file in a folder. */
export function identifySeasonFolderFiles(db: Database, seasonFolder: string): Map<string, MediaFileRow> {
  const out = new Map<string, MediaFileRow>();
  try {
    for (const f of fs.readdirSync(seasonFolder)) {
      if (!VIDEO_EXT.test(f)) continue;
      const row = identifyByPath(db, path.join(seasonFolder, f));
      if (row) out.set(f, row);
    }
  } catch {}
  return out;
}

/** Register every video file under a root (file or directory). Per-file role
 * and episode numbers are derived from the basename; only the request-level
 * library_key/title/season come from the caller. Returns files registered. */
export function registerVideoTree(
  db: Database,
  root: string,
  identity: Pick<FileIdentity, "library_key" | "title" | "season">,
): number {
  let registered = 0;
  try {
    const st = fs.statSync(root);
    if (st.isFile()) {
      const { role, episodeNumbers } = deriveIdentityFromFilename(path.basename(root));
      return registerFileIdentity(db, root, { ...identity, episodeNumbers, role, releaseName: path.basename(root) }) ? 1 : 0;
    }
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir)) {
        const p = path.join(dir, e);
        let s: fs.Stats;
        try {
          s = fs.statSync(p);
        } catch {
          continue;
        }
        if (s.isDirectory()) walk(p);
        else if (VIDEO_EXT.test(e)) {
          const { role, episodeNumbers } = deriveIdentityFromFilename(e);
          if (registerFileIdentity(db, p, { ...identity, episodeNumbers, role, releaseName: e })) registered++;
        }
      }
    };
    walk(root);
  } catch {}
  return registered;
}

function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Best-effort identity recovery when the caller has no request row handy
 * (adoption / import-library targets). Parses title from the path and matches
 * a media_requests row by normalized title + season. Null when nothing agrees.
 * Names are the backup — fine to miss, never to misattribute. */
export function autodetectIdentity(db: Database, absPath: string): FileIdentity | null {
  try {
    const parsed = parseIdentityFromPath(absPath);
    const rows = db
      .prepare(
        `SELECT library_key, title, season, type FROM media_requests
         WHERE library_key IS NOT NULL AND library_key != ''`,
      )
      .all() as Array<{ library_key: string; title: string; season: number | null; type: string }>;
    const wantTitle = normTitle(parsed.title);
    if (!wantTitle) return null;
    // An id embedded in the path ("[imdbid-tt13186482]") is deterministic and
    // outranks the title guess below: the id's real owner is already recorded
    // somewhere. This is what keeps "Mufasa The Lion King (2024)" from being
    // adopted into "The Lion King (1994)" merely because the titles overlap.
    const embedded = absPath.match(/imdbid[-\s]*(tt\d{6,9})/i) || absPath.match(/\b(tt\d{6,9})\b/i);
    if (embedded) {
      const id = embedded[1].toLowerCase();
      let ownerKey: string | null = null;
      try {
        ownerKey = (db.prepare("SELECT library_key FROM tmdb_external_ids WHERE imdb_id = ? LIMIT 1").get(id) as any)?.library_key || null;
      } catch {}
      if (!ownerKey) {
        // Cache cold (or TMDB unset): an id-anchored library_key still answers.
        try {
          ownerKey = (db.prepare("SELECT library_key FROM media_requests WHERE library_key LIKE ? LIMIT 1").get(`%${id}%`) as any)?.library_key || null;
        } catch {}
      }
      if (ownerKey) {
        const owner = db
          .prepare("SELECT library_key, title, season FROM media_requests WHERE library_key = ? LIMIT 1")
          .get(ownerKey) as any;
        if (owner?.library_key) {
          const { role, episodeNumbers } = deriveIdentityFromFilename(path.basename(absPath));
          return {
            library_key: owner.library_key,
            title: owner.title || parsed.title,
            season: owner.season ?? parsed.season,
            episodeNumbers,
            role,
            releaseName: path.basename(absPath),
          };
        }
      }
    }
    let best: { library_key: string; title: string; season: number; type: string } | null = null;
    for (const r of rows) {
      if (normTitle(r.title) !== wantTitle) continue;
      if (best == null || (r.season != null && parsed.season === r.season)) {
        best = { ...r, season: r.season ?? 0 };
        if (parsed.season === (r.season ?? 0)) break;
      }
    }
    if (!best) return null;
    const { role, episodeNumbers } = deriveIdentityFromFilename(path.basename(absPath));
    return {
      library_key: best.library_key,
      title: best.title,
      season: parsed.season,
      episodeNumbers,
      role,
      releaseName: path.basename(absPath),
    };
  } catch {
    return null;
  }
}

/** Title + season parsed from a processed/library relative path: strips the
 * extension and a trailing `(YYYY)`, and reads the season from an Sxx segment
 * (or 0 when none is present). */
function parseIdentityFromPath(absPath: string): { title: string; season: number } {
  const base = path.basename(absPath);
  const extMatch = base.match(/^(.*?)\s*\.(?:mkv|mp4|avi|mov|ts|wmv)$/i);
  const rawTitle = (extMatch ? extMatch[1] : base)
    .replace(/\s*\[[^\]]*\]/g, "") // id/quality/group tags
    .replace(/\s+\(\d{4}\)$/, "") // trailing year
    .replace(/\s+S\d{1,2}(?:E\d{1,3})?\s*$/i, "") // Sxx / SxxExx tail
    .replace(/\s+E\d{1,3}\s*$/i, ""); // bare E### tail
  const title = rawTitle.trim() || base.replace(/\.[^.]+$/, "").trim();
  let season = 0;
  const segs = absPath.split(/[\\/]/);
  for (const seg of segs) {
    const m = seg.match(/\bS(\d{1,2})(?:E\d|\b)/i);
    if (m) {
      season = parseInt(m[1], 10);
      break;
    }
  }
  return { title, season };
}