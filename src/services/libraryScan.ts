import fs from "fs";
import path from "path";
import {
  DOWNLOADS_MOVIES,
  DOWNLOADS_TV,
  MEDIA_MOVIES,
  MEDIA_TV,
  PROCESSED_MOVIES,
  PROCESSED_TV,
} from "../config/paths";

export const VIDEO_EXTS = [".mkv", ".mp4", ".avi", ".mov", ".ts", ".wmv", ".m4v"];

const IMDB_RE = /\btt(\d{7,8})\b/;
const TVDB_RE = /\btvdbid[\s-]?(\d+)\b/i;
const YEAR_RE = /[\[(](\d{4})[\])]/;
/** "(1957-2002)" and "2017-2021" both appear; the first year is what matters. */
const YEAR_RANGE_RE = /[\[(]?((?:19|20)\d{2})\s*[-/]\s*(?:19|20)\d{2}[\])]?/;
/** Unbracketed year, e.g. "Dune.2021.1080p". Only a last resort -- a title can
 *  contain a bare number ("1917 (2019)"), so a bracketed year must win. */
const BARE_YEAR_RE = /(?:^|[.\s[(])((?:19|20)\d{2})(?=[.\s\]),]|$)/;
export const SEASON_DIR_RE =
  /(?:^|[^a-z0-9])(?:s(\d{1,2})|season[\s._-]*(\d{1,2})|sezon[\s._-]*(\d{1,2}))(?![0-9])/i;
/** "Sezon III" -- the Polish library uses Roman numerals for season folders. */
export const ROMAN_SEASON_RE = /(?:^|[^a-z0-9])(?:season|sezon)[\s._-]*([ivxlc]{1,5})(?![a-z0-9])/i;

function romanToNumber(raw: string): number | null {
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  const s = raw.toLowerCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = map[s[i]];
    if (v === undefined) return null;
    // A smaller numeral before a larger one is subtracted (IV = 4, IX = 9).
    total += i + 1 < s.length && map[s[i + 1]] > v ? -v : v;
  }
  return total > 0 && total <= 99 ? total : null;
}
const EPISODE_RE = /\bs(\d{1,2})e(\d{1,3})\b/i;
/** Trailing metadata groups: ids, season hints, quality, language, release group. */
const BRACKET_GROUP_RE = /[\[({][^\])}]*[\])}]/g;

export function isVideoFile(p: string): boolean {
  return VIDEO_EXTS.includes(path.extname(p).toLowerCase());
}

/** Find an IMDb id anywhere in the given strings, e.g. "(imdbid-tt0133093)". */
export function findImdbId(candidates: string[]): string | null {
  for (const c of candidates) {
    const m = c.match(IMDB_RE);
    if (m) return `tt${m[1]}`;
  }
  return null;
}

