import path from "path";
import { Database } from "better-sqlite3";
import { MEDIA_MOVIES, MEDIA_TV, PROCESSED_MOVIES, PROCESSED_TV } from "../config/paths";
import { scanLibrary, scanProcessed, type ScannedFile } from "./libraryScan";

/**
 * Arr-free library reconcile.
 *
 * The library on disk is the source of truth for what the app should manage:
 * a movie folder or a series folder that exists IS content the app owns, and
 * without Radarr/Sonarr there is no external metadata service to ask. This
 * planner turns disk state into media_requests (identity = library_key, our own
 * key derived from the folder: family + stable id/title + year) and links each
 * library file to its processed counterpart by inode, exactly like adoption
 * does for links.
 *
 * Safety:
 * - Read-only planner; execute() only INSERTs / UPDATEs. It never deletes rows
 *   or files.
 * - Active rows (DOWNLOADING/SEEDING/SEARCHING/AWAITING_APPROVAL/APPROVED) are
 *   never touched, even when they match a library item. A request that is being
 *   worked keeps its identity.
 * - Existing COMPLETED rows keep their id and get missing processed files
 *   merged in (never removed).
 * - Rows without a library_key that match a library item by normalized title
 *   (+ season for series) are adopted: the key is assigned and dormant rows
 *   (NEW/DISMISSED/REJECTED) are promoted to COMPLETED because the content
 *   demonstrably exists on disk.
 */

/** Statuses that are actively being worked — never reconciled. */
const ACTIVE_STATUSES = new Set([
  "DOWNLOADING",
  "SEEDING",
  "SEARCHING",
  "AWAITING_APPROVAL",
  "APPROVED",
]);

/** Statuses that are dormant and may be promoted to COMPLETED on reconcile. */
const DORMANT_STATUSES = new Set(["NEW", "DISMISSED", "REJECTED"]);

export interface LibraryImportCandidate {
  kind: "movie" | "series";
  title: string;
  year: number | null;
  libraryDir: string;
  libraryKey: string;
  /** Series only. */
  season: number | null;
  episodeCount: number | null;
  /** Number of library files matched into processed (inode link present). */
  filesMatched: number;
  /** Total library files for this item. */
  filesTotal: number;
  /** Processed-relative paths associated (movies: filename; series: show/Sxx/name). */
  processedRelPaths: string[];
  requestId: number | null;
  existingStatus: string | null;
  action: "create" | "adopt" | "update" | "skip";
  reason?: string;
}

export interface LibraryImportPlan {
  candidates: LibraryImportCandidate[];
  totals: {
    create: number;
    adopt: number;
    update: number;
    skip: number;
  };
  filesScanned: number;
  unparsed: number;
  errors: string[];
}

export interface LibraryImportResult {
  totals: LibraryImportPlan["totals"];
  createdIds: number[];
  adoptedIds: number[];
  filesAssociated: number;
}

function slugTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "").trim();
}

function movieKey(imdbId: string | null, title: string, year: number | null): string {
  return `movie:${(imdbId || slugTitle(title)).toLowerCase()}:${year ?? 0}`;
}

function showKey(tvdbId: string | null, imdbId: string | null, title: string, year: number | null): string {
  const id = tvdbId || imdbId || slugTitle(title);
  return `series:${id.toLowerCase()}:${year ?? 0}`;
}

function distinctEpisodes(files: ScannedFile[]): number {
  const eps = new Set<number>();
  for (const f of files) if (f.episode != null) eps.add(f.episode);
  return eps.size || files.length;
}

/**
 * Produce the reconcile plan.
 *
 * @param db App database (passed in; this service does not own a connection).
 */
