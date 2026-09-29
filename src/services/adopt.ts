import fs from "fs";
import path from "path";
import { DOWNLOADS_TV, PROCESSED_MOVIES, PROCESSED_TV } from "../config/paths";
import { parseDirName, scanDownload, scanLibrary, scanProcessed, type ScannedFile } from "./libraryScan";

/**
 * Adoption closes the gap where a file is in the library but has no counterpart
 * in processed, by hardlinking the library copy into processed.
 *
 * Strictness matters here, and differs from processor.ts's hardlinkFile:
 *
 * - Never fall back to copying. A copy on EXDEV would triple the disk usage of
 *   exactly the largest files, silently. A cross-device export is reported as
 *   an error for the operator to resolve.
 * - Never overwrite, and never skip a destination quietly. A destination that
 *   exists with a different inode is a name collision and is reported, not
 *   resolved by deleting anything.
 * - Never touch the library or download trees. Adoption only ever adds links
 *   under processed.
 */

export interface AdoptionItem {
  kind: "movie" | "series";
  source: string;
  sourceIno: number;
  destination: string;
  /** Processed show folder this file will live in (series only). */
  showFolder: string | null;
  season: number | null;
  inDownload: boolean;
}

export interface AdoptionConflict {
  destination: string;
  reason: string;
  source: string;
}

export interface AdoptionPlan {
  items: AdoptionItem[];
  conflicts: AdoptionConflict[];
  /** Library files already present in processed; nothing to do. */
  alreadyPresent: number;
  errors: string[];
  totals: { movies: number; series: number };
}

export interface PlanOptions {
  /** Only plan files whose inode also appears in download. Default true. */
  requireDownloadOrigin?: boolean;
  onlyMovies?: boolean;
  onlySeries?: boolean;
  /** Restrict to these library show directories. */
  showDirs?: string[];
  /** Restrict to these library movie directories. */
  movieDirs?: string[];
}

/** Processed show folder name derived from a library show directory. */
export function processedShowName(libraryShowDir: string): string {
  const base = path.basename(libraryShowDir);
  const { title, year } = parseDirName(base);
  return year ? `${title} (${year})` : title;
}

function seasonFolder(season: number | null): string {
  if (season === null || Number.isNaN(season)) return "S00";
  return `S${String(season).padStart(2, "0")}`;
}

function existsWithIno(target: string, ino: number): "absent" | "same" | "different" {
  try {
    const st = fs.statSync(target);
    return st.ino === ino ? "same" : "different";
  } catch (err: any) {
    if (err.code === "ENOENT") return "absent";
    throw err;
  }
}

/**
 * Build the set of hardlinks processed would need. Read only: touches nothing
 * on disk.
 */
export function planAdoption(options: PlanOptions = {}): AdoptionPlan {
  const requireOrigin = options.requireDownloadOrigin !== false;
  const errors: string[] = [];

  const lib = scanLibrary();
  const proc = scanProcessed();
  const dl = scanDownload();

  const procFiles: ScannedFile[] = [
    ...proc.movieFiles,
    ...proc.shows.flatMap((s) => s.files),
  ];
  const procIno = new Set(procFiles.map((f) => f.ino));

  const dlFiles: ScannedFile[] = [...dl.movieFiles, ...dl.shows.flatMap((s) => s.files)];
  const dlIno = new Set(dlFiles.map((f) => f.ino));

  const items: AdoptionItem[] = [];
  const conflicts: AdoptionConflict[] = [];
  let alreadyPresent = 0;

  const wantMovies = !options.onlySeries;
  const wantSeries = !options.onlyMovies;
  const movieFilter = options.movieDirs ? new Set(options.movieDirs) : null;
  const showFilter = options.showDirs ? new Set(options.showDirs) : null;

  const consider = (
    f: ScannedFile,
    kind: "movie" | "series",
    showFolder: string | null,
  ): void => {
    if (procIno.has(f.ino)) {
      alreadyPresent++;
      return;
    }
    if (requireOrigin && !dlIno.has(f.ino)) return;

    const destination =
      kind === "movie"
        ? path.join(PROCESSED_MOVIES, path.basename(f.path))
        : path.join(PROCESSED_TV, showFolder!, seasonFolder(f.season), path.basename(f.path));

    let state: "absent" | "same" | "different";
    try {
      state = existsWithIno(destination, f.ino);
    } catch (err: any) {
      errors.push(`stat ${destination}: ${err.message}`);
      return;
    }
    if (state === "same") {
      alreadyPresent++;
      return;
    }
    if (state === "different") {
      conflicts.push({
        destination,
        source: f.path,
        reason: "a different file already occupies this processed path",
      });
      return;
    }

    items.push({
      kind,
      source: f.path,
      sourceIno: f.ino,
      destination,
      showFolder,
      season: f.season,
      inDownload: dlIno.has(f.ino),
    });
  };

  if (wantMovies) {
    for (const m of lib.movies) {
      if (movieFilter && !movieFilter.has(m.dir)) continue;
      for (const f of m.files) consider(f, "movie", null);
    }
  }

  if (wantSeries) {
    for (const s of lib.shows) {
      if (showFilter && !showFilter.has(s.dir)) continue;
      const folder = processedShowName(s.dir);
      for (const f of s.files) consider(f, "series", folder);
    }
  }

  return {
    items,
    conflicts,
    alreadyPresent,
    errors,
    totals: {
      movies: items.filter((i) => i.kind === "movie").length,
      series: items.filter((i) => i.kind === "series").length,
    },
  };
}

export interface AdoptionResult {
  linked: string[];
  failed: Array<{ destination: string; error: string }>;
}

/** Carry out a plan. Only ever creates new hardlinks under processed. */
export function executeAdoption(plan: AdoptionPlan): AdoptionResult {
  const linked: string[] = [];
  const failed: AdoptionResult["failed"] = [];

  for (const item of plan.items) {
    try {
      fs.mkdirSync(path.dirname(item.destination), { recursive: true });
      fs.linkSync(item.source, item.destination);
      linked.push(item.destination);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Raced with another run; treat as already done rather than an error.
        linked.push(item.destination);
        continue;
      }
      failed.push({
        destination: item.destination,
        error:
          err.code === "EXDEV"
            ? "EXDEV: processed is on a different filesystem, refusing to copy"
            : `${err.code || "ERR"}: ${err.message}`,
      });
    }
  }

  return { linked, failed };
}
