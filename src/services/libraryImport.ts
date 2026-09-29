import path from "path";
import { Database } from "better-sqlite3";
import { MEDIA_MOVIES, MEDIA_TV, PROCESSED_MOVIES, PROCESSED_TV } from "../config/paths";
import { parseLooseMovieName, scanLibrary, scanProcessed, type ScannedFile, type ScannedMovie, type ScannedShow } from "./libraryScan";

/**
 * Arr-free library reconcile.
 *
 * The library on disk is the source of truth for what the app should manage:
 * a movie folder or a series folder that exists IS content the app owns, and
 * without Radarr/Sonarr there is no external metadata service to ask. This
 * planner turns disk state into media_requests (identity = library_key, our own
 * key derived from the folder: family + stable id/title + year).
 *
 * Identity is derived from the richest source available, because library FOLDER
 * names are unreliable: two "Akademia pana Kleksa" folders may be the 1984 and
 * 2024 films, "Hobbit" may be three different films, and the 1987 vs 2017
 * DuckTales shows can share a name. So:
 *
 * - Movie identity: folder title/year, enriched from the movie FILES (their
 *   embedded IMDb id and year win), so Kleks Academy (2024), Mr Blot's Academy
 *   (1984) and Travels of Mr Blot (1986) get distinct keys even though two of
 *   their folders share a name.
 * - Series identity: folder title/year, enriched from the PROCESSED show
 *   folder each file inode-links to (adoption preserves that structure), so
 *   DuckTales (2017) keyed against Kacze opowieści - DuckTales (1987) resolve
 *   apart because the 2017 processed folder carries a year.
 * - Folders that resolve to the SAME identity are merged into one request
 *   (multiple versions), never duplicated.
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
  existingEpisodeCount: number | null;
  action: "create" | "adopt" | "update" | "skip" | "noop";
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
  // Never undercount: if only some files parsed episode numbers, fall back to
  // the file count so coverage displays at least the raw file total.
  return Math.max(eps.size, files.length);
}

/** A processed file, enriched with the parsed year of the show folder it lives in. */
interface ProcRef {
  path: string;
  showYear: number | null;
}

/**
 * Produce the reconcile plan.
 *
 * @param db App database (passed in; this service does not own a connection).
 */