export function planLibraryImport(db: Database): LibraryImportPlan {
  const lib = scanLibrary(MEDIA_MOVIES, MEDIA_TV);
  const proc = scanProcessed(PROCESSED_MOVIES, PROCESSED_TV);

  const candidates: LibraryImportCandidate[] = [];
  const errors: string[] = [...lib.errors, ...proc.errors];
  const skippedSoFar = new Map<string, string>();

  // ino -> processed files. A hardlink of a library file shares the ino, so the
  // same file may map to several processed paths (multiple versions, adoption
  // links, download twin).
  const procByIno = new Map<number, ScannedFile[]>();
  for (const f of proc.movieFiles) {
    const arr = procByIno.get(f.ino) || [];
    arr.push(f);
    procByIno.set(f.ino, arr);
  }
  for (const s of proc.shows) {
    for (const f of s.files) {
      const arr = procByIno.get(f.ino) || [];
      arr.push(f);
      procByIno.set(f.ino, arr);
    }
  }

  // Fetch media_requests once; filtering happens in JS so the plan is safe
  // against rows appearing mid-scan.
  const movieRows = db
    .prepare("SELECT id, title, status, library_key, radarr_id FROM media_requests WHERE type = 'movie'")
    .all() as any[];
  const seriesRows = db
    .prepare("SELECT id, title, status, library_key, sonarr_id, season FROM media_requests WHERE type = 'series'")
    .all() as any[];

  const buildMovie = (dir: string, title: string, year: number | null, imdbId: string | null, files: ScannedFile[]): LibraryImportCandidate => {
    const key = movieKey(imdbId, title, year);
    const rels: string[] = [];
    let matched = 0;
    for (const f of files) {
      const pf = procByIno.get(f.ino);
      if (!pf) continue;
      matched++;
      for (const p of pf) {
        const rel = path.relative(PROCESSED_MOVIES, p.path);
        if (rel && !rel.startsWith("..") && !rels.includes(rel)) rels.push(rel);
      }
    }

    const byKey = movieRows.filter((r: any) => r.library_key === key);
    const byTitle = !byKey.length
      ? movieRows.filter((r: any) => normTitle(r.title) === normTitle(title) && !r.library_key)
      : [];

    const existing: any = byKey[0] || byTitle[0];
    if (!existing) {
      return {
        kind: "movie",
        title,
        year,
        libraryDir: dir,
        libraryKey: key,
        season: null,
        episodeCount: null,
        filesMatched: matched,
        filesTotal: files.length,
        processedRelPaths: rels,
        requestId: null,
        existingStatus: null,
        action: "create",
      };
    }

    const base = {
      kind: "movie" as const,
      title,
      year,
      libraryDir: dir,
      libraryKey: key,
      season: null,
      episodeCount: null,
      filesMatched: matched,
      filesTotal: files.length,
      processedRelPaths: rels,
      requestId: existing.id,
      existingStatus: existing.status,
    };

    if (ACTIVE_STATUSES.has(existing.status)) {
      return { ...base, action: "skip", reason: `existing request ${existing.status}` };
    }
    if (!existing.library_key) {
      return { ...base, action: "adopt", reason: DORMANT_STATUSES.has(existing.status) ? `was ${existing.status}` : undefined };
    }
    if (existing.status !== "COMPLETED") {
      return { ...base, action: "skip", reason: `existing request ${existing.status}` };
    }
    return { ...base, action: "update" };
  };

  const buildShowSeason = (
    dir: string,
    title: string,
    year: number | null,
    imdbId: string | null,
    tvdbId: string | null,
    files: ScannedFile[],
  ): LibraryImportCandidate[] => {
    const key = showKey(tvdbId, imdbId, title, year);

    // Group season-0 files (specials) and parsed seasons; drop unresolved files.
    const bySeason = new Map<number, ScannedFile[]>();
    for (const f of files) {
      if (f.season == null) continue;
      const arr = bySeason.get(f.season) || [];
      arr.push(f);
      bySeason.set(f.season, arr);
    }

    const out: LibraryImportCandidate[] = [];
    for (const [season, seasonFiles] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      const rels: string[] = [];
      let matched = 0;
      for (const f of seasonFiles) {
        const pf = procByIno.get(f.ino);
        if (!pf) continue;
        matched++;
        for (const p of pf) {
          const rel = path.relative(PROCESSED_TV, p.path);
          if (rel && !rel.startsWith("..") && !rels.includes(rel)) rels.push(rel);
        }
      }

      const byKey = seriesRows.filter((r: any) => r.library_key === key && r.season === season);
      const byTitle = !byKey.length
        ? seriesRows.filter((r: any) => normTitle(r.title) === normTitle(title) && r.season === season && !r.library_key)
        : [];

      const existing: any = byKey[0] || byTitle[0];

      const base = {
        kind: "series" as const,
        title,
        year,
        libraryDir: dir,
        libraryKey: key,
        season,
        episodeCount: distinctEpisodes(seasonFiles),
        filesMatched: matched,
        filesTotal: seasonFiles.length,
        processedRelPaths: rels,
        requestId: existing?.id ?? null,
        existingStatus: existing?.status ?? null,
      };

      if (!existing) {
        out.push({ ...base, action: "create" });
        continue;
      }
      if (ACTIVE_STATUSES.has(existing.status)) {
        out.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
        continue;
      }
      if (!existing.library_key) {
        out.push({
          ...base,
          action: "adopt",
          reason: DORMANT_STATUSES.has(existing.status) ? `was ${existing.status}` : undefined,
        });
        continue;
      }
      if (existing.status !== "COMPLETED") {
        out.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
        continue;
      }
      out.push({ ...base, action: "update" });
    }

    // A dormant/absent row may already claim this identity; dedupe by
    // season+requestId so we never double-plan.
    return out;
  };

  for (const m of lib.movies) {
    candidates.push(buildMovie(m.dir, m.title, m.year, m.imdbId, m.files));
  }
  for (const s of lib.shows) {
    for (const c of buildShowSeason(s.dir, s.title, s.year, s.imdbId, s.tvdbId, s.files)) {
      if (c.action === "skip" && skippedSoFar.has(`${c.libraryKey}:${c.season}`)) continue;
      if (c.action === "skip") skippedSoFar.set(`${c.libraryKey}:${c.season}`, "");
      candidates.push(c);
    }
  }

  const totals = { create: 0, adopt: 0, update: 0, skip: 0 };
  for (const c of candidates) totals[c.action]++;

  return { candidates, totals, filesScanned: lib.filesScanned + proc.filesScanned, unparsed: lib.unparsed.length, errors };
}