/** TVDB id, present on many library show folders where no IMDb id is. */
export function findTvdbId(candidates: string[]): string | null {
  for (const c of candidates) {
    const m = c.match(TVDB_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Best-effort title for a loose video file sitting directly in a movies root,
 * e.g. "Dune.2021.1080p.WEB-DL.x264-GRP.mkv". Low confidence by nature -- the
 * authoritative movie title comes from the library folder name when there is
 * one, since processed names are a mix of torrent and formatted styles.
 */
export function parseLooseMovieName(name: string): {
  title: string;
  year: number | null;
  imdbId: string | null;
  tvdbId: string | null;
} {
  return parseDirName(path.parse(name).name);
}

/**
 * Split a directory name into title, year and IMDb id.
 *
 * Handles the shapes seen in the library: "The Movie (2020)",
 * "Some Show (2019) [imdbid-tt0109830]", "Another Show (2020) [tt1234567]".
 * The IMDb id is the reliable key here -- titles are unreliable once a library
 * picks up bilingual or alternate names.
 */
export function parseDirName(name: string): {
  title: string;
  year: number | null;
  imdbId: string | null;
  tvdbId: string | null;
} {
  const imdbId = findImdbId([name]);
  const tvdbId = findTvdbId([name]);

  // Everything from the year onwards is metadata, not title. Resolve the year
  // once, in decreasing order of trust, then cut there -- so a bare year in
  // "Dune.2021.1080p.WEB-DL.x264-GRP" also strips the release tail.
  const yearMatch =
    name.match(YEAR_RANGE_RE) || name.match(YEAR_RE) || name.match(BARE_YEAR_RE);
  let rest =
    yearMatch && yearMatch.index !== undefined
      ? name.slice(0, yearMatch.index)
      : name;
  // A bracket left dangling by the cut, e.g. "Avatar - The Last Airbender (2024)".
  rest = rest.replace(/[[({]\s*$/, "");

  let title = rest.replace(BRACKET_GROUP_RE, " ");
  // Release/source junk that is not bracketed, e.g. the tail of
  // "Krecik  Krtek (1957-2002) {Sezon 1} DVDRip AVC (Lektor PL) NoGrp [R68]".
  // A bare year with no brackets, e.g. "Kacze opowieści - DuckTales 2017-2021".
  // YEAR_RANGE_RE already covers the hyphenated form.
  // Work on a dotted/underscored token list rather than a flattened string, so
  // a token is dropped only when it is recognisably release metadata. Guessing
  // at trailing release groups by shape would eat real title words ("The
  // Smurfs" -> "The"), so that is deliberately not done: a slightly messy
  // title is much cheaper to fix than a truncated one.
  const drop = [
    /^(?:19|20)\d{2}$/, // bare year
    /^\d{3,4}[pi]$/, // 1080p
    /^(?:4k|uhd|hd|bd|sd|remux|bdrip|dvdrip|web|webrip|web-dl|hdtv|dvd|video)$/i,
    /^(?:x|h)[ .]?26[45](?:[-._][a-z0-9]{2,12})?$/i, // x264-GRP, 264-AL3X, H.264
    /^(?:h|hevc|avc|xvid|divx)$/i,
    /^(?:mkv|mp4|avi|mov|ts|m4v)$/i,
    /^(?:pl|en|de|fr|es|it|nl|sv|no|da|fi|cs|hu|ro|tr|jp|kr|cn|multi)$/i,
    /^(?:dub|dubbing|napis|sub|subs|subbed|dual|lektor)$/i,
    /^s(?:eason|ezon)?[\s._-]*\d{1,2}$/i,
    /^(?:no?grp|rarbg|yify|yts|ettv|eldb|amzn|ntb|pldub|0nnline)$/i,
  ];
  const words = title
    .split(/[.\s_]+/)
    .map((w) => w.trim())
    .filter((w) => w && !drop.some((re) => re.test(w)));

  title = words.join(" ").replace(/\s{2,}/g, " ").trim();

  return { title: title || name, year: yearMatch ? Number(yearMatch[1]) : null, imdbId, tvdbId };
}

export interface ScannedFile {
  path: string;
  ino: number;
  size: number;
  season: number | null;
  episode: number | null;
  /** How the season number was determined, for reporting parse reliability. */
  seasonSource: "name" | "folder" | "specials" | "unknown";
}

export interface ScannedMovie {
  dir: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tvdbId: string | null;
  files: ScannedFile[];
}

export interface ScannedShow {
  dir: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tvdbId: string | null;
  files: ScannedFile[];
}

export interface Unparsed {
  path: string;
  reason: string;
}

export interface LibraryScan {
  movies: ScannedMovie[];
  shows: ScannedShow[];
  /** Series files with no resolvable season, surfaced rather than guessed at. */
  unparsed: Unparsed[];
  filesScanned: number;
  errors: string[];
}

export interface ProcessedScan {
  movieFiles: ScannedFile[];
  shows: ScannedShow[];
  filesScanned: number;
  errors: string[];
}

function safeStatIno(p: string): { ino: number; size: number } | null {
  try {
    const st = fs.lstatSync(p);
    return { ino: st.ino, size: st.size };
  } catch {
    return null;
  }
}

function listEntries(dir: string, errors: string[]): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    errors.push(`${dir}: ${e.message}`);
    return [];
  }
}

/**
 * Collect video files under a root. `maxDepth` is the deepest level at which
 * files are collected: 0 means files sitting directly in the root, and
 * undefined means unlimited. Directories are only entered while they can still
 * contain collectable files, so a movie folder with an "Extras/" subtree yields
 * only its own cuts.
 */
function walkFiles(root: string, errors: string[], maxDepth?: number): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    for (const entry of listEntries(dir, errors)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (maxDepth === undefined || depth + 1 <= maxDepth) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile() && isVideoFile(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Resolve season/episode for a file inside a show directory.
 *
 * Priority: an explicit SxxExx in the filename wins, then a season directory
 * component, then season 0 for files sitting loose in the show root (which is
 * how specials are stored in the library).
 */
function resolveEpisode(
  filePath: string,
  showRoot: string,
): { season: number | null; episode: number | null; source: ScannedFile["seasonSource"] } {
  const base = path.basename(filePath);
  const nameMatch = base.match(EPISODE_RE);
  if (nameMatch) {
    return { season: Number(nameMatch[1]), episode: Number(nameMatch[2]), source: "name" };
  }

  const rel = path.relative(showRoot, path.dirname(filePath));
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    const m = part.match(SEASON_DIR_RE);
    if (m) {
      return { season: Number(m[1] ?? m[2] ?? m[3]), episode: null, source: "folder" };
    }
    const rm = part.match(ROMAN_SEASON_RE);
    if (rm) {
      const n = romanToNumber(rm[1]);
      if (n !== null) return { season: n, episode: null, source: "folder" };
    }
  }

  if (rel === "" || rel === ".") {
    // Loose in the show root. These are specials in the library layout.
    return { season: 0, episode: null, source: "specials" };
  }

  return { season: null, episode: null, source: "unknown" };
}

function toScannedFile(filePath: string, showRoot: string | null): ScannedFile | null {
  const st = safeStatIno(filePath);
  if (!st) return null;
  const ep = showRoot ? resolveEpisode(filePath, showRoot) : { season: null, episode: null, source: "unknown" as const };
  return {
    path: filePath,
    ino: st.ino,
    size: st.size,
    season: ep.season,
    episode: ep.episode,
    seasonSource: ep.source,
  };
}

/**
 * Walk the library trees.
 *
 * Movies are top-level directories (or loose files). Series are top-level
 * directories walked recursively, since the library stores episodes at
 * inconsistent depths.
 */
export function scanLibrary(
  moviesDir: string = MEDIA_MOVIES,
  seriesDir: string = MEDIA_TV,
): LibraryScan {
  const movies: ScannedMovie[] = [];
  const shows: ScannedShow[] = [];
  const unparsed: Unparsed[] = [];
  const errors: string[] = [];
  let filesScanned = 0;

  for (const entry of listEntries(moviesDir, errors)) {
    const full = path.join(moviesDir, entry.name);
    if (entry.isFile()) {
      if (!isVideoFile(full)) continue;
      const f = toScannedFile(full, null);
      if (!f) continue;
      filesScanned++;
      const loose = parseLooseMovieName(entry.name);
      movies.push({ ...loose, tvdbId: null, dir: moviesDir, files: [f] });
      continue;
    }
    if (!entry.isDirectory()) continue;

    const meta = parseDirName(entry.name);
    const files: ScannedFile[] = [];
    // Only files sitting directly in the movie folder count as versions. A full
    // Blu-ray extract also nests featurettes under "Extras/" -- Pitch Black
    // keeps its Director's Cut and Theatrical cuts here plus 56 extras deeper,
    // and recursing would report 58 versions for a movie that has two.
    for (const f of walkFiles(full, errors, 0)) {
      const sf = toScannedFile(f, null);
      if (sf) {
        files.push(sf);
        filesScanned++;
      }
    }
    if (files.length) {
      // Movie ids usually live in the filename, not the folder: the folder is
      // "Avatar (2009)" while the file is "avatar.2009.1080p.web-dl.tt1049413.mkv".
      movies.push({
        ...meta,
        imdbId: meta.imdbId ?? findImdbId(files.map((f) => path.basename(f.path))),
        dir: full,
        files,
      });
    }
  }

  for (const entry of listEntries(seriesDir, errors)) {
    const full = path.join(seriesDir, entry.name);
    if (!entry.isDirectory()) continue;

    const meta = parseDirName(entry.name);
    const files: ScannedFile[] = [];
    for (const f of walkFiles(full, errors)) {
      const sf = toScannedFile(f, full);
      if (!sf) continue;
      filesScanned++;
      if (sf.season === null) {
        unparsed.push({ path: sf.path, reason: "no SxxExx in name and no season directory" });
      }
      files.push(sf);
    }
    if (files.length) {
      shows.push({
        ...meta,
        // Show ids likewise tend to sit in the episode filenames.
        imdbId: meta.imdbId ?? findImdbId(files.map((f) => path.basename(f.path))),
        dir: full,
        files,
      });
    }
  }

  return { movies, shows, unparsed, filesScanned, errors };
}

/**
 * Walk the processed trees.
 *
 * Processed movies are a flat dump of files with mixed naming, so no title is
 * derived here -- movie identity comes from the library side of the join.
 * Processed series follow <show>/Sxx/ and are the reliable season source.
 */
export function scanProcessed(
  moviesDir: string = PROCESSED_MOVIES,
  seriesDir: string = PROCESSED_TV,
): ProcessedScan {
  const movieFiles: ScannedFile[] = [];
  const shows: ScannedShow[] = [];
  const errors: string[] = [];
  let filesScanned = 0;

  for (const f of walkFiles(moviesDir, errors)) {
    const sf = toScannedFile(f, null);
    if (sf) {
      movieFiles.push(sf);
      filesScanned++;
    }
  }

  for (const entry of listEntries(seriesDir, errors)) {
    const full = path.join(seriesDir, entry.name);
    if (!entry.isDirectory()) continue;

    const meta = parseDirName(entry.name);
    const files: ScannedFile[] = [];
    for (const f of walkFiles(full, errors)) {
      const sf = toScannedFile(f, full);
      if (!sf) continue;
      filesScanned++;
      files.push(sf);
    }
    if (files.length) shows.push({ ...meta, dir: full, files });
  }

  return { movieFiles, shows, filesScanned, errors };
}

/**
 * Walk the download trees.
 *
 * Download is the source of truth: qBittorrent seeds from it, so it is read
 * only. It is not organised the way the library is -- a movie may be a bare
 * release-named file in the root or wrapped in its own release folder, and a
 * series arrives as one multi-season release folder. Season and episode
 * numbers are therefore taken from the file names wherever they appear, and the
 * containing folder name is only a fallback.
 *
 * No title is derived for movie files: the library supplies movie identity and
 * the join is by inode, so guessing here would only add noise.
 */
export function scanDownload(
  moviesDir: string = DOWNLOADS_MOVIES,
  seriesDir: string = DOWNLOADS_TV,
): ProcessedScan {
  const movieFiles: ScannedFile[] = [];
  const shows: ScannedShow[] = [];
  const errors: string[] = [];
  let filesScanned = 0;

  for (const f of walkFiles(moviesDir, errors)) {
    const sf = toScannedFile(f, null);
    if (sf) {
      movieFiles.push(sf);
      filesScanned++;
    }
  }

  for (const entry of listEntries(seriesDir, errors)) {
    const full = path.join(seriesDir, entry.name);
    if (entry.isFile()) {
      if (!isVideoFile(full)) continue;
      const sf = toScannedFile(full, seriesDir);
      if (!sf) continue;
      filesScanned++;
      movieFiles.push(sf);
      continue;
    }
    if (!entry.isDirectory()) continue;

    const meta = parseDirName(entry.name);
    const files: ScannedFile[] = [];
    for (const f of walkFiles(full, errors)) {
      const sf = toScannedFile(f, full);
      if (!sf) continue;
      filesScanned++;
      files.push(sf);
    }
    if (files.length) shows.push({ ...meta, dir: full, files });
  }

  return { movieFiles, shows, filesScanned, errors };
}