export function planLibraryImport(db: Database): LibraryImportPlan {
  const lib = scanLibrary(MEDIA_MOVIES, MEDIA_TV);
  const proc = scanProcessed(PROCESSED_MOVIES, PROCESSED_TV);

  const errors: string[] = [...lib.errors, ...proc.errors];

  // ino -> processed files. A hardlink of a library file shares the ino, so the
  // same file may map to several processed paths (multiple versions, adoption
  // links, download twin). Series refs carry the parsed year of their processed
  // show folder so identity can key off the richer processed structure.
  const procByIno = new Map<number, ProcRef[]>();
  for (const f of proc.movieFiles) {
    const arr = procByIno.get(f.ino) || [];
    arr.push({ path: f.path, showYear: null });
    procByIno.set(f.ino, arr);
  }
  for (const s of proc.shows) {
    for (const f of s.files) {
      const arr = procByIno.get(f.ino) || [];
      arr.push({ path: f.path, showYear: s.year });
      procByIno.set(f.ino, arr);
    }
  }

  // Fetch media_requests once; filtering happens in JS so the plan is safe
  // against rows appearing mid-scan.
  const movieRows = db
    .prepare("SELECT id, title, status, library_key, radarr_id, season, episode_count FROM media_requests WHERE type = 'movie'")
    .all() as any[];
  const seriesRows = db
    .prepare("SELECT id, title, status, library_key, sonarr_id, season, episode_count FROM media_requests WHERE type = 'series'")
    .all() as any[];

  const processedRelPathsFor = (files: ScannedFile[], processedRoot: string): { rels: string[]; matched: number } => {
    const rels: string[] = [];
    let matched = 0;
    for (const f of files) {
      const pf = procByIno.get(f.ino);
      if (!pf) continue;
      matched++;
      for (const p of pf) {
        const rel = path.relative(processedRoot, p.path);
        if (rel && !rel.startsWith("..") && !rels.includes(rel)) rels.push(rel);
      }
    }
    return { rels, matched };
  };

  const resolveRow = (rows: any[], key: string, title: string, season: number | null): any =>
    rows.find((r: any) => r.library_key === key && r.season === season) ||
    rows.find((r: any) => normTitle(r.title) === normTitle(title) && r.season === season && !r.library_key) ||
    null;

  // Already-associated processed files per request, so "update" only fires when
  // there is actually something new to merge (an idempotent re-run → noop).
  const ahRows = db
    .prepare(
      "SELECT request_id, processed_files FROM approval_history WHERE release_id IS NULL" +
        " AND request_id IN (SELECT id FROM media_requests WHERE library_key IS NOT NULL)",
    )
    .all() as any[];
  const associatedByRequest = new Map<number, Set<string>>();
  for (const r of ahRows) {
    let set = associatedByRequest.get(r.request_id);
    if (!set) {
      set = new Set<string>();
      associatedByRequest.set(r.request_id, set);
    }
    for (const p of JSON.parse(r.processed_files || "[]")) set.add(p);
  }

  // ---- Phase 1: group every library file by identity -----------------------

  // Movies: identity = folder identity enriched from file names (IMDb id / year).
  const movieGroups = new Map<string, { title: string; year: number | null; dir: string; files: ScannedFile[] }>();
  for (const m of lib.movies) {
    const fileYears: number[] = [];
    const fileImdb: string[] = [];
    for (const f of m.files) {
      const fm = parseLooseMovieName(path.basename(f.path));
      if (fm.year != null) fileYears.push(fm.year);
      if (fm.imdbId) fileImdb.push(fm.imdbId);
    }
    const distinctYears = [...new Set(fileYears)];
    const year = m.year ?? (distinctYears.length === 1 ? distinctYears[0] : null);
    const imdbId = m.imdbId ?? fileImdb[0] ?? null;
    const key = movieKey(imdbId, m.title, year);
    const existing = movieGroups.get(key);
    if (existing) {
      existing.files.push(...m.files);
    } else {
      movieGroups.set(key, { title: m.title, year, dir: m.dir, files: [...m.files] });
    }
  }

  // Series: identity = folder identity enriched from the processed show folder
  // each file links to (cracks DuckTales (1987) vs (2017)).
  const seriesGroups = new Map<string, { title: string; year: number | null; dir: string; season: number; files: ScannedFile[] }>();
  for (const s of lib.shows) {
    let year = s.year;
    if (year == null) {
      const years = new Set<number>();
      for (const f of s.files) {
        for (const pr of procByIno.get(f.ino) || []) {
          if (pr.showYear != null) years.add(pr.showYear);
        }
      }
      if (years.size === 1) year = [...years][0];
    }
    const key = showKey(s.tvdbId, s.imdbId, s.title, year);

    const bySeason = new Map<number, ScannedFile[]>();
    for (const f of s.files) {
      if (f.season == null) continue;
      const arr = bySeason.get(f.season) || [];
      arr.push(f);
      bySeason.set(f.season, arr);
    }

    for (const [season, files] of bySeason) {
      const groupKey = `${key}::${season}`;
      const existing = seriesGroups.get(groupKey);
      if (existing) {
        existing.files.push(...files);
      } else {
        seriesGroups.set(groupKey, { title: s.title, year, dir: s.dir, season, files: [...files] });
      }
    }
  }

  // ---- Phase 2: candidate per identity -------------------------------------

  const candidates: LibraryImportCandidate[] = [];

  for (const [key, g] of movieGroups) {
    const { rels, matched } = processedRelPathsFor(g.files, PROCESSED_MOVIES);
    const existing = resolveRow(movieRows, key, g.title, null);
    const base = {
      kind: "movie" as const,
      title: g.title,
      year: g.year,
      libraryDir: g.dir,
      libraryKey: key,
      season: null,
      episodeCount: null,
      filesMatched: matched,
      filesTotal: g.files.length,
      processedRelPaths: rels,
      requestId: existing?.id ?? null,
      existingStatus: existing?.status ?? null,
      existingEpisodeCount: existing?.episode_count ?? null,
    };
    if (!existing) {
      candidates.push({ ...base, action: "create" });
    } else if (ACTIVE_STATUSES.has(existing.status)) {
      candidates.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
    } else if (!existing.library_key) {
      candidates.push({ ...base, action: "adopt", reason: DORMANT_STATUSES.has(existing.status) ? `was ${existing.status}` : undefined });
    } else if (existing.status !== "COMPLETED") {
      candidates.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
    } else {
      const associated = associatedByRequest.get(existing.id) ?? new Set<string>();
      const missing = base.processedRelPaths.filter((p) => !associated.has(p));
      candidates.push(missing.length ? { ...base, action: "update" } : { ...base, action: "noop" });
    }
  }

  for (const [groupKey, g] of [...seriesGroups.entries()].sort(
    (a, b) => a[1].title.localeCompare(b[1].title) || a[1].season - b[1].season,
  )) {
    const key = groupKey.slice(0, groupKey.lastIndexOf("::"));
    const { rels, matched } = processedRelPathsFor(g.files, PROCESSED_TV);
    const existing = resolveRow(seriesRows, key, g.title, g.season);
    const base = {
      kind: "series" as const,
      title: g.title,
      year: g.year,
      libraryDir: g.dir,
      libraryKey: key,
      season: g.season,
      episodeCount: distinctEpisodes(g.files),
      filesMatched: matched,
      filesTotal: g.files.length,
      processedRelPaths: rels,
      requestId: existing?.id ?? null,
      existingStatus: existing?.status ?? null,
      existingEpisodeCount: existing?.episode_count ?? null,
    };
    if (!existing) {
      candidates.push({ ...base, action: "create" });
    } else if (ACTIVE_STATUSES.has(existing.status)) {
      candidates.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
    } else if (!existing.library_key) {
      candidates.push({ ...base, action: "adopt", reason: DORMANT_STATUSES.has(existing.status) ? `was ${existing.status}` : undefined });
    } else if (existing.status !== "COMPLETED") {
      candidates.push({ ...base, action: "skip", reason: `existing request ${existing.status}` });
    } else {
      const associated = associatedByRequest.get(existing.id) ?? new Set<string>();
      const missing = base.processedRelPaths.filter((p) => !associated.has(p));
      const epStale = existing.episode_count == null || base.episodeCount !== existing.episode_count;
      candidates.push(missing.length || epStale ? { ...base, action: "update" } : { ...base, action: "noop" });
    }
  }

  const totals = { create: 0, adopt: 0, update: 0, skip: 0 };
  for (const c of candidates) if (c.action !== "noop") totals[c.action]++;

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
  const findByKey = db.prepare("SELECT id, season FROM media_requests WHERE library_key = ? AND type = ?");
  const findKeylessByTitle = db.prepare(
    "SELECT id, title, status, episode_count FROM media_requests WHERE type = ? AND library_key IS NULL",
  );
  const setKey = db.prepare("UPDATE media_requests SET library_key = ?, status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?");

  const createdIds: number[] = [];
  const adoptedIds: number[] = [];
  let filesAssociated = 0;
  const totals = { create: 0, adopt: 0, update: 0, skip: 0 };

  for (const c of plan.candidates) {
    if (c.action === "noop") continue;
    totals[c.action]++;
    if (c.action === "skip") continue;

    if (c.action === "create") {
      // Defensive: the planner may be stale relative to the DB. Never create a
      // duplicate row — fold into whichever existing row shares the identity.
      const byKey = (findByKey.all(c.libraryKey, c.kind) as any[]).filter(
        (r: any) => r.season == c.season, // loose: null == null, 1 == 1
      );
      // A row from an older build may key off the folder slug (or nothing);
      // reclaim it by normalized title instead of creating a duplicate.
      const byTitle = !byKey.length
        ? (findKeylessByTitle.all(c.kind) as any[]).find((r: any) => normTitle(r.title) === normTitle(c.title))
        : null;
      if (byKey.length || byTitle) {
        const row = byTitle ?? byKey[0];
        console.warn(
          `[ImportLibrary] plan${c.kind === "series" ? ` ${c.libraryKey} S${c.season}` : ` ${c.libraryKey}`} will not create — row #${row.id} already holds this identity; merging instead`,
        );
        totals.create--;
        totals.update++;
        if (c.kind === "series" && c.episodeCount != null && c.episodeCount !== c.existingEpisodeCount) {
          db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(c.episodeCount, row.id);
        }
        if (byTitle) {
          setKey.run(c.libraryKey, row.id);
          console.warn(`[ImportLibrary]   reclaimed old row #${row.id} (${row.status}) → ${c.libraryKey}`);
        }
        attachProcessed(db, row.id, c.processedRelPaths);
        continue;
      }
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
      // Refresh a stale episode count (imports bump file parsing; sonarr-less
      // rows can otherwise be stuck on an undercount forever).
      if (c.kind === "series" && c.episodeCount != null && c.episodeCount !== c.existingEpisodeCount) {
        db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(c.episodeCount, c.requestId);
      }
      attachProcessed(db, c.requestId, c.processedRelPaths);
    }
    filesAssociated += c.processedRelPaths.length;
  }

  return { totals, createdIds, adoptedIds, filesAssociated };
}