function attachProcessed(db: Database, requestId: number, relPaths: string[]): void {
  if (!relPaths.length) return;
  const ah = db
    .prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1")
    .get(requestId) as any;
  if (ah) {
    const existing: string[] = JSON.parse(ah.processed_files || "[]");
    for (const p of relPaths) if (!existing.includes(p)) existing.push(p);
    db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
  } else {
    db.prepare(
      "INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)",
    ).run(requestId, JSON.stringify(relPaths));
  }
}

/**
 * Apply a plan produced by planLibraryImport(). Only INSERTs and UPDATEs —
 * never deletes, never touches active rows.
 */
export function executeLibraryImport(db: Database, plan: LibraryImportPlan): LibraryImportResult {
  const insertReq = db.prepare(
    "INSERT INTO media_requests (title, type, season, status, requested_by, episode_count, library_key) VALUES (?, ?, ?, 'COMPLETED', '[]', ?, ?)",
  );
  const adoptReq = db.prepare(
    "UPDATE media_requests SET library_key = ?, status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  );

  const createdIds: number[] = [];
  const adoptedIds: number[] = [];
  let filesAssociated = 0;
  const totals = { create: 0, adopt: 0, update: 0, skip: 0 };

  for (const c of plan.candidates) {
    totals[c.action]++;
    if (c.action === "skip") continue;

    if (c.action === "create") {
      const res = insertReq.run(c.title, c.kind, c.season, c.episodeCount, c.libraryKey);
      const id = Number(res.lastInsertRowid);
      createdIds.push(id);
      attachProcessed(db, id, c.processedRelPaths);
    } else {
      if (!c.requestId) continue;
      if (c.action === "adopt") {
        adoptReq.run(c.libraryKey, c.requestId);
        adoptedIds.push(c.requestId);
      }
      attachProcessed(db, c.requestId, c.processedRelPaths);
    }
    filesAssociated += c.processedRelPaths.length;
  }

  return { totals, createdIds, adoptedIds, filesAssociated };
}