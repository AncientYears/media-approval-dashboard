import { Router, Request, Response } from "express";
import { Database } from "better-sqlite3";
import { RadarrService } from "../services/radarr";
import { SonarrService } from "../services/sonarr";
import { QBittorrentService } from "../services/qbittorrent";
import { ProwlarrService, ProwlarrRelease } from "../services/prowlarr";
import { RadarrSearchResult } from "../types/index";
import { computeAppScore } from "../services/scoring";
import {
  scanDownload,
  scanLibrary,
  scanProcessed,
  type ScannedFile,
  parseDirName,
} from "../services/libraryScan";
import { executeAdoption, planAdoption } from "../services/adopt";
import { planLibraryImport, executeLibraryImport } from "../services/libraryImport";
import { registerVideoTree, identifyByPath, autodetectIdentity, deriveIdentityFromFilename, embeddedIdContradicts, episodeNumsFromFilename } from "../services/identity";
import { fetchTMDBSeason, fetchTMDBTVSeasons, cachedShowIdForKey, resolveShowIdentity, 
resolveMovieIdentity, searchTMDB, fetchTMDBById, resolveExternalIds, fetchExternalIds, resolveSpecialIdentity, 
episodeTitleFromCache, episodeAirDateFromCache, findSpecialByAirDate, isTmdbConfigured, franchiseEpisodeOrder, 
fetchEpisodeGroups, type SeasonMeta, type NamingDiag } from "../services/tmdb";
import {
  loadNamingConf,
  vendorList,
  parseReleaseTags,
  assembleCanonicalTags,
  inheritReleaseFacts,
  parseEpisodeCode,
  episodeTitleFromSourceName,
  partMarkerFromSourceName,
  stripPartMarker,
  stripPartFromSourceName,
  partGroupKey,
  partNumberIn,
  needsPartOne,
  canonicalMovieFile,
  canonicalSpecialFile,
  canonicalEpisodeFile,
  canonicalMovieDir,
  canonicalSeriesDir,
  canonicalSeasonDir,
  uniqueDestPath,
  type ProbeInfo,
} from "../config/naming";
import { probeVideoFile } from "../services/mediaProbe";
import { seerrRemoveRequest } from "../services/seerr";
import { parseTorrentName, formatEpisodes, parseQualityFromName } from "../utils/torrentParser";
import { processToLibrary, processFile, ProcessOptions, moveToProcessedSync, moveToLibrarySync, moveToWorkspaceSync, getProcessedDir, listWorkspaces, writeWorkspaceMetadata, readWorkspaceMetadata, completeWorkspace, deleteWorkspaceInputs, deleteWorkspaceFile, deleteWorkspace } from "../services/processor";
import {
  fromQBittorrentPath,
  toQBittorrentPath,
  DOWNLOADS_MOVIES,
  DOWNLOADS_TV,
  PROCESSED_MOVIES,
  PROCESSED_TV,
  PROCESSING_WORKSPACE,
  TRACKERS_DIR,
  MEDIA_TV,
  MEDIA_MOVIES,
} from "../config/paths";
import fs from "fs";
import path from "path";

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20 };

function parseSeasonNumber(dirName: string): number | null {
  // Specials, Season 00, etc.
  if (/^specials$/i.test(dirName)) return 0;
  // S01, S02, etc.
  let m = dirName.match(/\bS(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  // Season 1, Season 01, etc.
  m = dirName.match(/\bSeason\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  // Sezon 1, Sezon I, Sezon II, etc.
  m = dirName.match(/\bSezon\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  m = dirName.match(/\bSezon\s+([IVXLCDM]+)\b/i);
  if (m) return ROMAN[m[1].toUpperCase()] || null;
  return null;
}

function normalizeTitleForMatch(s: string): string {
  return s.toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[:']/g, " ")
    .replace(/[.\-_\[\](){}!@#$%^+=|;<>?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSeasonPackTitle(title: string, season: number): boolean {
  const seasonPattern = new RegExp(`\\bS${String(season).padStart(2, "0")}\\b`, "i");
  if (seasonPattern.test(title) && !/\bE\d{1,3}\b/i.test(title)) return true;
  // Check season range patterns like S01-S03 or S01-03
  const range = title.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\b/i);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = parseInt(range[2], 10);
    if (season >= start && season <= end) return true;
  }
  return false;
}

/** The first episode number a filename states, or null — a thin wrapper over
 *  the shared range-aware parser, for the presence checks that only need to
 *  know "does this name carry a number". Coverage scans that CREDIT numbers
 *  must call `episodeNumsFromFilename` instead: a packed range (`S01E01-02`)
 *  credits BOTH halves, and a first-number-only read leaves every even episode
 *  of a double-feature pack missing from the grid. */
function extractEpisodeFromFilename(filePath: string): number | null {
  const nums = episodeNumsFromFilename(filePath);
  return nums.length ? nums[0] : null;
}

/**
 * Episode numbers physically present for a request: torrent-parsed episodes,
 * processed_files entries, and a disk scan of the season folder (disk wins).
 * Mirrors the /managed coverage computation so the grid matches the dashboard.
 */
function coveredEpisodesForRequest(db: Database, req: any): Set<number> {
  const coveredEps = new Set<number>();
  const baseTitle = (req.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
  const season = req.season ?? 0;

  // Self-heal stored processed_files paths on access: any entry whose on-disk
  // path is missing is relocated by registered inode identity (hardlinks share
  // the inode, so a moved/renamed file is found in the request's season folder)
  // and the AH row is rewritten. Read-time repair — names are never trusted.
  if (req.id && Number(req.id) > 0) {
    healProcessedFilesForRequest(db, req);
    backfillRequestIdentity(db, req);
  }

  const coveredRows = db.prepare(`
    SELECT rc.parsed_episodes, rc.title FROM release_candidates rc
    JOIN approval_history ah ON ah.release_id = rc.id
    WHERE ah.request_id = ? AND rc.torrent_hash != ''
  `).all(req.id) as any[];
  for (const cr of coveredRows) {
    if (cr.parsed_episodes) {
      const epMatches = cr.parsed_episodes.match(/E(\d{1,3})/g);
      if (epMatches) for (const em of epMatches) coveredEps.add(parseInt(em.slice(1), 10));
      const rangeMatch = cr.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
      if (rangeMatch) {
        for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) coveredEps.add(i);
      }
    } else if (req.episode_count && season != null && isSeasonPackTitle(cr.title || "", season)) {
      for (let i = 1; i <= req.episode_count; i++) coveredEps.add(i);
    }
  }

  const processedAh = db.prepare(`
    SELECT processed_files FROM approval_history
    WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'
  `).all(req.id) as any[];
  const diskEps = new Set<number>();
  let seasonFolderExists = false;
  const seasonFolder = seasonFolderForLibraryKey(db, req.library_key, baseTitle, season);
  // processed_files entries are stored relative to the processed root: series
  // as show/Sxx/name, movies as a flat basename. Resolve that root so inode
  // lookups work; null when we cannot be sure of the layout for this request.
  const processedRoot = seasonFolder
    ? path.dirname(path.dirname(seasonFolder))
    : req.type === "movie"
      ? PROCESSED_MOVIES
      : null;
  try {
    if (seasonFolder && fs.existsSync(seasonFolder)) {
      seasonFolderExists = true;
      for (const f of fs.readdirSync(seasonFolder)) {
        if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
        const epNums = episodeNumsFromFilename(f);
        if (epNums.length) {
          for (const n of epNums) diskEps.add(n);
          continue;
        }
        // Identity-first fallback: the name tells us nothing (renamed or
        // unparseable) but the inode's registered identity holds the episode
        // numbers. Only numbered rows count toward coverage — S0X specials stay
        // presentation-only like the filename parser treats them.
        const row = identifyByPath(db, path.join(seasonFolder, f));
        if (row && row.role === "numbered" && row.season === season) {
          for (const n of JSON.parse(row.episode_nums || "[]")) diskEps.add(Number(n));
        }
      }
    }
  } catch {}
  for (const pa of processedAh) {
    const files: string[] = JSON.parse(pa.processed_files || "[]");
    for (const pf of files) {
      const epNums = episodeNumsFromFilename(pf);
      if (epNums.length) {
        for (const n of epNums) coveredEps.add(n);
        continue;
      }
      const row = processedRoot ? identifyByPath(db, path.join(processedRoot, pf)) : null;
      if (row && row.role === "numbered" && row.season === season) {
        for (const n of JSON.parse(row.episode_nums || "[]")) coveredEps.add(Number(n));
      }
    }
  }

  // The season folder is authoritative even when it is empty: a folder that
  // exists (yet holds nothing for that season) means the request's association
  // is stale or mis-attributed (e.g. episodes that really live in another
  // season folder). Downloads that haven't landed yet have no folder at all,
  // so torrent-parsed coverage survives there.
  if (seasonFolderExists) {
    for (const ep of coveredEps) if (!diskEps.has(ep)) coveredEps.delete(ep);
    for (const ep of diskEps) coveredEps.add(ep);
  }
  return coveredEps;
}

// Count unnumbered presentation files in a season folder (e.g. S00 movies like
// "Across the 2nd Dimension"). These render as always-FILLED SPECIAL rows in the
// episode grid and should count as covered in summary pills too. A file whose
// name won't parse but whose registered inode is a NUMBERED episode is covered,
// not an extra — identity beats guessing twice.
function unnumberedFilesInSeasonFolder(db: Database, baseTitle: string, season: number, year?: number | null): number {
  try {
    const folder = findSeasonFolder(baseTitle, season, year);
    if (!folder) return 0;
    let count = 0;
    for (const f of fs.readdirSync(folder)) {
      if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
      if (extractEpisodeFromFilename(f) != null) continue;
      const row = identifyByPath(db, path.join(folder, f));
      if (row && row.role === "numbered") continue;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Whether a stored name could describe the file whose identity is `row`. */
function storedNameMatchesRow(row: any, baseName: string): boolean {
  if (row.role === "numbered") {
    const nums: number[] = (() => {
      try {
        return JSON.parse(row.episode_nums || "[]");
      } catch {
        return [];
      }
    })();
    const derived = deriveIdentityFromFilename(baseName);
    if (nums.some((n) => derived.episodeNumbers.includes(n))) return true;
  }
  const rb = normalizeTitleForMatch(row.release_name || "");
  const nb = normalizeTitleForMatch(baseName);
  return !!(rb && nb && (rb === nb || nb.includes(rb) || rb.includes(nb)));
}

/**
 * Locate the current on-disk path of a stored processed_files entry whose path
 * is stale (manual mv/rename). Strategy: for each video in the request's likely
 * folders (season folder for series, processed root for movies), look up the
 * registered inode identity and accept a file whose identity agrees with the
 * stored name (episode numbers or normalized release name) AND matches the
 * request's library_key+season. Returns the processed-relative path or null.
 */
function findCurrentPathByIdentity(db: Database, request: any, baseName: string): string | null {
  const type = request.type === "series" ? "series" : "movie";
  const processedDir = getProcessedDir(type);
  const key = request.library_key || "";
  const season = request.season ?? 0;
  const folders: string[] = [];
  if (request.type === "series") {
    const baseTitle = (request.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
    const sf = seasonFolderForLibraryKey(db, request.library_key, baseTitle, season);
    if (sf) folders.push(sf);
  } else {
    folders.push(processedDir);
  }
  for (const folder of folders) {
    if (!folder || !fs.existsSync(folder)) continue;
    for (const f of fs.readdirSync(folder)) {
      if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
      const row = identifyByPath(db, path.join(folder, f));
      if (!row) continue;
      if (row.season !== season) continue;
      if (key && row.library_key && row.library_key !== key) continue;
      if (!storedNameMatchesRow(row, baseName)) continue;
      const rel = path.relative(processedDir, path.join(folder, f));
      if (rel && !rel.startsWith("..")) return rel;
    }
  }
  return null;
}

/**
 * Self-heal all processed_files rows for a request: rewrite stale paths to the
 * file's current location (by inode identity) when one is found. Returns the
 * merged list of kept+healed relative paths across every AH row.
 */
function healProcessedFilesForRequest(db: Database, request: any): string[] {
  const type = request.type === "series" ? "series" : "movie";
  const processedDir = getProcessedDir(type);
  const rows = db
    .prepare(
      "SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'",
    )
    .all(request.id) as any[];
  const out: string[] = [];
  for (const ah of rows) {
    let list: string[];
    try {
      list = JSON.parse(ah.processed_files);
    } catch {
      continue;
    }
    let changed = false;
    const next: string[] = [];
    for (const f of list) {
      // A stored path whose name pins a DIFFERENT film's IMDb id is a forged link
      // left by an earlier title-only match ("Mufasa The Lion King (2024)" listed
      // under "The Lion King (1994)"). The file exists, so the inode healing below
      // would keep it -- drop it here instead, and re-register it under its real owner.
      if (nameContradictsRequest(db, request, path.basename(f))) {
        changed = true;
        reassignContradictedFile(db, path.join(processedDir, f), f);
        console.log(`[Identity] dropped cross-franchise processed_files entry "${f}" from AH#${ah.id} (#${request.id})`);
        continue;
      }
      if (fs.existsSync(path.join(processedDir, f))) {
        next.push(f);
        out.push(f);
        continue;
      }
      const rel = findCurrentPathByIdentity(db, request, path.basename(f));
      if (rel && rel !== f) {
        next.push(rel);
        out.push(rel);
        changed = true;
        console.log(`[Identity] self-healed processed_files AH#${ah.id}: "${f}" → "${rel}"`);
      } else {
        next.push(f);
        out.push(f);
      }
    }
    if (changed) {
      db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(next), ah.id);
    }
  }
  return out;
}

/**
 * Lazy identity backfill: register every video file belonging to this request
 * when it is read, so files that never ran through a writing flow (manual mv,
 * pre-P0 placement, Sonarr-era imports) still get a media_files row. Series:
 * the request's season folder in both processed and library trees. Movie: the
 * flat processed movies root (title-matched only — the root is shared across
 * all movies) plus the resolved library folder(s). Idempotent, DB metadata
 * only; never touches the trees. Returns rows registered.
 */
function backfillRequestIdentity(db: Database, request: any): number {
  if (!request?.library_key) return 0;
  const identity = {
    library_key: request.library_key,
    title: request.title || "",
    season: request.season ?? 0,
  };
  let registered = 0;
  try {
    if (request.type === "series") {
      const baseTitle = (request.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
      const seasonNum = request.season ?? 1;
      const processedFolder = seasonFolderForLibraryKey(db, request.library_key, baseTitle, seasonNum);
      if (processedFolder) registered += registerVideoTree(db, processedFolder, identity);
      try {
        const libFolder = resolveLibraryFolder(request);
        if (libFolder && fs.existsSync(libFolder)) registered += registerVideoTree(db, libFolder, identity);
      } catch {}
    } else if (request.type === "movie") {
      // Movies are flat in the shared processed root, so ONLY register files
      // whose names title-match this request — never the library tree (fuzzy
      // folder matching can collaterally claim a same-franchise movie like
      // Moana (2016) under the Moana 2 key). Library twins get identity via the
      // app's write paths (move-to-library hardlink, import-library backlink).
      const processedDir = getProcessedDir("movie");
      const reqNorm = (request.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (fs.existsSync(processedDir)) {
        for (const f of fs.readdirSync(processedDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          // Registering here is what MAKES the file belong to this request, so a
          // title match alone must never do it: "Mufasa The Lion King (2024)"
          // title-matches "The Lion King (1994)". An embedded id settles it.
          if (nameContradictsRequest(db, request, f)) continue;
          const entryNorm = f.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (titlesMatch(reqNorm, entryNorm)) registered += registerVideoTree(db, path.join(processedDir, f), identity);
        }
      }
    }
  } catch {}
  return registered;
}

// Resolve the library folder for a native (arr-free) request — mirrors the
// move-to-library resolution: fuzzy show folder under MEDIA_TV + existing
// localized season folder (Sezon I, etc.), movies map flat to MEDIA_MOVIES.
// Returns null when the library folder cannot be located.
/** Substring title match that refuses the sequel-prefix trap. As raw text
 *  "…opowiesc iii" CONTAINS "…opowiesc ii", so a plain `includes()` hands a card
 *  its predecessor's folder — the same prefix collision `titlesMatch` learned
 *  about, one layer down in a matcher that never goes through it. Whatever
 *  follows the shared prefix must not be a sequel numeral. */
function includesTitleNorm(a: string, b: string): boolean {
  if (!a.includes(b)) return false;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.startsWith(shorter)) {
    const suffix = longer.slice(shorter.length).trimStart();
    if (suffix && SEQUEL_EXTENSION.test(suffix)) return false;
  }
  return true;
}

/** The identity segment of a series library_key (`series:163281:1997` → "163281").
 *  Only a numeric segment counts: `seriesKeySegment` prefers TVDB then IMDb then a
 *  title slug, and canonical series dirs embed `[tvdbid-####]` and nothing else. */
function seriesKeyIdSegment(libraryKey?: string | null): string | null {
  const seg = (libraryKey ?? "").split(":")[1]?.trim() ?? "";
  return /^\d+$/.test(seg) ? seg : null;
}

/** The title half of a slug-anchored key ("tajemnica-sagali" → "Tajemnica Sagali"),
 *  which is the name Fix Names itself mints — so a folder already renamed to
 *  canonical is reachable by its own name even when the stored title differs. */
function seriesKeySlugTitle(libraryKey?: string | null): string | null {
  const seg = (libraryKey ?? "").split(":")[1]?.trim() ?? "";
  if (!seg || /^\d+$/.test(seg)) return null;
  return seg.replace(/-/g, " ").trim() || null;
}

/** Library show folders stating our own tvdb id. A canonical dir names identity
 *  outright, so this outranks every title signal — and it is the ONLY signal left
 *  once Fix Names has renamed the folder to its canonical name, at which point the
 *  stored title (often a different language: "The Secret of Sagala" vs "Tajemnica
 *  Sagali") can no longer match it. */
function matchLibraryShowFoldersById(id: string): string[] {
  const out: string[] = [];
  try {
    for (const d of fs.readdirSync(MEDIA_TV)) {
      const m = d.match(/\btvdbid[\s-]?(\d+)\b/i);
      if (m && m[1] === id) out.push(path.join(MEDIA_TV, d));
    }
  } catch {}
  return out;
}

/** Every library show folder under MEDIA_TV that fuzzy-matches a title, in
 *  readdir order (an exact-name dir, when present, is returned first). Year is
 *  ignored here — callers disambiguate same-named franchises. */
function matchLibraryShowFolders(baseTitle: string, libraryKey?: string | null): string[] {
  const idSeg = seriesKeyIdSegment(libraryKey);
  if (idSeg) {
    const byId = matchLibraryShowFoldersById(idSeg);
    if (byId.length) return byId;
  }

  const out: string[] = [];
  const direct = baseTitle ? path.join(MEDIA_TV, baseTitle) : "";
  if (direct && fs.existsSync(direct)) out.push(direct);
  const want = normalizeFolder(baseTitle);
  const slugWant = normalizeFolder(seriesKeySlugTitle(libraryKey) ?? "");
  if (!want) {
    // No usable stored title: an exact name match on the key's slug is still a
    // name-stated signal. Deliberately NOT substring-matched — "hobbit" would
    // otherwise sweep in both Hobbit folders and leave year disambiguation to
    // arbitrate a franchise split this matcher has no business deciding.
    if (!slugWant) return out;
    try {
      for (const d of fs.readdirSync(MEDIA_TV)) {
        if (normalizeFolder(d) === slugWant) {
          const full = path.join(MEDIA_TV, d);
          if (!out.includes(full)) out.push(full);
        }
      }
    } catch {}
    return out;
  }
  try {
    for (const d of fs.readdirSync(MEDIA_TV)) {
      const norm = normalizeFolder(d);
      if (!norm) continue;
      if (norm === want || (want.length >= 6 && includesTitleNorm(want, norm)) || (norm.length >= 6 && includesTitleNorm(norm, want))) {
        const full = path.join(MEDIA_TV, d);
        if (!out.includes(full)) out.push(full);
      }
    }
  } catch {}
  return out;
}

/** Locate a native series' library SHOW folder under MEDIA_TV. Prefers the
 *  folder whose year (a span like "1987-1990" counts at both ends) matches the
 *  library_key, so same-named franchises never resolve to each other. */
function resolveLibraryShowFolder(request: { library_key?: string | null; type?: string; title?: string }): string | null {
  if (!request.library_key || request.type !== "series") return null;
  const baseTitle = (request.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
  const candidates = matchLibraryShowFolders(baseTitle, request.library_key);
  if (candidates.length === 0) return null;
  const keyYear = libraryKeyYear(request.library_key);
  if (keyYear != null) {
    const yearHit = candidates.find((d) => folderYears(path.basename(d)).includes(keyYear));
    if (yearHit) return yearHit;
    // No folder carries the year: a lone year-less folder is the strongest
    // signal that THIS show is stored without its year.
    const yearless = candidates.filter((d) => folderYears(path.basename(d)).length === 0);
    if (yearless.length === 1 && candidates.length > 1) return yearless[0];
  }
  return candidates[0];
}

function resolveLibraryFolder(request: {
  library_key?: string | null;
  type?: string;
  title?: string;
  season?: number | null;
}): string | null {
  if (!request.library_key) return null;
  if (request.type === "series") {
    const showFolder = resolveLibraryShowFolder(request);
    if (!showFolder || !fs.existsSync(showFolder)) return null;
    const seasonNum = request.season || 1;
    return findExistingSeasonFolder(showFolder, seasonNum) || path.join(showFolder, `S${String(seasonNum).padStart(2, "0")}`);
  }
  return MEDIA_MOVIES;
}

/** Walk a library show folder (show → Sxx subdirs) and hand every video file to
 *  cb. Bounded depth; a file at the show root is included too. */
function scanVideoTreeFiles(dir: string, cb: (fp: string) => void, depth = 0): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanVideoTreeFiles(full, cb, depth + 1);
    else if (VIDEO_FILE_RE.test(e.name)) cb(full);
  }
}

// ---- Orphaned download-dir scan helpers -------------------------------------------------

function isWithinDownloadRoot(p: string): string {
  const root = isWithinRoot(p, DOWNLOADS_MOVIES) || isWithinRoot(p, DOWNLOADS_TV);
  return root;
}
function isWithinRoot(p: string, root: string): string {
  const rel = path.relative(root, p);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return root;
}

function collectVideoInodes(root: string): Set<number> {
  const inodes = new Set<number>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e.name)) {
        try { inodes.add(fs.statSync(full).ino); } catch {}
      }
    }
  };
  walk(root);
  return inodes;
}

function dirSizeBytes(p: string): number {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(p);
  return total;
}

// Hardlink an entry (file or dir tree) into dest. Mirrors directory structure;
// returns number of files linked. Never copies (EXDEV is an error).
function hardlinkTree(src: string, dest: string): number {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    let count = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      count += hardlinkTree(path.join(src, e.name), path.join(dest, e.name));
    }
    return count;
  }
  if (fs.existsSync(dest)) return 0;
  try {
    fs.linkSync(src, dest);
    return 1;
  } catch (err: any) {
    if (err.code === "EEXIST") return 0;
    if (err.code === "EXDEV") throw new Error(`EXDEV: ${src} is on another filesystem — refusing to copy`);
    throw err;
  }
}

// Dest tree for capturing an orphaned download entry into /Processed.
// Movies: flat under PROCESSED_MOVIES. Series: mirror under PROCESSED_TV/<name>.
function processedDestForEntry(entryPath: string, type: string): { destDir: string; base: string } {
  if (type === "movie") return { destDir: PROCESSED_MOVIES, base: path.basename(entryPath) };
  return { destDir: PROCESSED_TV, base: path.basename(entryPath) };
}

// Find the media_request (native or arr-linked) that a download entry / torrent
// name most plausibly belongs to. Title + type + optional season match, best
// word-overlap wins. Never links across different types.
const TORRENT_DOWNLOADING_STATES = ["downloading", "forceddl", "queueddl", "pauseddl"];
const TORRENT_SEEDING_STATES = ["uploading", "stalledup", "forcedup", "queuedup", "pausedup"];

function findBestRequestForDownload(db: Database, name: string, type: string, season?: number | null): any | null {
  const want = normalizeTitleForMatch(name || "");
  if (!want) return null;
  const rows = db.prepare(
    "SELECT id, title, type, status, season, library_key, sonarr_id, radarr_id FROM media_requests WHERE type = ?"
  ).all(type) as any[];
  let best: any = null;
  let bestScore = 0;
  const wantWords = new Set(want.split(/\s+/));
  // A torrent name that embeds a film's IMDb id ("Mufasa The Lion King (2024)
  // [imdbid-tt13186482]") must not be grabbed for a same-titled request of a
  // different film ("The Lion King (1994)"). Checked before word overlap so it
  // can only ever exclude a candidate.
  const wantImdb = nameImdbId(name || "");
  for (const r of rows) {
    if (season != null && r.season != null && r.season !== season) continue;
    const mine = wantImdb ? requestImdbId(db, r) : null;
    if (wantImdb && mine && wantImdb !== mine) continue;
    const rn = normalizeTitleForMatch(r.title);
    if (!rn || !titlesMatch(rn, want)) continue;
    let score = 0;
    for (const w of rn.split(/\s+/)) if (wantWords.has(w)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// Link a torrent (already in qBittorrent) to the best-matching request by
// creating a release_candidate + approval_history row, so the torrent panel and
// version counts pick it up. Returns the linked request, or null when no match.
function linkTorrentToRequest(db: Database, torrent: any, entryName: string, type: string, downloadRoot: string): any | null {
  const parsed = parseTorrentName((torrent && torrent.name) || entryName);
  const season = type === "series" ? (parsed.season != null ? parsed.season : null) : null;
  const match = findBestRequestForDownload(db, (torrent && torrent.name) || entryName, type, season);
  if (!match) return null;

  const hash = torrent?.hash || "";
  if (!hash) return null;

  const dup = db.prepare(
    "SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?"
  ).get(match.id, hash) as any;
  if (dup) return { ...match, existing: true };

  const sizeMb = Math.round((torrent?.size || 0) / (1024 * 1024));
  const title = torrent?.name || entryName;
  const episodeStr = parsed.season !== null ? (parsed.episodes.length > 0 ? formatEpisodes(parsed) : `S${String(parsed.season).padStart(2, "0")}`) : "";

  const rcResult = db.prepare(
    "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) " +
    "VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
  ).run(
    match.id,
    `attach-${hash.slice(0, 12)}`,
    title,
    sizeMb,
    hash,
    fromQBittorrentPath(torrent?.save_path || downloadRoot),
    parseQualityFromName(title),
    episodeStr
  );
  db.prepare("INSERT INTO approval_history (request_id, release_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(match.id, rcResult.lastInsertRowid);

  // An already-complete torrent should report SEEDING (counts as a version
  // immediately); only genuinely downloading state stays DOWNLOADING.
  const state = String(torrent?.state || "").toLowerCase();
  const isSeeding = TORRENT_SEEDING_STATES.includes(state) || (torrent?.progress === 1 && !TORRENT_DOWNLOADING_STATES.includes(state));
  const newStatus = isSeeding ? "SEEDING" : "DOWNLOADING";
  if (match.status !== newStatus) {
    db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newStatus, match.id);
  }
  console.log(`[DownloadDirs] Linked attached torrent to request #${match.id} (${match.title}) → ${newStatus}`);
  return match;
}

// Locate the native movie's library folder(s) under MEDIA_MOVIES, tolerating
// localized titles and year suffixes (e.g. "Moana 2" → "Vaiana 2 (2026)").
// Returns exact matches if any, otherwise fuzzy candidates, else [MEDIA_MOVIES].
/** Resolve the library folder(s) holding this movie's files.
 *
 *  Order: an id in the FOLDER name, then an id in the video files DIRECTLY inside
 *  it, then title matching. `libraryKey` adds the identity signal that needs no
 *  name at all: a folder holding a hardlink twin whose (dev, inode) is registered
 *  to this request. That is the last resort on purpose — it walks every library
 *  folder, so it only runs when nothing cheaper matched. A Polish-titled folder
 *  holding a canonical-but-id-less file ("Asterix i Obelix W sluzbie Jej
 *  Krolewskiej Mosci (2012)") matches no title and embeds no id, and without the
 *  inode its own file could never be found. */
function nativeMovieLibraryFolders(requestTitle: string, ownImdbId?: string | null, db?: Database, libraryKey?: string | null): string[] {
  const want = normalizeFolder((requestTitle || "").replace(/ \(\d{4}\)$/i, ""));
  const idMatch: string[] = [];
  const exact: string[] = [];
  const fuzzy: string[] = [];
  try {
    for (const d of fs.readdirSync(MEDIA_MOVIES)) {
      const full = path.join(MEDIA_MOVIES, d);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      // Our canonical movie dirs embed the film's real IMDb id, so a folder
      // carrying one states its identity outright. That outranks every title
      // signal, and it is the ONLY signal left once the folder has been renamed
      // to its canonical name: a localized stored title can no longer match an
      // English folder ("Niekonczaca sie opowiesc III" vs "The NeverEnding
      // Story III"), so without this the folder vanishes from its own card the
      // moment Fix Names cleans it up. A folder carrying a DIFFERENT id is a
      // different film that merely shares a title ("Mufasa The Lion King
      // (2024)" vs "The Lion King (1994)") - never let it match.
      const folderImdb = nameImdbId(d);
      if (ownImdbId && folderImdb) {
        if (folderImdb === ownImdbId) idMatch.push(full);
        continue;
      }
      // A folder whose NAME says nothing usable can still be identified by what
      // is inside it. "Akademia pana Kleksa (2023)" shares no word with the
      // card titled "Kleks Academy" and states the wrong year, so no title test
      // can reach it - yet the file it holds is canonical and embeds this film's
      // own id, which settles it. Only an id carried by a file DIRECTLY in the
      // folder counts (a nested id belongs to some other film), and a folder
      // holding a DIFFERENT film's id is excluded outright rather than left for
      // the fuzzy pass, which is what stops a shared title from claiming it.
      if (ownImdbId && !folderImdb) {
        let owns = false;
        let foreign = false;
        let sawFile = false;
        try {
          for (const f of fs.readdirSync(full)) {
            if (!VIDEO_FILE_RE.test(f)) continue;
            sawFile = true;
            const fid = nameImdbId(f);
            if (!fid) continue;
            if (fid === ownImdbId) owns = true;
            else foreign = true;
          }
        } catch {}
        // A folder with no readable video files says nothing about identity, so
        // fall through to the title tests rather than claiming (or rejecting) it.
        if (sawFile) {
          if (owns) {
            if (!foreign) idMatch.push(full);
            continue;
          }
          if (foreign) continue;
        }
      }
      const norm = normalizeFolder(d);
      const normNoYear = normalizeFolder(d.replace(/\(\d{4}\)[-\s].*$/i, "").replace(/\(\d{4}\)$/i, ""));
      if (want && (normNoYear === want || norm === want)) {
        exact.push(full);
      } else if (want && ((want.length >= 6 && includesTitleNorm(want, norm)) || (norm.length >= 6 && includesTitleNorm(norm, want)))) {
        fuzzy.push(full);
      }
    }
  } catch {}
  if (idMatch.length) return idMatch;
  if (exact.length) return exact;
  if (fuzzy.length) return fuzzy;
  // Last resort, and the only signal that needs no name at all: identity. Walk the
  // library for a hardlink twin whose (dev, inode) is registered to this request.
  // A folder can be unreachable by name and by content — "Asterix i Obelix W
  // sluzbie Jej Krolewskiej Mosci (2012)" holds a file that states neither the
  // card's English title nor any IMDb id, so no name test reaches it, yet that
  // file IS this film's twin and settles the folder outright. Deliberately last:
  // this walks every library folder and stats every video in it, so it only runs
  // once the cheap signals have all come up empty.
  if (db && libraryKey) {
    const byTwin = new Set<string>();
    try {
      for (const d of fs.readdirSync(MEDIA_MOVIES)) {
        const full = path.join(MEDIA_MOVIES, d);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          for (const f of fs.readdirSync(full)) {
            if (!VIDEO_FILE_RE.test(f)) continue;
            try {
              const row = identifyByPath(db, path.join(full, f));
              if (row && row.library_key === libraryKey) {
                byTwin.add(full);
                break;
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
    if (byTwin.size) return Array.from(byTwin);
  }
  if (!want) return [MEDIA_MOVIES];
  return [MEDIA_MOVIES];
}

/** Per-franchise TMDB language preference from tmdb_franchise_prefs, or null when unset.
 *  An empty string means "no language preference" — the row is kept alive by a
 *  set episode ORDER, which needs a row of its own to live on. */
function franchiseLanguage(db: Database, libraryKey: string): string | null {
  const row = db.prepare("SELECT language FROM tmdb_franchise_prefs WHERE library_key = ?").get(libraryKey) as any;
  return row?.language || null;
}

/** Infer a season number from a folder name (S01 / Season 1 / Sezon 1 / Sezon I). */
function parseSeasonFromFolderName(name: string): number | null {
  const m = name.match(/\bS(\d{1,2})(?:\b|$)/i) || name.match(/\bSeason[ ]?\d{1,4}[- ]?(\d{1,2})\b/i) || name.match(/\bSeason[ ]?(\d{1,2})\b/i) || name.match(/\bSezon[ ]?(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  const roman = name.match(/\bSezon[ ]?([IVXLCDM]{1,6})\b/i);
  if (roman) return ROMAN[roman[1].toUpperCase()] ?? null;
  return null;
}

/** Prefer an existing season folder in the show dir (handles localized names
 * like "Sezon I") over creating a fresh "S01". */
function findExistingSeasonFolder(showFolder: string, season: number): string | null {
  try {
    for (const d of fs.readdirSync(showFolder, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (parseSeasonFromFolderName(d.name) === season) return path.join(showFolder, d.name);
    }
  } catch {}
  return null;
}

function normalizeFolder(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((\d{4})\)/g, "")
    .replace(/\[(\d{4})\]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Processed show folders that fuzzy-match a title, in resolution order
 * (exact-year folder → lone year-less folder → first candidate, mirroring
 * findSeasonFolder's pick). Empty when nothing matches. */
function matchShowFolders(baseTitle: string, year?: number | null): string[] {
  const want = normalizeFolder(baseTitle);
  if (!want) return [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROCESSED_TV);
  } catch {
    return [];
  }
  // Collect every folder that fuzzy-matches the title so same-named shows with
  // different years can be told apart (e.g. DuckTales (1987) vs (2017), where
  // one folder may even omit its year entirely).
  const candidates: { dir: string; year: number | null }[] = [];
  for (const d of dirs) {
    const norm = normalizeFolder(d);
    if (!norm) continue;
    const match = norm === want || (want.length >= 6 && norm.includes(want)) || (norm.length >= 6 && want.includes(norm));
    if (!match) continue;
    candidates.push({ dir: d, year: folderYear(d) });
  }
  if (candidates.length === 0) return [];
  if (year != null) {
    const yearHit = candidates.find((c) => c.year === year);
    if (yearHit) return [yearHit.dir];
    // No folder carries the requested year: a lone year-less folder is the
    // strongest signal that THIS show is stored without its year.
    const yearless = candidates.filter((c) => c.year == null);
    if (yearless.length === 1 && candidates.length > yearless.length) return [yearless[0].dir];
  }
  // Year matched (or resolved) folders are authoritative — never fall through
  // to a different-year folder just because the Sxx subfolder is missing.
  // Without a year to resolve against, keep the first-candidate-with-folder pick.
  return candidates.map((c) => c.dir);
}

/** Locate a show's season folder under PROCESSED_TV, tolerating name variations
 * (localized titles, " (2007)" year suffixes, " - alt title" joiners). */
function findSeasonFolder(baseTitle: string, season: number, year?: number | null): string | null {
  const Sxx = `S${String(season).padStart(2, "0")}`;
  const exact = path.join(PROCESSED_TV, baseTitle, Sxx);
  if (fs.existsSync(exact)) return exact;
  for (const d of matchShowFolders(baseTitle, year)) {
    const cand = path.join(PROCESSED_TV, d, Sxx);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** Season folders physically present under a show's processed folder, mapped to
 * the video file names inside them. Empty when the show has no processed
 * folder. Lets seasons appear even without a request row (structure-first).
 * `extraShowDir` is a PROCESSED_TV-relative show folder to include when the
 * title-based match can't see it (localized vs English library folder names). */
function diskSeasonFolders(baseTitle: string, year?: number | null, extraShowDir?: string | null): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const scan = (showDir: string) => {
    const full = path.join(PROCESSED_TV, showDir);
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const sn = parseSeasonNumber(e.name);
      if (sn == null) continue;
      let files: string[];
      try {
        files = fs.readdirSync(path.join(full, e.name));
      } catch {
        continue;
      }
      const videos = files.filter((f) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
      if (videos.length === 0) continue;
      out.set(sn, videos);
    }
  };
  for (const showDir of matchShowFolders(baseTitle, year)) scan(showDir);
  if (extraShowDir) scan(extraShowDir);
  return out;
}

/** Show directory (PROCESSED_TV-relative) that holds a set of request ids'
 * processed files, derived from their stored relative paths. Bridges titles
 * that don't fuzzy-match the disk folder (library folder "Krecik Krtek" vs
 * processed folder "The Adventures of the Mole"). */
function processedShowDirFromFiles(db: Database, requestIds: number[]): string | null {
  if (!requestIds.length) return null;
  let rows: any[];
  try {
    rows = db
      .prepare(
        "SELECT processed_files FROM approval_history" +
          ` WHERE request_id IN (${requestIds.map(() => "?").join(",")})` +
          " AND processed_files IS NOT NULL AND processed_files != '[]'",
      )
      .all(...requestIds) as any[];
  } catch {
    return null;
  }
  for (const r of rows) {
    for (const p of JSON.parse(r.processed_files || "[]") as string[]) {
      const parts = String(p).split(/[/\\]+/);
      if (parts.length < 2) continue;
      if (fs.existsSync(path.join(PROCESSED_TV, parts[0]))) return parts[0];
    }
  }
  return null;
}

/** The processed movie SUBFOLDER holding these requests' accepted files, when
 *  they are foldered. Movies are mostly flat in PROCESSED_MOVIES, so this is
 *  frequently null - that is fine, it only serves as a fallback title source
 *  when TMDB cannot search the stored (often localized) row title. */
function processedMovieDirFromFiles(db: Database, requestIds: number[]): string | null {
  if (!requestIds.length) return null;
  let rows: any[];
  try {
    rows = db
      .prepare(
        "SELECT processed_files FROM approval_history" +
          ` WHERE request_id IN (${requestIds.map(() => "?").join(",")})` +
          " AND processed_files IS NOT NULL AND processed_files != '[]'",
      )
      .all(...requestIds) as any[];
  } catch {
    return null;
  }
  for (const r of rows) {
    let arr: string[] = [];
    try {
      arr = JSON.parse(r.processed_files || "[]") as string[];
    } catch {
      continue;
    }
    for (const p of arr) {
      const rel = String(p).split(/[/\\]+/).filter(Boolean);
      // One segment means the file sits flat in PROCESSED_MOVIES, which names
      // nothing - every movie in that root shares it.
      if (rel.length < 2) continue;
      const full = path.join(PROCESSED_MOVIES, rel.join(path.sep));
      if (fs.existsSync(full)) return path.dirname(full);
    }
  }
  return null;
}

/** Last-resort show dir: a PROCESSED_TV folder that contains a season directory
 * matching one of the franchise's own season numbers. Bridges titles that are
 * nothing alike on disk (e.g. key slug "ninjago-dragon-rising" vs folder
 * "LEGO Ninjago: Dragons Rising") when no processed file paths exist. */
function showDirByStructure(requestSeasons: number[], baseTitle?: string | null): string | null {
  const want = new Set(requestSeasons.filter((s) => s > 0));
  if (want.size === 0) return null;
  const hits: string[] = [];
  try {
    for (const d of fs.readdirSync(PROCESSED_TV)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(PROCESSED_TV, d));
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      try {
        for (const sub of fs.readdirSync(path.join(PROCESSED_TV, d), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const sn = parseSeasonNumber(sub.name);
          if (sn != null && want.has(sn)) {
            hits.push(d);
            break;
          }
        }
      } catch {}
    }
  } catch {}
  if (hits.length === 0) return null;
  // A season NUMBER identifies no franchise — nearly every show has an S01 — so
  // returning the first structural hit hands a request somebody else's folder.
  // That is how a show owning no processed files at all grows phantom season pills
  // copied from an unrelated series. Narrow by name first...
  const wantNorm = normalizeFolder(baseTitle ?? "");
  if (wantNorm) {
    const titled = hits.filter((d) => {
      const norm = normalizeFolder(d);
      return norm === wantNorm || (wantNorm.length >= 6 && includesTitleNorm(wantNorm, norm)) || (norm.length >= 6 && includesTitleNorm(norm, wantNorm));
    });
    if (titled.length) return titled[0];
  }
  // ...and when names cannot decide, structure has to be UNIQUE to count at all.
  // It usually is not, and "no disk seasons" is the honest answer — the real
  // folder is found by processedShowDirFromFiles whenever the request owns files.
  return hits.length === 1 ? hits[0] : null;
}

/** The season folder backing a native library_key + season: title-matched
 * first, then derived from the franchise's own processed file paths (handles
 * libraries whose folder name has nothing in common with the processed one). */
function seasonFolderForLibraryKey(db: Database, library_key: string | null | undefined, baseTitle: string, season: number): string | null {
  const byTitle = findSeasonFolder(baseTitle, season, libraryKeyYear(library_key));
  if (byTitle) return byTitle;
  if (!library_key) return null;
  let rows: any[];
  try {
    rows = db.prepare("SELECT id FROM media_requests WHERE type = 'series' AND library_key = ?").all(library_key) as any[];
  } catch {
    return null;
  }
  const showDir = processedShowDirFromFiles(db, rows.map((r: any) => r.id));
  if (!showDir) return null;
  const cand = path.join(PROCESSED_TV, showDir, `S${String(season).padStart(2, "0")}`);
  return fs.existsSync(cand) ? cand : null;
}

/** True when a show's processed folder contains the given season FOLDER,
 * files or not. Iterates title-matched + path-derived show dirs. Used to show
 * a Specials pill for shows whose empty S00 structure was created alongside
 * the season folders (Death in Paradise, The Smurfs, Ninjago). */
function seasonFolderOnDisk(baseTitle: string, season: number, year?: number | null, extraShowDir?: string | null): boolean {
  const Sxx = `S${String(season).padStart(2, "0")}`;
  for (const showDir of matchShowFolders(baseTitle, year)) {
    try {
      if (fs.existsSync(path.join(PROCESSED_TV, showDir, Sxx))) return true;
    } catch {}
  }
  if (extraShowDir) {
    try {
      if (fs.existsSync(path.join(PROCESSED_TV, extraShowDir, Sxx))) return true;
    } catch {}
  }
  return false;
}

/** Denominator for a native Specials (S00) season. Imported S00 rows carry an
 * `episode_count` that is a file-count snapshot — episodes stored loose in the
 * library root get miscast as "specials" and inflate the number (e.g. 55
 * placeholder specials for a show whose real specials number 13). The honest
 * count is TMDB's named special episodes plus whatever is physically in the
 * S00 folder. */
function nativeSpecialDenominator(db: Database, library_key: string | null | undefined, baseTitle: string, covered: Set<number>, extras: number): number {
  let tmdb = 0;
  if (library_key) {
    try {
      const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = 0").get(library_key) as any;
      if (tc) tmdb = namedSpecialCount(tc.payload);
    } catch {}
  }
  // The release numbering on disk can exceed TMDB's S00 list (a "Show S0XE03"
  // file asserts a third special even when TMDB only names two). Floor the
  // denominator with the highest special slot attested by files so the pill
  // says "2/3" for a collection that holds specials 1 and 3.
  return Math.max(tmdb, covered.size + extras, maxSpecialNumberInS00(db, library_key, baseTitle));
}

/** Denominator for a native REGULAR season. Same defect as
 *  nativeSpecialDenominator: a native row's `episode_count` is a file-count
 *  snapshot taken at library import, not an episode total. Death in Paradise S11
 *  imported as 9 files because its release numbered the Christmas special
 *  "S11E00"; moving that file into S00 left a genuine 8, but the denominator
 *  stayed 9 and the pill read "1 missing 8/9" against TMDB's 8. TMDB is the
 *  authority for how many episodes a season HAS — the folder only floors it, since
 *  release numbering legitimately exceeds TMDB (a split or a double episode), and
 *  the snapshot is the last resort when TMDB has never been reached. */
function nativeSeasonDenominator(
  db: Database,
  library_key: string | null | undefined,
  season: number,
  covered: Set<number>,
  extras: number,
  snapshot: number | null | undefined,
): number {
  let tmdb = 0;
  if (library_key) {
    try {
      const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ?").get(library_key, season) as any;
      if (tc) tmdb = ((JSON.parse(tc.payload)?.episodes || []) as any[]).length || 0;
    } catch {}
  }
  if (!tmdb) return snapshot || covered.size + extras;
  return Math.max(tmdb, covered.size + extras);
}

/** Highest special position attested by video files in the processed S00
 * folder. Null returns from extractEpisodeFromFilename ("S0X" releases) are
 * re-parsed here for their trailing E## — the file still renders as an
 * unnumbered SPECIAL row in the grid, but the number it asserts keeps the
 * Specials pill denominator honest. Returns 0 when nothing is numbered. */
function maxSpecialNumberInS00(db: Database, library_key: string | null | undefined, baseTitle: string): number {
  let maxNum = 0;
  const folder = seasonFolderForLibraryKey(db, library_key, baseTitle, 0);
  if (!folder) return 0;
  let files: string[];
  try {
    files = fs.readdirSync(folder);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
    let n: number | null = extractEpisodeFromFilename(f);
    if (n == null && /[Ss]0[Xx]/.test(f)) {
      const m = f.match(/[Ss]0[Xx][\s._-]*E?(\d{1,3})/i);
      if (m) n = parseInt(m[1], 10);
    }
    if (n != null && n > maxNum) maxNum = n;
  }
  return maxNum;
}

/** Named special episodes in a cached TMDB season-0 payload. TMDB pads many
 * series' Specials with unnamed "Episode N" mirrors of the real episodes —
 * those are structure noise, not content, and shouldn't inflate special pills. */
function namedSpecialCount(payload: string): number {
  try {
    const episodes: any[] = JSON.parse(payload)?.episodes || [];
    return episodes.filter((ep) => {
      const n = (ep?.name || "").trim();
      return n !== "" && !/^episode\s*\d+$/i.test(n);
    }).length;
  } catch {
    return 0;
  }
}

/** A show's SEASON LIST (how many seasons it has at all), memoised in-process.
 *
 *  Distinct from tmdb_season_cache, which holds one season's episodes and is
 *  only ever populated for seasons we already know about — so it can never
 *  answer "which seasons does this show have". This is the one call that can,
 *  and the dashboard hits it once per native franchise per load, hence the TTL
 *  memo: a page refresh must not spend a TMDB request per card. */
const seasonListMemo = new Map<string, { at: number; list: Array<{ season_number: number; episode_count: number }> }>();
const SEASON_LIST_TTL_MS = 6 * 60 * 60 * 1000;

async function seasonListForShow(
  showId: number,
  language?: string | null,
): Promise<Array<{ season_number: number; episode_count: number }>> {
  const key = `${showId}:${language || ""}`;
  const hit = seasonListMemo.get(key);
  if (hit && Date.now() - hit.at < SEASON_LIST_TTL_MS) return hit.list;
  const list = (await fetchTMDBTVSeasons(showId, language || undefined)) || [];
  seasonListMemo.set(key, { at: Date.now(), list });
  return list;
}

/** Strip parser/release junk from a series title used as the franchise display
 * name and TMDB lookup base (e.g. "Tajemnica Sagali (2016) S01E01 PL 768p
 * WEB-DL H.264-AL3X" → "Tajemnica Sagali (2016)"). A bare trailing year in
 * parens/brackets is preserved; resume-tail patterns are dropped repeatedly. */
export function cleanFranchiseTitle(title: string): string {
  let t = title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "").trim();
  // Cut everything after an episode marker ("S##E## <release tags>").
  t = t.replace(/\sS\d{1,2}[\s._-]*E\d{1,3}\b.*$/i, "").trim();
  let prev: string;
  do {
    prev = t;
    t = t
      .replace(/\s+[\w.]*\d{3,4}p\s*$/i, "")
      .replace(/\s+(?:WEB-?DL|WEB-?RIP|Blu-?Ray|BD-?RIP|BDRip|DVDRip|HDTV|H\.?26[45]|x26[45]|HEVC|10bit|AAC(?:2\.0)?|E-?AC3|DTS(?:-HD)?|TRUEHD|MKV|MULTi|PL|PL-?PL)\s*$/i, "")
      .replace(/\s+\S*\d\S+-\S{2,8}\s*$/i, "")
      .trim();
  } while (t !== prev && t.length > 0);
  return t;
}

/** Strip accents so a diacritic language still slugifies to real words.
 *  NFD does not decompose "ł" (U+0142 has no canonical mapping), so it is
 *  mapped explicitly — without that, every non-ASCII letter fell through to a
 *  separator and "Niezwykła podróż" became "niezwyk-a-podr". */
function foldDiacritics(s: string): string {
  return s.replace(/\u0142/g, "l").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Slug for a library_key identity: lowercase alnum dashed, bracketed year
 * dropped (the year is carried by the key's own segment). */
export function slugForKeyTitle(title: string): string {
  return foldDiacritics(title || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[\[(]\d{4}[\])]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Year embedded in the library_key (`series:<id|slug>:<year>`), if any. */
function libraryKeyYear(key?: string | null): number | null {
  if (!key) return null;
  const y = parseInt(key.split(":")[2] ?? "", 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * Card label for a franchise. A reboot reuses the original title verbatim — TMDB
 * indexes both DuckTales series as "DuckTales" — so two cards render identically
 * unless something states the year. The library_key is what actually separates
 * them (`series:75931:1987` vs `series:330134:2017`), so the card borrows its
 * year from there. DISPLAY ONLY: folder resolution keeps using the raw title, and
 * the stored title stays year-less because the canonical folder name renders the
 * year itself.
 */
function franchiseDisplayTitle(title: string, libraryKey?: string | null): string {
  const t = (title || "").trim();
  if (!t || /\(\d{4}\)/.test(t)) return t;
  const y = libraryKeyYear(libraryKey);
  return y ? `${t} (${y})` : t;
}

/** Year parsed from a disk folder name (`Foo (2017)`, `Foo 2017`, ...). */
function folderYear(name: string): number | null {
  const bracketed = name.match(/[\[(]((?:19|20)\d{2})[\])]/);
  if (bracketed) return parseInt(bracketed[1], 10);
  const bare = name.match(/(?:^|[.\s[(])((?:19|20)\d{2})(?=[.\s\]),]|$)/);
  return bare ? parseInt(bare[1], 10) : null;
}

/** Every year token in a folder name. A range like "DuckTales 1987-1990" yields
 *  both ends, so a franchise keyed by its first year still matches the folder
 *  that stores it as a span (library folders commonly do this). */
function folderYears(name: string): number[] {
  const out: number[] = [];
  for (const m of name.matchAll(/(?:19|20)\d{2}/g)) {
    const y = parseInt(m[0], 10);
    if (!out.includes(y)) out.push(y);
  }
  return out;
}

interface NamingPieces {
  title: string;
  year: number | null;
  imdbId: string | null;
  tvdbId: string | null;
}

/**
 * P1: identity + ids for canonical naming. Primary source is TMDB external_ids
 * (cached in `tmdb_external_ids`); offline fallback parses an already-canonical
 * target folder ("Title (Year) [imdbid-ttX]") so the app still names canonically
 * when TMDB is unset. Returns null when naming is disabled or nothing resolves.
 */
async function namingPiecesForRequest(db: Database, request: any, idHintFolder?: string, diag?: NamingDiag): Promise<NamingPieces | null> {
  const conf = loadNamingConf(db);
  if (!conf.enabled) return null;
  let pieces: NamingPieces | null = null;
  const isSeries = request.type === "series";
  const kind = isSeries ? "series" : "movie";
  let parsed: { title: string; year: number | null; imdbId: string | null; tvdbId: string | null } | null = null;
  if (idHintFolder) {
    try {
      parsed = parseDirName(path.basename(idHintFolder) || "");
    } catch {}
  }
  try {
    const lang = franchiseLanguage(db, request.library_key) || process.env.TMDB_LANGUAGE || "en-US";
    const ids = await resolveExternalIds(
      db,
      request.library_key,
      kind,
      cleanFranchiseTitle(request.title || ""),
      lang,
      { diag },
    );
    if (ids) pieces = { title: ids.title, year: ids.year ?? libraryKeyYear(request.library_key), imdbId: ids.imdbId, tvdbId: ids.tvdbId };
  } catch {
    if (diag) diag.reason = "TMDB request failed";
  }
  // Mangled stored titles ("Ninjago: Dragon Rising") fail TMDB search while the
  // on-disk show/movie folder holds the real name ("LEGO Ninjago: Dragons
  // Rising") — retry with that before falling back to id parsing. `ignoreCache`
  // bypasses a negative cache row written by the first (failed) attempt.
  if (!pieces && parsed && parsed.title && parsed.title !== cleanFranchiseTitle(request.title || "")) {
    try {
      const lang = franchiseLanguage(db, request.library_key) || process.env.TMDB_LANGUAGE || "en-US";
      const ids = await resolveExternalIds(db, request.library_key, kind, parsed.title, lang, { ignoreCache: true, diag });
      if (ids) pieces = { title: ids.title, year: ids.year ?? parsed.year ?? libraryKeyYear(request.library_key), imdbId: ids.imdbId, tvdbId: ids.tvdbId };
    } catch {
      if (diag) diag.reason = "TMDB request failed";
    }
  }
  if (!pieces && parsed) {
    const year = parsed.year ?? libraryKeyYear(request.library_key);
    const fallbackTitle = cleanFranchiseTitle(request.title || "");
    if (!isSeries && parsed.imdbId) {
      pieces = { title: parsed.title || fallbackTitle, year, imdbId: parsed.imdbId, tvdbId: null };
    } else if (isSeries && (parsed.tvdbId || parsed.imdbId)) {
      pieces = { title: parsed.title || fallbackTitle, year, imdbId: parsed.imdbId, tvdbId: parsed.tvdbId };
    }
  }
  return pieces;
}

/**
 * namingPiecesForRequest with a disk-tied fallback: when TMDB is unset or a
 * title simply cannot be resolved, parse ids from an already-canonical folder
 * ("Title (Year) [tvdbid-####]"/"[imdbid-tt####]") so existing trees still name
 * canonically. Candidates come from the processed dirs matched for the request
 * plus the library tree, where the user has usually already applied the naming.
 */
async function namingPiecesWithDiskFallback(db: Database, request: any, hintFolders: string[]): Promise<{ pieces: NamingPieces | null; reason: string | null }> {
  const diag: NamingDiag = {};
  const pieces = await namingPiecesForRequest(db, request, undefined, diag);
  if (pieces) return { pieces, reason: null };
  for (const folder of hintFolders) {
    if (!folder) continue;
    const p = await namingPiecesForRequest(db, request, folder, diag);
    if (p) return { pieces: p, reason: null };
  }
  return { pieces: null, reason: diag.reason || "no IMDb/TVDB id found" };
}

/** Ensure this request's season row exists in tmdb_season_cache for its
 *  franchise language, using the on-disk show folder as the altTitle. Every read
 *  of episode metadata (title, air date) goes through here first, so those reads
 *  can never see a cold cache. Best effort: a TMDB failure just leaves the cache
 *  cold and the callers fall back to on-disk names. */
async function warmSeasonCache(db: Database, request: any, hintFolders: string[] = []): Promise<void> {
  if (request.type !== "series" || !request.library_key || request.season === 0) return;
  try {
    const lang = franchiseLanguage(db, request.library_key);
    const altTitle = hintFolders.map((d) => path.basename(d || "")).find((n) => n && n.length > 2) || null;
    await fetchTMDBSeason(db, request.library_key, request.season ?? 1, cleanFranchiseTitle(request.title || ""), {
      language: lang,
      altTitle,
    });
  } catch {}
}

/** Warm this request's season cache, then resolve identity pieces. Shared by the
 * preview and the apply path so a proposal can never be un-appliable: both must
 * agree on the pieces or the modal would show a rename the apply then refuses. */
async function fixNamesPieces(
  db: Database,
  request: any,
  hintFolders: string[],
): Promise<{ pieces: NamingPieces | null; reason: string | null }> {
  await warmSeasonCache(db, request, hintFolders);
  return namingPiecesWithDiskFallback(db, request, hintFolders);
}

/** Canonical file basename (no extension) for a NEW processed/library file, or
 * null to keep today's raw release name. Null on disabled naming, missing
 * pivots (episode code / title / id), or unresolved identity — never guesses.
 * `probe` (ffprobe facts about the source file, when probing is available)
 * upgrades playback-info tags beyond what title-scraping infers. */
async function canonicalFileBase(db: Database, request: any, sourceBase: string, idHintFolder?: string, probe?: ProbeInfo | null): Promise<string | null> {
  const conf = loadNamingConf(db);
  if (!conf.enabled) return null;
  // The episode title/air date below come from the season cache, so warm it first
  // instead of inheriting whatever the last reader happened to leave behind.
  await warmSeasonCache(db, request, idHintFolder ? [idHintFolder] : []);
  const pieces = await namingPiecesForRequest(db, request, idHintFolder);
  const tags = assembleCanonicalTags(parseReleaseTags(sourceBase, vendorList(conf)), probe || null);
  // A release that split in two says so in its OWN name ("… part 2"), and this
  // is the only place that ever sees the two halves apart — Fix Names meets them
  // later, already named. Carrying the marker through is what stops the halves
  // landing as one name plus a `-2` collision suffix, and it is the same rule
  // `proposeCanonicalName` applies when it re-reads them afterwards.
  const ext = path.extname(sourceBase);
  const stem = ext && sourceBase.endsWith(ext) ? sourceBase.slice(0, -ext.length) : sourceBase;
  const ownPart = partMarkerFromSourceName(stem);
  // Not appended when the title already ends in one: the canonical form puts the
  // year after it, so the marker stops matching on the next pass and the file
  // would flip between two spellings forever.
  const withPart = (title: string) =>
    ownPart && title && stripPartMarker(title) === title ? `${title} - ${ownPart}` : title;
  if (request.type === "movie") {
    if (!pieces) return null;
    return canonicalMovieFile(conf, { title: withPart(pieces.title), year: pieces.year, imdbId: pieces.imdbId, tags: tags.tags, group: tags.group, vendor: tags.vendor });
  }
  const parsed = parseEpisodeCode(sourceBase, { knownSeason: request.season ?? null });
  if (!parsed) return null;
  const ep = resolveEpisodeSpan(db, request, sourceBase, parsed);
  if (ep.season === 0) {
    const sp = await specialPiecesForFile(db, request, sourceBase, pieces, ep.episode);
    if (!sp) return null;
    return canonicalSpecialFile(conf, { title: withPart(sp.title), year: sp.year, imdbId: sp.imdbId, season: 0, episode: ep.episode, tags: tags.tags, group: tags.group, vendor: tags.vendor });
  }
  let episodeTitle = episodeTitleFor(db, request, sourceBase, ep);
  if (ownPart) {
    const stripped = stripPartMarker(episodeTitle ?? "");
    episodeTitle = stripped ? `${stripped} - ${ownPart}` : ownPart;
  }
  // Per-episode air date, so a template can date a season that aired years after
  // the show's first season. Optional: default templates never reference it.
  const airDate = request.library_key ? episodeAirDateFromCache(db, request.library_key, ep.season, ep.episode, franchiseLanguage(db, request.library_key)) : null;
  return canonicalEpisodeFile(conf, {
    title: (pieces?.title || cleanFranchiseTitle(request.title || "")).replace(/ \(\d{4}\)$/, ""),
    season: ep.season,
    episode: ep.episode,
    episodeEnd: ep.episodeEnd ?? null,
    episodeTitle,
    airDate,
    episodeYear: airDate ? airDate.slice(0, 4) : null,
    tags: tags.tags,
    group: tags.group,
    vendor: tags.vendor,
  });
}

// ---- P2: "Fix Names" — standardize existing trees (inode-verified renames) ----

const VIDEO_FILE_RE = /\.(mkv|mp4|avi|mov|ts|wmv)$/i;

interface FixNameRow {
  id: string;
  ino: number | null;
  path: string;
  tree: "processed" | "library";
  currentName: string;
  proposedName: string | null;
  role: "movie" | "special" | "episode" | null;
  note: string | null;
}

interface FixNameGroup {
  id: string;
  ino: number | null;
  processed: FixNameRow | null;
  library: FixNameRow | null;
}

interface FixNameDirRow {
  id: string;
  path: string;
  tree: "processed" | "library";
  kind: "show" | "season" | "movie";
  currentName: string;
  proposedName: string | null;
  note: string | null;
}

function fixNameRoots(): string[] {
  return [PROCESSED_MOVIES, PROCESSED_TV, MEDIA_MOVIES, MEDIA_TV];
}

/** True when p is a video file directly under one of the four modifiable trees. */
function isFixNameTarget(p: string): string | null {
  for (const root of fixNameRoots()) {
    const rel = path.relative(root, p);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!VIDEO_FILE_RE.test(path.basename(rel))) continue;
    return root;
  }
  return null;
}

/** An explicit IMDb id written into a file/folder name ("[imdbid-tt0110357]",
 *  or a bare "tt0110357"). Our own canonical writer always embeds the request's
 *  real id, so when one is present it is a DETERMINISTIC statement about which
 *  film this is — never a fuzzy hint. */
function nameImdbId(name: string): string | null {
  const m = name.match(/imdbid[-\s]*(tt\d{6,9})/i) || name.match(/\b(tt\d{6,9})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** The IMDb id for this request, read from cache only (no network). Falls back
 *  to an id already embedded in the stored title, which happens when the row
 *  was imported from an already-canonical name. Null when TMDB has not resolved
 *  it yet, in which case an embedded id in a file name has nothing to disagree
 *  with and the veto stays inert (it can only exclude, never admit). */
function requestImdbId(db: Database, request: any): string | null {
  if (request?.library_key) {
    try {
      const row = db.prepare("SELECT imdb_id FROM tmdb_external_ids WHERE library_key = ?").get(request.library_key) as any;
      if (row?.imdb_id) return String(row.imdb_id).toLowerCase();
    } catch {}
  }
  // A canonical native key is itself id-anchored ("movie:tt0110357:1994"), so
  // this works offline and before TMDB has ever been asked.
  const fromKey = String(request?.library_key || "").match(/\b(tt\d{6,9})\b/i);
  if (fromKey) return fromKey[1].toLowerCase();
  const fromTitle = nameImdbId(request?.title || "");
  if (fromTitle) return fromTitle;
  // Last resort, and deliberately offline: a canonical FILE NAME states identity
  // outright, so the request's own accepted files can name the film when the
  // cache is cold and neither the key nor a localized title carries an id. This
  // is what heals a request whose id became unattributable - losing it is not
  // cosmetic, because the folder veto and the canonical name both key off it.
  // Conflicting ids across the files mean attribution was wrong, so stay inert
  // rather than pick one.
  return requestImdbIdFromProcessedNames(db, request);
}

/** The single IMDb id embedded in this request's accepted processed file names,
 * or null when there is none, none is registered, or they disagree. */
function requestImdbIdFromProcessedNames(db: Database, request: any): string | null {
  if (!request?.id) return null;
  let rows: any[];
  try {
    rows = db
      .prepare("SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'")
      .all(request.id) as any[];
  } catch {
    return null;
  }
  const seen = new Set<string>();
  for (const r of rows) {
    let arr: string[] = [];
    try {
      arr = JSON.parse(r.processed_files || "[]") as string[];
    } catch {
      continue;
    }
    for (const p of arr) {
      const id = nameImdbId(String(p).split(/[/\\]+/).pop() || "");
      if (id) seen.add(id);
    }
  }
  if (seen.size !== 1) return null;
  return [...seen][0];
}

/** The library_key that OWNS an IMDb id, resolved offline. The cache is the fast
 *  path; when it is cold (or TMDB is unset) an id-anchored library_key still
 *  answers, because the app writes keys like "movie:tt0110357:1994" itself.
 *  Null when the id is unattributable - the caller must then stay inert. */
function imdbIdOwnerKey(db: Database, imdbId: string): string | null {
  const id = imdbId.toLowerCase();
  try {
    const row = db.prepare("SELECT library_key FROM tmdb_external_ids WHERE imdb_id = ? LIMIT 1").get(id) as any;
    if (row?.library_key) return row.library_key;
  } catch {}
  try {
    const row = db.prepare("SELECT library_key FROM media_requests WHERE library_key LIKE ? LIMIT 1").get(`%${id}%`) as any;
    if (row?.library_key) return row.library_key;
  } catch {}
  return null;
}

/** The four-digit year a request is authoritative about: the parenthesised
 *  "(YYYY)" in the stored title, else the ":YYYY" tail of its library_key. That
 *  tail comes from TMDB, so it is a fact about the film rather than a guess
 *  scraped out of a release name. */
/** Significant words in a title, for deciding whether a TMDB hit plausibly IS
 *  the same film. Diacritics are folded so "Niezwykla" matches "Niezwyklą". */
function titleWords(t: string): string[] {
  return foldDiacritics(String(t || "").toLowerCase())
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** A TMDB hit is a plausible match for a stored title only when it carries
 *  EVERY significant word of that title. Partial overlap must not read as
 *  confirmation: "Hobbit" legitimately matches "The Hobbit: An Unexpected
 *  Journey", "…Desolation of Smaug" and "…Battle of the Five Armies" equally,
 *  and that is the whole ambiguity. */
function plausibleMovieCandidate(candidateTitle: string, storedTitle: string): boolean {
  const wanted = titleWords(storedTitle);
  if (!wanted.length) return false;
  const have = new Set(titleWords(candidateTitle));
  return wanted.every((w) => have.has(w));
}

/** Whether a resolved movie identity may be applied unattended.
 *
 *  Two ways a search result is not a resolution but a guess, and both silently
 *  bind the card to the wrong film — which then outranks every other signal on
 *  read, so undoing it is far harder than leaving the key alone:
 *   1. it contradicts a year the request already states, or
 *   2. the request states no year and several films match the title, leaving
 *      only TMDB's ranking to choose (and the ranking is arbitrary).
 *  A stated year is a real disambiguator, so (2) only applies without one. */
export function decideMovieIdentity(opts: {
  resolvedYear: number | null;
  /** A year the request states about itself — "(1994)", the key's ":2012", or
   *  the on-disk folder name. Null when it states none. */
  ownYear: string | null;
  /** Titles of TMDB hits that plausibly match the stored title. */
  plausibleTitles: string[];
}): { apply: true } | { apply: false; reason: string } {
  const { resolvedYear, ownYear, plausibleTitles } = opts;
  if (ownYear && resolvedYear && String(resolvedYear) !== String(ownYear)) {
    return { apply: false, reason: `best TMDB match is ${resolvedYear}, but this request states ${ownYear}` };
  }
  if (!ownYear && plausibleTitles.length > 1) {
    return { apply: false, reason: `${plausibleTitles.length} films match this title — pick the right one` };
  }
  return { apply: true };
}

function requestYear(request: any): string | null {
  const inTitle = String(request?.title || "").match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, -1);
  if (inTitle) return inTitle;
  const inKey = String(request?.library_key || "").match(/:(\d{4})$/)?.[1];
  return inKey ?? null;
}

/** The year a file/folder name states. A parenthesised "(YYYY)" wins; otherwise
 *  take the first bare 4-digit year outside any bracket (so "[DV 2019 HDR]" or a
 *  year embedded in a bracket tag cannot masquerade as the film's year). */
function nameYear(name: string): string | null {
  const base = path.basename(name, path.extname(name));
  const parenthesised = base.match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, -1);
  if (parenthesised) return parenthesised;
  const stripped = base.replace(/\[[^\]]*\]/g, " ");
  return stripped.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
}

const TITLE_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "is", "it", "its", "vs", "part",
]);

/** How many significant words two titles share, ignoring release/quality junk
 *  that trails a canonical name. Used only to confirm that a year conflict is
 *  about the SAME franchise rather than an unrelated film that merely has a
 *  year in its name. */
function sharedTitleWords(a: string, b: string): number {
  const strip = (s: string) =>
    s
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(imdbid[-\s]*tt\d{6,9})\b/gi, " ")
      .replace(/\b(19|20)\d{2}\b/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !TITLE_STOP_WORDS.has(w));
  const setB = new Set(strip(b));
  const seen = new Set<string>();
  for (const w of strip(a)) if (setB.has(w)) seen.add(w);
  return seen.size;
}

/** True when another MOVIE request claims the year this file states, and that
 *  request is about the same film series. The franchise is the flat, one-word
 *  kind where word overlap cannot help: "Hobbit Bitwa Pieciu Armii 2014" shares
 *  exactly one word with "The Hobbit: An Unexpected Journey", because the Polish
 *  release translates the subtitle and drops every distinguishing English word.
 *  The YEAR is the signal that still separates them, and the sibling request is
 *  what turns a bare year into evidence rather than a coincidence.
 *
 *  Kept deliberately narrow: the sibling must be a movie (a series' seasons share
 *  the show's title and must not steal each other's files), must state the same
 *  year the file does, must be a different request, and must share at least one
 *  significant word with the file. One word is enough here precisely BECAUSE the
 *  year already agrees — the pair of signals is what carries the decision. */
function siblingRequestClaimsYear(db: Database, request: any, base: string): boolean {
  const theirYear = nameYear(base);
  if (request?.type !== "movie" || !theirYear || !request?.library_key) return false;
  const rows = db
    .prepare("SELECT id, title, library_key, type FROM media_requests WHERE type = 'movie' AND library_key IS NOT NULL")
    .all() as any[];
  for (const r of rows) {
    if (r.id === request.id) continue;
    if (requestYear(r) !== theirYear) continue;
    if (sharedTitleWords(String(r.title || ""), base) >= 1) return true;
  }
  return false;
}

/** The year a movie's LIBRARY folder states, which is the last resort for a file
 *  whose own name carries none.
 *
 *  "Hobbit Niezwykla podroz Dubbing PL - Video w Resetoff.pl.mp4" says nothing
 *  about which film it is: no IMDb id, no year, and a Polish title that shares
 *  exactly one word with both Hobbit films. Its library twin does say so —
 *  `Hobbit (2012)/` — and that folder is where a human (or an arr) already put
 *  the film. The name-based veto has nothing to work with, so without this the
 *  file is admitted to every same-franchise card at once.
 *
 *  Returns null when the twin is unknown or its folder states no year, so this
 *  can only ever exclude, never admit. */
function libraryFolderYearOfDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const dirName = path.basename(path.normalize(dir));
  if (!dirName || dirName === "." || dirName === path.sep) return null;
  // A bare media root ("filmy", "Filmy") names nothing and must not be read.
  if (!/[(\s-]/.test(dirName)) return null;
  return nameYear(dirName);
}

/** The sibling movie request that owns `dir`'s stated year, or null.
 *
 *  A year alone is not enough to name an owner: there is always some unrelated
 *  film from the same year in the table, so matching on the year alone handed a
 *  Hobbit file to whichever 2012 movie happened to be inserted first. The folder
 *  must ALSO share a significant word with that sibling's title, which is what
 *  makes it a same-franchise rival rather than a coincidence. */
function siblingOwningYear(db: Database, request: any, dir: string | null | undefined): any | null {
  if (request?.type !== "movie" || !request?.library_key) return null;
  const theirYear = libraryFolderYearOfDir(dir);
  if (!theirYear || !dir) return null;
  const rows = db
    .prepare("SELECT id, title, library_key, type, season FROM media_requests WHERE type = 'movie' AND library_key IS NOT NULL")
    .all() as any[];
  return rows.find((r) => r.id !== request.id && requestYear(r) === theirYear && sharedTitleWords(String(r.title || ""), path.basename(dir)) >= 1) || null;
}

function libraryFolderYear(libraryPath: string | null | undefined): string | null {
  return libraryPath ? libraryFolderYearOfDir(path.dirname(libraryPath)) : null;
}

/** True when a file's own library twin is filed under a year this request does
 *  not claim. Movies only, and only when BOTH years are known: the folder has to
 *  state one and the request has to state a different one. A file with no year in
 *  its name and a twin in an unyeared folder stays admissible — this is the
 *  strongest signal available for those, not a licence to guess. */
function libraryFolderContradicts(db: Database, request: any, libraryPath: string | null | undefined): boolean {
  if (request?.type !== "movie" || !request?.library_key) return false;
  const myYear = requestYear(request);
  const theirYear = libraryFolderYear(libraryPath);
  if (!myYear || !theirYear || myYear === theirYear) return false;
  // Only veto when a sibling movie request actually owns that year AND is the
  // same franchise, so a folder named for a re-release ("Dune (2021)") or an
  // unrelated same-year film cannot strip a legitimate file from a card.
  return !!siblingOwningYear(db, request, libraryPath ? path.dirname(libraryPath) : null);
}

/** True when a name pins a DIFFERENT film than this request, and how we know:
 *  the request's own id, the id's real owner, or a conflicting year.
 *
 *  Symmetric on purpose. Comparing ids only when BOTH sides are known made the
 *  veto inert whenever the request itself had no resolved id (cold cache, TMDB
 *  down, slug-only library_key) - which is exactly why the file could vanish from
 *  one card while still sitting in the other's. Resolving the FILE's id to its
 *  owner and comparing keys needs only one side to be known.
 *
 *  Unknown on any signal returns false, so this can only ever exclude a file,
 *  never admit one. */
function nameContradictsRequest(db: Database, request: any, base: string): boolean {
  const mine = nameImdbId(base);
  // Scoped by role: an unnumbered special may legitimately carry another film's
  // id, so only a movie or a NUMBERED episode treats it as a contradiction.
  if (mine && embeddedIdContradicts(request?.type === "series", base)) {
    const theirs = requestImdbId(db, request);
    if (theirs) return mine !== theirs;
    const owner = imdbIdOwnerKey(db, mine);
    if (owner && request?.library_key) return owner !== request.library_key;
  }
  // No id in the name (older files predate canonical naming). A conflicting YEAR
  // is the next strongest signal: "The Lion King 1994 MULTI REMUX ..." has no
  // id, but shares two title words with "Mufasa: The Lion King (2024)" and
  // states a year that disagrees - a different film. Movies only: episode files
  // carry no film year, and re-releases keep the original year, so this cannot
  // misfire on series.
  if (request?.type !== "movie" || !request?.library_key) return false;
  const myYear = requestYear(request);
  const theirYear = nameYear(base);
  if (!myYear || !theirYear || myYear === theirYear) return false;
  // A sibling request already owns the year this file states: the flat, one-word
  // franchise case, where the file's own words cannot tell the films apart. Only
  // reachable once the years actually disagree, so the scan stays off the hot path.
  if (siblingRequestClaimsYear(db, request, base)) return true;
  return sharedTitleWords(String(request.title || ""), base) >= 2;
}

/** Re-attribute a file from the library folder that plainly says it belongs to a
 *  sibling's year. The id-based `reassignContradictedFile` above cannot help a
 *  release whose name states no year, so the stale media_files row would survive
 *  and every later read would trust it. Re-registering under the owning key fixes
 *  the attribution at its source rather than filtering it out at every read.
 *  Bookkeeping only — never touches the filesystem. */
function reassignFileByLibraryFolder(db: Database, request: any, fullPath: string, libraryPath: string | null | undefined): void {
  try {
    // The owner must be the same-franchise SIBLING that claims the folder's year,
    // never merely some movie released that year — otherwise a Hobbit dub gets
    // handed to whichever unrelated 2012 film sits earlier in the table.
    const owner = siblingOwningYear(db, request, libraryPath ? path.dirname(libraryPath) : null);
    if (!owner?.library_key) return;
    registerVideoTree(db, fullPath, {
      library_key: owner.library_key,
      title: owner.title || "",
      season: owner.season ?? 0,
    });
  } catch {}
}

/** Re-register a wrongly-attributed file under the library_key that owns its
 *  embedded IMDb id. Without this, media_files would keep claiming the inode
 *  belongs to the old key and every later read would trust that stale row.
 *  When the id belongs to nobody we can name, the row is dropped instead of
 *  left wrong: identity outranks every other signal, so a disproven row is
 *  worse than no row. */
function reassignContradictedFile(db: Database, fullPath: string, storedName: string): void {
  try {
    const id = nameImdbId(storedName);
    if (!id) return;
    const ownerKey = imdbIdOwnerKey(db, id);
    if (ownerKey) {
      const req = db.prepare("SELECT library_key, title, type, season FROM media_requests WHERE library_key = ? LIMIT 1").get(ownerKey) as any;
      if (req?.library_key) {
        registerVideoTree(db, fullPath, {
          library_key: req.library_key,
          title: req.title || "",
          season: req.season ?? (req.type === "movie" ? 0 : 1),
        });
        return;
      }
    }
    const st = fs.statSync(fullPath);
    if (st.ino > 0) db.prepare("DELETE FROM media_files WHERE dev = ? AND inode = ?").run(st.dev, st.ino);
  } catch {}
}

/**
 * Whether a processed-panel file belongs to this request: explicit association
 * (approval_history processed_files / torrent content basenames), registered
 * identity for the request's library_key, or title fallback only when the
 * request has zero explicit associations (matches the processed panel).
 */
function processedFileMatchesRequest(db: Database, request: any, fullPath: string, matchedNames: Set<string>, libraryPath?: string | null): boolean {
  const base = path.basename(fullPath);
  const processedDir = getProcessedDir(request.type === "series" ? "series" : "movie");
  const rel = path.relative(processedDir, fullPath);
  // An explicit id in the name beats everything below, including registered
  // identity: a name can only carry an id because something wrote the film's real
  // id there, so a mismatch is proof the file is not this request's.
  if (nameContradictsRequest(db, request, base)) return false;
  // ...and so is a file whose own library twin is filed under a year a sibling
  // owns. Checked BEFORE the identity branch, because a stale media_files row must
  // not outrank a folder that plainly says otherwise — and healing it here is what
  // keeps this read consistent with the processed panel, which vetoes the same way.
  if (libraryPath !== undefined && libraryPath) {
    if (libraryFolderContradicts(db, request, libraryPath)) {
      reassignFileByLibraryFolder(db, request, fullPath, libraryPath);
      return false;
    }
  }
  // Identity (dev, inode) is the source of truth and outranks everything else —
  // including the approval_history association, which can be stale: a same-named
  // franchise (DuckTales 1987 vs 2017) may hold the other's basenames after an
  // earlier fuzzy match. A registered file belongs to exactly one library_key.
  // Names/association are only a backup for files that carry no identity (a
  // copied, doomed inode still resolves by name).
  if (request.library_key) {
    try {
      const identityRow = identifyByPath(db, fullPath);
      if (identityRow) {
        if (identityRow.library_key === request.library_key) return true;
        // A row naming a library_key NO request holds is unattributable, not a
        // statement about this file. That is exactly what a retitle performed
        // before media_files was migrated with the key leaves behind: the row
        // keeps the dead key, so identity vetoes the file for every request and
        // the file disappears from its own card ("Nothing to rename in this
        // layer") while still sitting in /Processed. A disproven attribution is
        // worse than none - identity outranks every signal, so leave the row for
        // the name/id fallback to claim and do not let a phantom veto decide.
        const owner = db
          .prepare("SELECT COUNT(*) c FROM media_requests WHERE library_key = ?")
          .get(identityRow.library_key) as any;
        if (!owner || !owner.c) {
          registerVideoTree(db, fullPath, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
          return true;
        }
        return false;
      }
    } catch {}
  }
  if (matchedNames.has(base) || matchedNames.has(rel)) {
    // CLAIM the inode while we are admitting it. Startup deletes identity rows
    // naming an unowned key, and this is the branch that gets a file admitted
    // without any row - it matched approval_history by name, so nothing re-registers
    // it and it stays unattributed forever. That is not cosmetic: an unregistered
    // inode cannot be found by identity from the other side, so its own library
    // twin's folder becomes unreachable (a Polish folder name plus a pre-canonical
    // file name state no title and no id, leaving only the inode - see
    // nativeMovieLibraryFolders). Registering here is what makes the fallback find
    // it, and it is the same evidence that admitted the file.
    if (request.library_key) {
      try {
        registerVideoTree(db, fullPath, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
      } catch {}
    }
    return true;
  }
  // A twin of one of this request's own library files IS this request's file,
  // even with no media_files row at all (adoption leaves the inode unregistered).
  if (libraryPath) return true;
  if (matchedNames.size === 0) {
    try {
      const requestTitleNorm = (request.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const entryNorm = base.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (titlesMatch(requestTitleNorm, entryNorm)) return true;
    } catch {}
  }
  return false;
}

/** Probe a set of paths in parallel (capped), cached by dev:ino so hardlinked
 * twins probe exactly once. Returns a map usable by both processed + library
 * rows for the same underlying file. */
async function probeInodesConcurrently(paths: string[]): Promise<Map<string, ProbeInfo | null>> {
  const map = new Map<string, ProbeInfo | null>();
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++];
      try {
        const st = fs.statSync(p);
        const key = `${st.dev}:${st.ino}`;
        if (map.has(key)) continue;
        const probe = await probeVideoFile(p);
        map.set(key, probe);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return map;
}

/** How many extra episodes one packed file may name. Two halves of a story in one
 *  file is the norm; the cap stops a loose segment match running up the season. */
const PACKED_EPISODE_CAP = 3;

/** The episode a file REALLY is, and the span it really covers.
 *
 *  parseEpisodeCode reads what the NAME claims, which is not always what the file
 *  is. When a release packs a TMDB double episode into one file it keeps only the
 *  first number — DuckTales S01E51 "Magicas Magic Mirror Take Me Out of the
 *  Ballgame" is TMDB's E51 AND E52, which TMDB itself flags as "First part of double
 *  episode" / "Second part of double episode" — so every later file in that release
 *  is numbered one behind and its own title sits at the NEXT index.
 *
 *  Both corrections come from the same evidence and only make sense together: the
 *  packed file becomes "S01E51-52" while the file after it moves to 53. Crediting
 *  the range alone would claim episode 52 twice, and moving the tail alone would
 *  leave the packed file hiding one of the two episodes it holds.
 *
 *  An explicit "S01E01-02" range in the name is left exactly as it is: the release
 *  already declares its own span, so there is nothing left to infer. */
function resolveEpisodeSpan(
  db: Database,
  request: any,
  base: string,
  parsed: { season: number; episode: number; episodeEnd?: number },
): { season: number; episode: number; episodeEnd?: number } {
  const out = { season: parsed.season, episode: parsed.episode, episodeEnd: parsed.episodeEnd };
  const key = request.library_key;
  if (!key || parsed.episodeEnd || parsed.season === 0) return out;
  const own = episodeTitleFromSourceName(base);
  if (!own) return out;
  const lang = franchiseLanguage(db, key);
  const at = (n: number) => episodeTitleFromCache(db, key, parsed.season, n, lang);
  const ownNorm = normalizeTitleForCompare(own);

  // A packed file is written as this episode's title FOLLOWED BY the next one's, so
  // both ends must line up. Requiring the extra title to TRAIL the on-disk title is
  // what keeps a file that merely mentions another episode's words from claiming it:
  // the DuckTales pilot's E01 filename carries the wording of both halves while the
  // release ships a separate E02 file, which plain word overlap turned into a bogus
  // "S01E01-02".
  const here = at(parsed.episode);
  if (here && titleStartsWith(ownNorm, normalizeTitleForCompare(here))) {
    let last = parsed.episode;
    while (last - parsed.episode < PACKED_EPISODE_CAP) {
      const next = at(last + 1);
      if (!next || !titleEndsWith(ownNorm, normalizeTitleForCompare(next))) break;
      last++;
    }
    if (last > parsed.episode) out.episodeEnd = last;
    return out;
  }
  // Its own title agrees with the number it claims: nothing is wrong with it. This
  // also covers a release naming its episodes in another language than the cache
  // (the cache defaults to en-US with no language pref set), where no window entry
  // would match and the claimed number is the correct one anyway.
  if (here && episodeTitleAgrees(own, here)) return out;

  // Shifted by a pack earlier in the season: the file's own title says where it
  // belongs. EXACTLY ONE candidate may claim it — DuckTales E01 overlaps both
  // "Don't Give Up the Ship (1)" and "(2)", and a shift that merely found a match
  // would move that file onto a number a sibling already holds. Zero matches (a
  // reworded or translated title) and several matches alike leave the number alone.
  const hits: number[] = [];
  for (const n of [parsed.episode + 1, parsed.episode + 2, parsed.episode - 1, parsed.episode - 2]) {
    if (n < 1 || n === parsed.episode) continue;
    const other = at(n);
    if (other && episodeTitleAgrees(own, other)) hits.push(n);
  }
  if (hits.length === 1) out.episode = hits[0];
  return out;
}

/** Episode title for a file, honouring TMDB first and the on-disk name as the
 *  fallback. A multi-episode file has no single TMDB entry, so its cached titles
 *  are joined the way scene releases already write them ("S01E01-02 Kolejka - Fretka
 *  traci głowę"). `ep` must already be resolved by resolveEpisodeSpan, which owns
 *  every correction to the numbering. */
export function episodeTitleFor(db: Database, request: any, base: string, ep: { season: number; episode: number; episodeEnd?: number }): string | null {
  const key = request.library_key;
  const lang = key ? franchiseLanguage(db, key) : null;
      const own = episodeTitleFromSourceName(base);
      if (!key) return own;
      const at = (n: number, allowPlaceholder = false) =>
        episodeTitleFromCache(db, key, ep.season, n, lang, { allowPlaceholder });
      if (ep.episodeEnd && ep.episodeEnd > ep.episode) {
        const parts: string[] = [];
        let anyPlaceholder = false;
        for (let n = ep.episode; n <= ep.episodeEnd; n++) {
          const real = at(n);
          if (real) { parts.push(real); continue; }
          const slot = at(n, true);
          if (!slot) return own;
          parts.push(slot);
          anyPlaceholder = true;
        }
        if (!anyPlaceholder) return parts.join(" - ");
        return own || parts.join(" - ");
      }
      // Precedence: a REAL TMDB title, then the release's own name, then TMDB's
      // slot title. The last step is new and is the whole point — TMDB titles some
      // seasons "Episode 1".."Episode 8" (Disney+ does), and episodeTitleFromCache
      // rejects those by default, so a release naming no episode of its own came
      // out with no title at all while the very title on screen went unused. A real
      // name from the release still outranks it, so a release that DOES name its
      // episode keeps its own wording.
      return at(ep.episode) || own || at(ep.episode, true);
    }

/** Lowercased, apostrophes deleted, everything else collapsed to single spaces.
 *  Apostrophes are DELETED rather than swept to a space: they are the only
 *  difference between a release's "Scrooges Pet" and TMDB's "Scrooge's Pet", and a
 *  space would split the word into "scrooge s" so the two would stop comparing as
 *  the same episode. */
function normalizeTitleForCompare(s: string): string {
  return s.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function titleStartsWith(whole: string, part: string): boolean {
  return !!part && (whole === part || whole.startsWith(part + " "));
}

function titleEndsWith(whole: string, part: string): boolean {
  return !!part && (whole === part || whole.endsWith(" " + part));
}

/** Whether an on-disk episode title and TMDB's title for that episode number are
 *  the same episode, judged by the house matcher (prefix, then tolerant word
 *  overlap). Reuses titlesMatch rather than a bespoke overlap count so this agrees
 *  with every other title comparison in the file. */
function episodeTitleAgrees(onDisk: string, cached: string): boolean {
  return titlesMatch(normalizeTitleForCompare(onDisk), normalizeTitleForCompare(cached));
}

/** Episode title already present in an on-disk name ("... - S03E15 - The
 * Screaming Earth [1080p]...") — used only when TMDB has nothing cached, so a
 * rename can never silently strip a title that is already on disk. */
/** A release can go straight from the episode code into its tags, naming no
 *  episode at all ("S14E01.1080p.iP.WEB-DL.AAC2.0.HFR.H.264-RAWR"). Anchored at
 *  the START of what follows the code, because a real episode title never BEGINS
 *  with a resolution, source, provider or codec token — unlike the resolution
 *  search below, which is a substring match and so may fire mid-title.
 *
 *  The scanner itself now lives in ../config/naming (episodeTitleSpan /
 *  episodeTitleFromSourceName): collectEditions needs the title's CHARACTER
 *  RANGE to keep prose out of the edition tags, and naming.ts cannot import from
 *  here — requests.ts already imports naming.ts, so the reverse would be
 *  circular. Moved wholesale rather than copied, because two implementations of
 *  "where does the title end" would eventually disagree about the same name. */


/** On-disk title for an S00 special, with a leading show-name prefix removed so
 *  "Fineasz i Ferb S00E01 Kolejka - Original Pitch" offers "Kolejka - Original
 *  Pitch" rather than the show name glued on the front. */
function specialTitleFromSourceName(base: string, request: any, showTitle?: string | null): string | null {
  const raw = episodeTitleFromSourceName(base);
  if (!raw) return null;
  let out = raw;
  for (const p of [request?.title || "", showTitle || ""].filter(Boolean)) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const stripped = out.replace(new RegExp(`^${esc}\\s*[-–—:]?\\s*`, "i"), "").trim();
    if (stripped.length >= 3 && stripped !== out) out = stripped;
  }
  return out.length >= 3 ? out : raw;
}

/** Candidate title for a special carrying NO S00Exx marker — a movie filed
 *  straight into S00 ("Kacze opowieści Poszukiwacze zaginionej lampy 1990.mkv").
 *  A trailing year is deliberately KEPT: it belongs to the title as often as not
 *  ("Blade Runner 2049", "1917"), and the resolver tolerates it as one unmatched
 *  word. Only the release tail (first bracket group) is cut. */
function specialTitleFromBareName(base: string): string | null {
  let out = base.replace(/\.(mkv|mp4|avi|mov|ts|wmv|m4v)$/i, "");
  const bracket = out.search(/[[({]/);
  if (bracket > 0) out = out.slice(0, bracket);
  out = out.replace(/\s*[\])}]\s*$/, "").replace(/[\s._-]+$/, "").trim();
  if (out.length < 3 || out.length > 120) return null;
  if (!/[a-z]{3}/i.test(out)) return null;
  return out;
}

/** A bare leading number on an unnumbered special ("1 Krecik i balonik (special) …")
 *  is the release's own numbering of the S00 extras.
 *
 *  parseEpisodeCode deliberately needs TWO digits for a bare number, and that guard
 *  is right everywhere else: "7 Samurai" and "3.10 to Yuma" must never become
 *  S01E07. An unnumbered special has no SxxExx to renumber and is already scoped to
 *  season 0, so there is nothing for the number to collide with — and here a single
 *  digit is exactly as meaningful as "12".
 *
 *  Requires trailing whitespace, never a dot: that is what keeps a film title
 *  beginning with a figure ("3.10 to Yuma") out, and a 4-digit year cannot match
 *  because the lookahead fails mid-number. */
function bareSpecialNumber(base: string): number | null {
  const m = base.match(/^\s*(\d{1,3})(?=\s)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Resolve an S00 special's own title/year/imdbId, preferring TMDB and falling
 *  back to the on-disk name. Two sources: the name after the episode code, and
 *  that with a leading show-name prefix stripped. */
/** True when a special's on-disk title is a generic SLOT marker rather than a
 *  film title. "Episode 1", "Christmas Special 2022", "Pilot" name a position in
 *  the show, not a film — and searching TMDB's movie catalogue with one matched
 *  Death in Paradise's S11E00 to an unrelated 2003 film, injecting its year (and
 *  potentially an `[imdbid-tt…]`) into the canonical name. Such a title can only
 *  be resolved against the show's own data, never the film catalogue, so it is
 *  kept as the on-disk title. A real film in S00 ("Niezwykła podróż") matches none
 *  of these and is still looked up. */
function isGenericSpecialSlot(title: string): boolean {
  const t = title.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (/^(episode|ep|special|odcinek|pilot|final|part|volume|vol|chapter|bonus|feature|extra)s? ?\d*$/.test(t)) return true;
  // "special 2022", "episode one", "the pilot" — a slot word plus little else.
  if (/(^| )(episode|special|pilot|odcinek)\b/.test(t) && t.split(" ").length <= 4) return true;
  return false;
}

async function specialPiecesForFile(db: Database, request: any, sourceBase: string, showPieces: NamingPieces | null, episode?: number | null): Promise<{ title: string; year: number | null; imdbId: string | null; onTmdb: boolean; episodeNumber: number | null } | null> {
  const rest = episodeTitleFromSourceName(sourceBase);
  const stripped = specialTitleFromSourceName(sourceBase, request, showPieces?.title);
  // A movie special is often filed with NO S00Exx marker at all, and both
  // code-derived helpers above return null for those. Bailing out here left such
  // a file permanently un-nameable ("No title in file name") even though it
  // states its own film title and TMDB can resolve it — so fall back to the
  // release name itself rather than giving up.
  const bare = rest ? null : specialTitleFromBareName(sourceBase);
  // A release that split ONE special in two names only its second half ("… part
  // 2"), and TMDB matches no film with that tail — so that half used to keep its
  // on-disk title while the plain half was given the real one (year, imdb id and
  // all), and two identities that never meet under one key can never be read as
  // halves of one release. The unmarked spelling is looked up too, but only
  // AFTER the release's own: a film genuinely titled "… Part 2" must resolve to
  // itself, and only a genuinely unmatched tail falls through to it. The title
  // kept for a lookup that failed entirely is the unmarked one, so a name the
  // release itself wrote as "part 2" is not printed as part of the title and
  // then appended as a marker a moment later.
  const clean = stripPartFromSourceName(sourceBase);
  const restC = episodeTitleFromSourceName(clean);
  const strippedC = specialTitleFromSourceName(clean, request, showPieces?.title);
  const bareC = restC ? null : specialTitleFromBareName(clean);
  const diskTitle = strippedC || restC || bareC || stripped || rest || bare;
  if (!diskTitle) return null;
  const lang = request.library_key ? franchiseLanguage(db, request.library_key) : null;
  const candidates = [...new Set(
    [stripped, rest, bare, strippedC, restC, bareC].filter((c): c is string => !!c),
  )];
  const isSlot = isGenericSpecialSlot(diskTitle);

  // A slot marker names a position in the show, not a film — so before reaching
  // for the film catalogue, see whether the show's OWN S00 list can say which
  // special this is. Providers number these as `E0` of the season they lead
  // into (`S12E00` = the Christmas Special 2022), and only the air date TMDB
  // records identifies which one an unnumbered file is.
  //
  // An explicit `S00E07` is never second-guessed: the release already stated a
  // real number, and inferring over it could re-point a correctly numbered file.
  if (request.library_key && isSlot && !(episode && episode > 0)) {
    const statedYear = Number((diskTitle.match(/\b(19|20)\d{2}\b/) || [])[0]);
    const afterSeason = parseEpisodeCode(sourceBase)?.season ?? null;
    try {
      const hit = await findSpecialByAirDate(db, request.library_key, cleanFranchiseTitle(request.title || ""), {
        year: Number.isFinite(statedYear) ? statedYear : null,
        beforeSeason: afterSeason != null && afterSeason > 0 ? afterSeason : null,
        lang,
      });
      if (hit) return { title: hit.name || diskTitle, year: null, imdbId: null, onTmdb: true, episodeNumber: hit.episode_number };
    } catch {}
  }

  // A special is usually filed on TMDB as its own movie. Try that first — it is
  // the most specific match. The scene title is in the release's own language
  // ("Fretka kontra Wszechświat") whose words share nothing with the English
  // title, so a non-English search runs too even when no franchise language is
  // configured, since these are the titles the files actually carry.
  const searchLang = lang || "pl-PL";
  for (const candidate of candidates) {
    if (isSlot) continue;
    try {
      const id = await resolveSpecialIdentity(candidate, searchLang);
      if (id) return { title: id.title, year: id.year, imdbId: id.imdbId, onTmdb: true, episodeNumber: null };
    } catch {}
  }
  // Not a film — but it may be a named special in the series' own S00 list
  // ("pilot episode"). Numbered episodes take their TMDB title, so use this one
  // for the same reason rather than keeping the on-disk name.
  if (request.library_key && episode) {
    try {
      const tmdbTitle = episodeTitleFromCache(db, request.library_key, 0, episode, lang);
      if (tmdbTitle) return { title: tmdbTitle, year: null, imdbId: null, onTmdb: true, episodeNumber: episode };
    } catch {}
  }
  return { title: diskTitle, year: null, imdbId: null, onTmdb: false, episodeNumber: null };
}

/**
 * Canonical basename proposal for ONE existing file (no extension never applied
 * here — callers keep the original extension). Returns null when nothing should
 * change (already canonical / missing pivots / naming disabled). Mirrors
 * canonicalFileBase but for on-disk files whose current name is the starting
 * point, and optionally enriched by an ffprobe probe.
 *
 * `forcedPart` supplies the part marker for a file whose OWN name carries none:
 * buildFixNameGroups uses it to label the unmarked half of a split release
 * `Part 1` once a sibling has already claimed `Part 2`. Routed through here
 * rather than stitched onto the finished name so both halves take the exact
 * same title-strip + append path and can never drift in format. */
async function proposeCanonicalName(
  db: Database,
  request: any,
  sourceBase: string,
  probe: ProbeInfo | null,
  cachedPieces?: NamingPieces | null,
  siblingBase?: string | null,
  forcedPart?: string | null,
): Promise<{ name: string | null; role: FixNameRow["role"] | null; note: string | null }> {
  const conf = loadNamingConf(db);
  if (!conf.enabled) return { name: null, role: null, note: "Naming disabled in Settings" };
  // Called per file, and the cache read is keyed by season+language — so make
  // the warm-up idempotent and cheap rather than assuming a prior preview ran.
  if (cachedPieces === undefined) await warmSeasonCache(db, request);
  const pieces = cachedPieces !== undefined ? cachedPieces : await namingPiecesForRequest(db, request);
  const ext = path.extname(sourceBase);
  const base = ext ? sourceBase.slice(0, -ext.length) : sourceBase;
  // Release metadata the probe cannot measure (source, group, edition) is
  // filled from the same-inode sibling's name when this one is silent about it,
  // so a twin named by an arr does not quietly drop facts the other one states.
  // The probe rides along so an inherited "Remux" is still checked against the
  // measurements — it arrives after the reconciliation inside assembleCanonicalTags.
  const tags = inheritReleaseFacts(assembleCanonicalTags(parseReleaseTags(base, vendorList(conf)), probe || null), siblingBase, vendorList(conf), probe || null);
  if (request.type === "movie") {
    if (!pieces) return { name: null, role: "movie", note: "Could not resolve TMDB identity" };
    // Same subdivision rule as the branches below: a movie release split on
    // disk ("… part 2") has TWO files, and the request's own identity supplies
    // them the same title — so without a marker the second one is just a `-2`
    // collision, which says nothing when the release had already said what sets
    // them apart. Unlike a special, no lookup can fail here: identity comes from
    // the request, never from the file name.
    let title = pieces.title;
    const part = forcedPart ?? partMarkerFromSourceName(base);
    // Not appended when the film's OWN title ends in one: the canonical form
    // puts the year after the title, so the marker stops matching on the next
    // pass and the file would flip between two spellings forever.
    if (part && title && stripPartMarker(title) === title) title = `${title} - ${part}`;
    const name = canonicalMovieFile(conf, { title, year: pieces.year, imdbId: pieces.imdbId, tags: tags.tags, group: tags.group, vendor: tags.vendor });
    if (!name) return { name: null, role: "movie", note: "Missing title/year/imdbId" };
    return { name: name === base ? null : name, role: "movie", note: null };
  }
  if (request.season === 0) {
    // A special is usually filed on TMDB as its own movie, never under the show,
    // so the show's id must not be reused. Resolve the special itself and keep
    // the S00Exx marker so two specials can never collapse to one name.
    const codeEp = parseEpisodeCode(base, { knownSeason: 0 })?.episode ?? null;
    // A bare leading digit counts as a declared number here, so it also reaches
    // specialPiecesForFile — which then skips air-date inference for the same
    // reason it skips it for an explicit S00E07: the release stated a number, and
    // inferring over it could re-point a correctly numbered file.
    const bareEp = codeEp == null ? bareSpecialNumber(base) : null;
    const sp = await specialPiecesForFile(db, request, base, pieces, codeEp ?? bareEp);
    if (!sp) return { name: null, role: "special", note: "No title in file name" };
    const epNo = parseEpisodeCode(base, { knownSeason: 0 });
    // A number resolved from the show's own S00 list outranks the release's own
    // marker: the file says "S12E00", which states a SEASON's zeroth episode and
    // names no special at all, whereas TMDB's air date says which one it is. Only
    // a positive number the release itself wrote is left alone.
    const declared = epNo?.episode ?? bareEp;
    const episodeNo = sp.episodeNumber ?? (declared && declared > 0 ? declared : null);
    // Having just consumed that digit as the S00Exx marker, it must not also
    // survive as title text — "1 Krecik i balonik" would otherwise render as a
    // numbered title beside its own number.
    let title = bareEp != null && episodeNo === bareEp
      ? sp.title.replace(/^\s*\d{1,3}\s+/, "").trim() || sp.title
      : sp.title;
    // The same subdivision rule episodes follow: a special split on disk
    // ("Return of the Roar" / "Return of the Roar part 2") resolves on TMDB to
    // ONE film, so both halves take the same canonical name and the loser
    // differs only by a `-2` collision suffix — the release had already written
    // down what sets them apart. The marker is a subdivision of the title, not a
    // competing title, so it rides after whichever title won. A bare special has
    // no episode code to read it from, which is why partMarkerFromSourceName
    // falls back to the name's untagged leading text.
    const part = forcedPart ?? partMarkerFromSourceName(base);
    if (part && stripPartMarker(title) === title) {
      // Not appended when the film's OWN title ends in one: the canonical form
      // puts the year after the title, so the marker stops matching on the next
      // pass and the file would flip between two spellings forever. An empty
      // title takes the marker alone, as it did before this guard existed.
      title = title ? `${title} - ${part}` : part;
    }
    const name = canonicalSpecialFile(conf, {
      title,
      year: sp.year,
      imdbId: sp.imdbId,
      season: 0,
      episode: episodeNo,
      tags: tags.tags,
      group: tags.group,
      vendor: tags.vendor,
    });
    if (!name) return { name: null, role: "special", note: "Missing title pieces" };
    return { name: name === base ? null : name, role: "special", note: sp.onTmdb ? null : "Not on TMDB - kept the on-disk title" };
  }
  const parsed = parseEpisodeCode(sourceBase, { knownSeason: request.season ?? null });
  if (!parsed) return { name: null, role: "episode", note: "No episode number in name" };
  if (parsed.season !== (request.season ?? parsed.season)) return { name: null, role: "episode", note: `S${parsed.season} does not match request season` };
  const ep = resolveEpisodeSpan(db, request, base, parsed);
  // A release that split ONE episode in two states the difference as a part
  // marker ("S02E05 Part 2"), and that marker is a SUBDIVISION of the title, not
  // a competing title. TMDB files the episode as a single entity, so both halves
  // resolve to "The Rise of Scar", receive the same canonical name, and the
  // loser only differs by a `-2` collision suffix — a version number that says
  // nothing when the release had already said exactly what sets them apart. So
  // the marker rides along after whichever title won.
  const part = forcedPart ?? partMarkerFromSourceName(base);
  let episodeTitle = episodeTitleFor(db, request, base, ep);
  if (part) {
    // Strip before appending: when TMDB had nothing cached the release's own
    // title IS "Part 2", and appending to it would render "Part 2 - Part 2".
    const stripped = stripPartMarker(episodeTitle ?? "");
    episodeTitle = stripped ? `${stripped} - ${part}` : part;
  }
  const airDate = request.library_key ? episodeAirDateFromCache(db, request.library_key, ep.season, ep.episode, franchiseLanguage(db, request.library_key)) : null;
  const name = canonicalEpisodeFile(conf, {
    title: (pieces?.title || cleanFranchiseTitle(request.title || "")).replace(/ \(\d{4}\)$/, ""),
    season: ep.season,
    episode: ep.episode,
    episodeEnd: ep.episodeEnd ?? null,
    episodeTitle,
    airDate,
    episodeYear: airDate ? airDate.slice(0, 4) : null,
    tags: tags.tags,
    group: tags.group,
    vendor: tags.vendor,
  });
  if (!name) return { name: null, role: "episode", note: "Missing title/episode pieces" };
  return { name: name === base ? null : name, role: "episode", note: null };
}

/** Build the grouped processed+library proposal rows + folder rows for one request (native only). */
async function buildFixNameGroups(db: Database, request: any): Promise<{ groups: FixNameGroup[]; dirs: FixNameDirRow[] }> {
  const type = request.type === "series" ? "series" : "movie";
  const processedDir = getProcessedDir(type);
  if (!fs.existsSync(processedDir)) return { groups: [], dirs: [] };

  const matchedNames = new Set<string>();
  const approvals = db.prepare(
    "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
  ).all(request.id) as any[];
  for (const ah of approvals) {
    try {
      for (const n of JSON.parse(ah.processed_files) as string[]) matchedNames.add(n);
    } catch {}
  }

  // Register identity for the inodes this request already claims, BEFORE the
  // library folders are resolved below. Otherwise the two lookups deadlock: the
  // folder is reachable only by identity, and identity is only registered once a
  // read admits the file - but the processed scan runs after this. A processed
  // twin and its library copy are the same inode, so registering the processed
  // side is what lets the library side be found. Keyed by approval_history here
  // (an explicit association, not a fuzzy title), so nothing is claimed on a
  // guess; the processed scan below re-registers the same inodes for files that
  // were matched another way.
  if (request.library_key) {
    try {
      for (const n of matchedNames) {
        const full = path.join(processedDir, n);
        if (!fs.existsSync(full)) continue;
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          registerVideoTree(db, full, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
        } catch {}
      }
    } catch {}
  }

  // Library twin paths by inode (native: movie folders / series season folder).
  // Built BEFORE the processed scan because acceptance needs it: a twin of this
  // request's own library file IS this request's file, and a twin filed under a
  // year a sibling owns is decisive against it (see processedFileMatchesRequest).
  const libraryByIno = new Map<string, string>();
  const scanLibraryFile = (fp: string) => {
    try {
      const st = fs.statSync(fp);
      const key = `${st.dev}:${st.ino}`;
      if (st.isFile() && !libraryByIno.has(key)) libraryByIno.set(key, fp);
    } catch {}
  };
  if (type === "movie") {
    for (const folder of nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)) {
      if (!fs.existsSync(folder)) continue;
      for (const f of fs.readdirSync(folder)) {
        if (f.startsWith(".") || !VIDEO_FILE_RE.test(f)) continue;
        scanLibraryFile(path.join(folder, f));
      }
    }
  } else {
    // Scan EVERY fuzzy-matching library show folder, not just the resolved one.
    // Twins are keyed by inode, so a same-named sibling (DuckTales 1987 vs
    // 2017, or a year-range folder) can never be mistaken for this show's file:
    // each processed inode only ever finds its true library hardlink.
    const baseTitle = (request.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
    for (const showFolder of matchLibraryShowFolders(baseTitle, request.library_key)) {
      scanVideoTreeFiles(showFolder, scanLibraryFile);
    }
  }
  const twinFor = (fp: string): string | null => {
    try {
      const st = fs.statSync(fp);
      return libraryByIno.get(`${st.dev}:${st.ino}`) || null;
    } catch {
      return null;
    }
  };

  // Processed files, same season-filtered acceptance as the processed panel.
  // Accepted files also pin the folders this request owns (movie subdir, show
  // dir + Sxx dir for series) — the basis for the directory rename rows below.
  const accepted: { fullPath: string }[] = [];
  const showSeasons = new Map<string, Set<string>>();
  const movieDirs = new Set<string>();
  const targetSeason =
    type === "series" && request.season != null ? `S${String(request.season).padStart(2, "0")}` : null;
  try {
    for (const entry of fs.readdirSync(processedDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(processedDir, entry.name);
      if (entry.isDirectory()) {
        if (type === "movie") {
          // Foldered movie: PROCCESSED_MOVIES/<MovieDir>/<file>.
          for (const f of fs.readdirSync(fullPath)) {
            if (f.startsWith(".") || !VIDEO_FILE_RE.test(f)) continue;
            const fp = path.join(fullPath, f);
            if (processedFileMatchesRequest(db, request, fp, matchedNames, twinFor(fp))) { accepted.push({ fullPath: fp }); movieDirs.add(fullPath); }
          }
          continue;
        }
        for (const sub of fs.readdirSync(fullPath, { withFileTypes: true })) {
          if (sub.name.startsWith(".") || !sub.isDirectory() || !/^S\d+$/i.test(sub.name)) continue;
          if (targetSeason && sub.name.toUpperCase() !== targetSeason) continue;
          const seasonDir = path.join(fullPath, sub.name);
          for (const f of fs.readdirSync(seasonDir)) {
            // Dotfiles are skipped: a Fix Names batch parks files under
            // .fixnames-tmp-<dev>-<ino> while it works, and a half-finished batch
            // must never offer one of them as a renamable row.
            if (f.startsWith(".") || !VIDEO_FILE_RE.test(f)) continue;
            const fp = path.join(seasonDir, f);
            if (processedFileMatchesRequest(db, request, fp, matchedNames, twinFor(fp))) {
              accepted.push({ fullPath: fp });
              if (!showSeasons.has(fullPath)) showSeasons.set(fullPath, new Set());
              showSeasons.get(fullPath)!.add(seasonDir);
            }
          }
        }
      } else {
        if (!VIDEO_FILE_RE.test(entry.name)) continue;
        if (processedFileMatchesRequest(db, request, fullPath, matchedNames, twinFor(fullPath))) accepted.push({ fullPath });
      }
    }
  } catch {}

  // The processed show folder is a FRANCHISE-level folder, but the scan above only
  // reaches it through a file this request owns. A season with nothing of its own
  // on disk — S00 whose specials live only in the library, or an empty grip —
  // therefore saw no processed folder at all, while the library side (resolved
  // independently by resolveLibraryShowFolder) still listed one: the modal showed
  // "LIB DIR" alone and the non-canonical processed name was invisible from that
  // season. Fall back to the sibling seasons of the same library_key, which share
  // one show folder — folderOwnedExclusively already treats same-key files as
  // owned, so this proposes exactly the folder the franchise owns. Added with an
  // EMPTY season set on purpose: the siblings' season dirs are renamed from their
  // own modal, not from this one.
  if (type === "series" && showSeasons.size === 0 && request.library_key) {
    try {
      const sibs = db
        .prepare("SELECT id FROM media_requests WHERE library_key = ? AND id != ?")
        .all(request.library_key, request.id) as any[];
      const sibShow = sibs.length ? processedShowDirFromFiles(db, sibs.map((s) => s.id)) : null;
      if (sibShow && fs.existsSync(sibShow)) showSeasons.set(sibShow, new Set());
    } catch {}
  }

  // Probe all involved files once per dev:ino (parallel, cached).
  const probePaths = accepted.map((a) => a.fullPath).concat([...libraryByIno.values()]);
  const probes = await probeInodesConcurrently(probePaths);

  // Episode titles + identity both come from TMDB, so warm this request's season
  // (franchise language, altTitle = the on-disk show folder) before resolving
  // identity: a season that was never fetched would otherwise propose names with
  // the episode title stripped.
  const { pieces: cachedPieces, reason: identityReason } = await fixNamesPieces(db, request, [
    ...(type === "movie" ? movieDirs : []),
    ...(type === "series" ? [...showSeasons.keys()] : []),
    ...(type === "series" ? [resolveLibraryShowFolder(request) || ""] : []),
    ...(type === "movie" ? nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key) : []),
  ]);
  // When nothing resolves, say why in the row note — one short, actionable
  // sentence, never an internal step dump.
  const identityNote = cachedPieces ? null : `Could not resolve identity — ${identityReason || "no IMDb/TVDB id found"}`;

  const groups: FixNameGroup[] = [];
  let gid = 0;
  for (const a of accepted) {
    let ino: number | null = null;
    let key = "";
    let probe: ProbeInfo | null = null;
    try {
      const st = fs.statSync(a.fullPath);
      ino = st.ino;
      key = `${st.dev}:${st.ino}`;
      probe = probes.get(key) || null;
    } catch {}

    const libPath = key ? libraryByIno.get(key) : null;
    const processedBase = path.basename(a.fullPath);
    // Each row is named from its own name first, then inherits what it is
    // silent about from the same-inode sibling (identical bytes, two names).
    // The library row therefore keeps a "Remux"/group the processed row states,
    // while a library row that names Atmos of its own accord keeps that too.
    const pb = await proposeCanonicalName(db, request, processedBase, probe, cachedPieces, libPath ? path.basename(libPath) : null);
    // Canonical file proposals are extensionless by construction — append the
    // source extension unconditionally (never detect one from the name: channel
    // layouts like "[DTS-HD MA 2.0]" contain dots that would fool extname).
    const withExt = (name: string | null, p: string) => (name ? `${name}${path.extname(p)}` : null);
    const processed: FixNameRow = {
      id: `p-${gid}`,
      ino,
      path: a.fullPath,
      tree: "processed",
      currentName: processedBase,
      proposedName: withExt(pb.name, a.fullPath),
      role: pb.role,
      note: pb.note,
    };

    let library: FixNameRow | null = null;
    if (libPath) {
      const lb = await proposeCanonicalName(db, request, path.basename(libPath), probe, cachedPieces, processedBase);
      library = {
        id: `l-${gid}`,
        ino,
        path: libPath,
        tree: "library",
        currentName: path.basename(libPath),
        proposedName: withExt(lb.name, libPath),
        role: lb.role,
        note: lb.note,
      };
    }

    groups.push({ id: `g${gid++}`, ino, processed, library });
  }

  // A split release marks only its SECOND half ("… part 2"), so the plain
  // sibling took the bare canonical name — and then listed BACKWARDS, because
  // "[tags]" outranks every marker character: "-" (0x2D) and "P" (0x50) both
  // sort below "[" (0x5B), so Part 2 came first whichever way it was spelled.
  // Naming the plain half "Part 1" is the only arrangement that orders
  // correctly, and it is safe precisely because a marked sibling exists: the key
  // is the canonical name with the marker stripped, so two files only ever meet
  // here when they are otherwise IDENTICAL — a second version at another quality
  // strips to a different key and is never filled. Every branch reads a marker
  // now — episode, special and movie alike — so no row is singled out here.
  //
  // Both halves reach the marker through the SAME code path: this re-proposes
  // rather than stitching " - Part 1" onto a finished name, so the two can never
  // drift in format.
  const extless = (n: string) => {
    const e = path.extname(n);
    return e && n.endsWith(e) ? n.slice(0, -e.length) : n;
  };
  const partBuckets = new Map<string, { nums: Set<number>; plain: FixNameGroup[] }>();
  for (const g of groups) {
    if (!g.processed) continue;
    const canon = extless(g.processed.proposedName ?? g.processed.currentName);
    let b = partBuckets.get(partGroupKey(canon));
    if (!b) {
      b = { nums: new Set(), plain: [] };
      partBuckets.set(partGroupKey(canon), b);
    }
    const n = partNumberIn(canon);
    if (n != null) b.nums.add(n);
    else b.plain.push(g);
  }
  for (const b of partBuckets.values()) {
    if (!b.plain.length || !needsPartOne([...b.nums])) continue;
    for (const g of b.plain) {
      if (!g.processed) continue;
      const redrive = async (row: FixNameRow, sibling: string | null, srcPath: string) => {
        let rowProbe: ProbeInfo | null = null;
        try {
          const st = fs.statSync(srcPath);
          rowProbe = probes.get(`${st.dev}:${st.ino}`) || null;
        } catch {}
        const r = await proposeCanonicalName(db, request, path.basename(srcPath), rowProbe, cachedPieces, sibling, "Part 1");
        if (r.name) row.proposedName = `${r.name}${path.extname(srcPath)}`;
        row.role = r.role;
        row.note = r.note;
      };
      await redrive(g.processed, g.library ? g.library.currentName : null, g.processed.path);
      if (g.library) await redrive(g.library, g.processed.currentName, g.library.path);
    }
  }

  // Two DIFFERENT files can legitimately claim one SxxExx — that's just two
  // versions of an episode, so the rename is never blocked. But the modal has to
  // show the name a row will ACTUALLY land on: uniqueDestPath only runs at apply
  // (planFixNameDest), so preview used to advertise the bare canonical base and
  // then change it — hiding which file becomes primary, and making a manually
  // disambiguated "-2" look like it was being stripped.
  const claimedByDir = new Map<string, Set<string>>();
  const allRows: (FixNameRow | null)[][] = groups.map((g) => [g.processed, g.library]);

  const moving = new Set<FixNameRow>();
  const occupant = new Map<string, FixNameRow>();
  for (const rows of allRows) {
    for (const row of rows) {
      if (!row) continue;
      occupant.set(path.join(path.dirname(row.path), path.basename(row.path)), row);
      if (row.proposedName) moving.add(row);
    }
  }

  const extOf = (row: FixNameRow) => path.extname(row.path);
  const stemOf = (row: FixNameRow) => {
    const ext = extOf(row);
    const name = row.proposedName as string;
    return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Sticky version suffix: a file already named "<canonical base>-N" keeps that N
  // and never competes for the bare name. Deciding primary by submission order
  // alone meant a manual disambiguation silently swapped whenever the list order
  // changed; excluding the suffixed file from the bare-name race makes the outcome
  // order-independent. A lone "-2" therefore stays "-2" rather than collapsing to
  // the bare name — that is the point, since renaming it would be pure churn.
  const stickyOf = (row: FixNameRow) => {
    const ext = extOf(row);
    if (!ext) return null;
    return new RegExp(`^${esc(stemOf(row))}-\\d{1,3}${esc(ext)}$`, "i").test(row.currentName) ? row.currentName : null;
  };

  const claim = (row: FixNameRow, name: string) => {
    const dir = path.dirname(row.path);
    let claimed = claimedByDir.get(dir);
    if (!claimed) {
      claimed = new Set<string>();
      claimedByDir.set(dir, claimed);
    }
    claimed.add(name.toLowerCase());
  };
  const isClaimed = (row: FixNameRow, name: string) => claimedByDir.get(path.dirname(row.path))?.has(name.toLowerCase()) ?? false;

  // Unavailable means: claimed by an earlier row, OR present on disk and NOT about
  // to be vacated. Apply stages exactly the movers, so a mover's current name is
  // free for the whole batch — which is what stops a season-wide renumber (every
  // canonical name still held by the file that moves next) from cascading into
  // suffixes. A file outside the batch is never staged, so it still blocks, exactly
  // as it does for the real uniqueDestPath.
  const isTaken = (row: FixNameRow, name: string) => {
    if (isClaimed(row, name)) return true;
    const dest = path.join(path.dirname(row.path), name);
    let exists: boolean;
    try {
      exists = fs.existsSync(dest);
    } catch {
      return false;
    }
    if (!exists) return false;
    const sitting = occupant.get(dest);
    if (!sitting) return true;
    return sitting === row ? false : !moving.has(sitting);
  };

  // Rows with no proposal are NOT renamed — already canonical, identity unresolved,
  // or naming disabled — so they keep sitting on their current name and every mover
  // has to route around them. Seeded first because they block regardless of order.
  // This is the state you land in right after a rename: the primary is canonical and
  // only its "-2" twin still has work.
  for (const rows of allRows) {
    for (const row of rows) {
      if (row && !row.proposedName) claim(row, row.currentName);
    }
  }

  const resolve = (row: FixNameRow, firstChoice: string) => {
    const ext = extOf(row);
    const stem = stemOf(row);
    if (!isTaken(row, firstChoice)) return firstChoice;
    for (let i = 2; i < 100; i++) {
      const cand = `${stem}-${i}${ext}`;
      if (!isTaken(row, cand)) return cand;
    }
    return `${stem}-${Date.now()}${ext}`;
  };
  const suffixed = (row: FixNameRow, name: string) => {
    // Slice between the stem and the extension: name is "<stem>-N<ext>", so the
    // naive stem.length + 1 ran on through to the extension ("version 2.mp4").
    const warn = `Another file in this folder claims this episode — this one becomes version ${name.slice(stemOf(row).length + 1, name.length - extOf(row).length)}`;
    row.note = row.note ? `${row.note}; ${warn}` : warn;
  };

  // Bare-name race first, sticky rows last: the unsuffixed file claims the bare
  // name before any "-N" row is considered, so the suffix is honoured no matter
  // which order the rows arrive in.
  const sticky: FixNameRow[] = [];
  for (const rows of allRows) {
    for (const row of rows) {
      if (!row?.proposedName) continue;
      const keep = stickyOf(row);
      if (keep) {
        sticky.push(row);
        continue;
      }
      const name = resolve(row, row.proposedName);
      if (name !== row.proposedName) suffixed(row, name);
      claim(row, name);
      row.proposedName = name;
    }
  }
  for (const row of sticky) {
    const keep = stickyOf(row) as string;
    const name = isTaken(row, keep) ? resolve(row, keep) : keep;
    if (name !== row.proposedName) suffixed(row, name);
    claim(row, name);
    row.proposedName = name;
  }

  // A resolution that lands back on the current name means there is genuinely
  // nothing to do — report it as already canonical rather than offering a rename
  // to itself.
  for (const rows of allRows) {
    for (const row of rows) {
      if (row?.proposedName && row.proposedName === row.currentName) row.proposedName = null;
    }
  }

  // Folder-level proposals. Processed tree first (this request's show dir, then
  // its season dirs — top-down), then library dirs for the same franchise. A
  // folder is proposed only when this request "owns" it: no registered file
  // inside maps to a DIFFERENT library_key (protects multi-season franchises
  // whose season rows share one show folder — same key = owned).
  const conf = loadNamingConf(db);
  const namingEnabled = conf.enabled;
  const dirs: FixNameDirRow[] = [];
  let did = 0;
  const sharedNote = "Folder holds files of another franchise — fix identities first";
  if (type === "series") {
    for (const [showDir, seasons] of showSeasons) {
      const ownedShow = folderOwnedExclusively(db, showDir, request.library_key, requestImdbId(db, request));
      const showName = path.basename(showDir);
      const showCanonical = namingEnabled && cachedPieces ? canonicalSeriesDir(conf, cachedPieces) : null;
      dirs.push({
        id: `d${did++}`,
        path: showDir,
        tree: "processed",
        kind: "show",
        currentName: showName,
        proposedName: showCanonical && showCanonical !== showName && ownedShow ? showCanonical : null,
        note: !namingEnabled ? "Naming disabled in Settings" : showCanonical === showName ? null : ownedShow ? (showCanonical == null ? identityNote : null) : sharedNote,
      });
      for (const seasonDir of seasons) {
        const seasonName = path.basename(seasonDir);
        const sn = parseSeasonNumber(seasonName);
        const canonical = sn == null ? null : canonicalSeasonDir(conf, sn);
        dirs.push({
          id: `d${did++}`,
          path: seasonDir,
          tree: "processed",
          kind: "season",
          currentName: seasonName,
          proposedName: !namingEnabled || !ownedShow || !canonical || canonical === seasonName ? null : canonical,
          // "Already canonical" is tested BEFORE ownership. A folder that needs no
          // rename has nothing to refuse, so answering "holds files of another
          // franchise — fix identities first" about it invites work that cannot change
          // anything; the frontend renders a null note on an unrenamable row as
          // "Already canonical", which is the true state.
          note: !namingEnabled ? "Naming disabled in Settings" : canonical === seasonName ? null : !ownedShow ? sharedNote : sn == null ? "Could not parse season number" : null,
        });
      }
    }
    // Library: show folder + this request's season folder.
    const libShow = resolveLibraryShowFolder(request);
    if (libShow) {
      const libOwned = folderOwnedExclusively(db, libShow, request.library_key, requestImdbId(db, request));
      const libShowName = path.basename(libShow);
      const libShowCanonical = namingEnabled && cachedPieces ? canonicalSeriesDir(conf, cachedPieces) : null;
      dirs.push({
        id: `d${did++}`,
        path: libShow,
        tree: "library",
        kind: "show",
        currentName: libShowName,
        proposedName: libShowCanonical && libShowCanonical !== libShowName && libOwned ? libShowCanonical : null,
        note: !namingEnabled ? "Naming disabled in Settings" : libShowCanonical === libShowName ? null : libOwned ? (libShowCanonical == null ? identityNote : null) : sharedNote,
      });
      const wantSeason = request.season ?? (targetSeason ? parseInt(targetSeason.slice(1), 10) : 1);
      const libSeason = findExistingSeasonFolder(libShow, wantSeason) || path.join(libShow, `S${String(wantSeason).padStart(2, "0")}`);
      if (fs.existsSync(libSeason)) {
        const seasonName = path.basename(libSeason);
        const sn = parseSeasonNumber(seasonName);
        const canonical = sn == null ? null : canonicalSeasonDir(conf, sn);
        dirs.push({
          id: `d${did++}`,
          path: libSeason,
          tree: "library",
          kind: "season",
          currentName: seasonName,
          proposedName: !namingEnabled || !libOwned || !canonical || canonical === seasonName ? null : canonical,
          note: !namingEnabled ? "Naming disabled in Settings" : canonical === seasonName ? null : !libOwned ? sharedNote : sn == null ? "Could not parse season number" : null,
        });
      }
    }
  } else {
    for (const movieDir of movieDirs) {
      const name = path.basename(movieDir);
      const owned = folderOwnedExclusively(db, movieDir, request.library_key, requestImdbId(db, request));
      const canonical = namingEnabled && cachedPieces ? canonicalMovieDir(conf, cachedPieces) : null;
      dirs.push({
        id: `d${did++}`,
        path: movieDir,
        tree: "processed",
        kind: "movie",
        currentName: name,
        proposedName: canonical && canonical !== name && owned ? canonical : null,
        note: !namingEnabled ? "Naming disabled in Settings" : canonical === name ? null : owned ? (canonical == null ? identityNote : null) : sharedNote,
      });
    }
    // Library movie dir(s) — nativeMovieLibraryFolders falls back to the movie
    // root itself when nothing matches; skip proposing the root.
    for (const folder of nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)) {
      if (!folder || path.normalize(folder) === path.normalize(MEDIA_MOVIES)) continue;
      if (!fs.existsSync(folder)) continue;
      // Never even LIST a folder a sibling film owns. nativeMovieLibraryFolders
      // matches the whole franchise, so a one-word title returns every Hobbit
      // folder — and offering "Hobbit (2014)" on the 2012 card, even struck
      // through with a refusal, reads as "this card should own it". The refusal
      // note stays for a folder that really is ambiguous; a sibling's folder is
      // simply not this request's business.
      if (siblingOwningYear(db, request, folder)) continue;
      const name = path.basename(folder);
      const owned = folderOwnedExclusively(db, folder, request.library_key, requestImdbId(db, request));
      const canonical = namingEnabled && cachedPieces ? canonicalMovieDir(conf, cachedPieces) : null;
      dirs.push({
        id: `d${did++}`,
        path: folder,
        tree: "library",
        kind: "movie",
        currentName: name,
        proposedName: canonical && canonical !== name && owned ? canonical : null,
        note: !namingEnabled ? "Naming disabled in Settings" : canonical === name ? null : owned ? (canonical == null ? identityNote : null) : sharedNote,
      });
    }
  }
  return { groups, dirs };
}

/** Rename a single picked file to its canonical name. Inode-verified: a rename
 * keeps the inode, so hardlinked twins elsewhere stay linked and identity rows
 * survive. Only the submitted path is renamed (twins rename independently). */
/** Temporary name a file is parked under while a Fix Names batch runs. It lives in
 *  the file's OWN directory — a rename has to stay on one filesystem — and starts
 *  with a dot so a media scanner ignores it. The inode is in the name so a leftover
 *  from a crash is traceable back to its identity row. */
function fixNameTempPath(p: string, st: fs.Stats): string {
  return path.join(path.dirname(p), `.fixnames-tmp-${st.dev}-${st.ino}${path.extname(p)}`);
}
const FIXNAME_TEMP_RE = /^\.fixnames-tmp-\d+-\d+/;

/** Where one rename should land, decided WITHOUT touching disk. Split from the commit
 *  so a batch can park every file under a temp name first: a season-wide renumber is
 *  a PERMUTATION inside a single folder — every file's canonical name is still held by
 *  the file that moves next (DuckTales S01E52 -> S01E53 while "S01E53 - Jungle Duck"
 *  is still on disk) — so renaming in place collides on every row but the last, and
 *  uniqueDestPath answers a collision with a "-2" suffix rather than an error.
 *  Submission order cannot save it either: a cycle of renames has no free name to move
 *  into, so only parking every file first is order-independent. */
function planFixNameDest(oldPath: string, newNameArg: string, ino: number): { newName: string; dest: string } {
  // Proposals arrive without an extension (the canonical base name); re-attach the
  // original one so a rename never strips ".mkv". endsWith — never extname: channel
  // layouts like "2.0" inside the name would fool it.
  const ext = path.extname(oldPath);
  const newName = ext && !newNameArg.endsWith(ext) ? `${newNameArg}${ext}` : newNameArg;
  return { newName, dest: uniqueDestPath(path.join(path.dirname(oldPath), newName), ino) };
}

/** A rename whose destination is already this very file — an idempotent re-apply. */
function fixNameAlreadyLanded(dest: string, oldPath: string, st: fs.Stats): boolean {
  if (dest === oldPath) return true;
  try {
    return fs.statSync(dest).ino === st.ino;
  } catch {
    return false;
  }
}

/** One inode-verified rename. A rename that somehow lands on a different inode is
 *  reported as a failure rather than accepted. */
function landFixNameRename(fromPath: string, toPath: string, st: fs.Stats): { ok: boolean; error?: string } {
  try {
    fs.renameSync(fromPath, toPath);
    if (fs.statSync(toPath).ino !== st.ino) return { ok: false, error: "Rename changed the inode — aborting" };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Bookkeeping for a landed rename. Identity rows are keyed by (dev, inode); refresh
 *  the stored release_name. The column is `inode` (not Node's `st.ino` property) — a
 *  bare catch here once swallowed "no such column: ino", so every rename reported
 *  success while the UPDATE never ran and storedNameMatchesRow's self-heal silently
 *  stopped working. */
function recordFixNameRename(db: Database, request: any, oldBasename: string, dest: string, st: fs.Stats): void {
  try {
    db.prepare("UPDATE media_files SET release_name = ? WHERE dev = ? AND inode = ?").run(path.basename(dest), st.dev, st.ino);
  } catch (e) {
    console.error(`[FixNames] release_name refresh FAILED for ${dest} (dev=${st.dev} ino=${st.ino}):`, e);
  }
  // Refresh approval_history.processed_files entries (PROCESSED-relative).
  try {
    const rows = db.prepare(
      "SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
    ).all(request.id) as any[];
    const newBase = path.basename(dest);
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.processed_files) as string[];
        let changed = false;
        const next = arr.map((f: string) => {
          if (f === oldBasename || f.endsWith(`/${oldBasename}`)) { changed = true; return f.replace(/[^/]+$/, newBase); }
          return f;
        });
        if (changed) db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(next), r.id);
      } catch {}
    }
  } catch {}
}

type FixNameResult = { ok: boolean; skipped?: boolean; error?: string; old?: string; new?: string };

function applyFixNameRename(db: Database, request: any, oldPath: string, newNameArg: string): FixNameResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(oldPath);
  } catch {
    return { ok: false, error: "File not found" };
  }
  if (!st.isFile()) return { ok: false, error: "Not a file" };
  if (!isFixNameTarget(oldPath)) return { ok: false, error: "Path is outside the managed trees" };

  const oldBasename = path.basename(oldPath);
  const { newName, dest } = planFixNameDest(oldPath, newNameArg, st.ino);
  if (fixNameAlreadyLanded(dest, oldPath, st)) return { ok: true, skipped: true, old: oldBasename, new: newName };

  const landed = landFixNameRename(oldPath, dest, st);
  if (!landed.ok) return { ok: false, error: landed.error, old: oldBasename, new: newName };
  recordFixNameRename(db, request, oldBasename, dest, st);
  console.log(`[FixNames] renamed ${oldPath} -> ${dest}`);
  return { ok: true, old: oldBasename, new: path.basename(dest) };
}

/** Every directory a Fix Names batch must be able to write in that it cannot, with the
 *  owning uid when it differs from ours. A rename needs write permission on the DIRECTORY,
 *  not on the file — so a root-owned season folder full of app-owned files rejects every
 *  rename with a bare EACCES while `ls -l` says the files are perfectly writable, and the
 *  batch dies looking like a no-op. */
function unwritableFixNameDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) dirs.add(path.dirname(p));
  const selfUid = typeof process.getuid === "function" ? process.getuid() : null;
  const bad: string[] = [];
  for (const d of [...dirs].sort()) {
    try {
      fs.accessSync(d, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      let owner = "";
      try {
        const st = fs.statSync(d);
        if (typeof st.uid === "number" && selfUid != null && st.uid !== selfUid) owner = ` (owned by uid ${st.uid}, app runs as uid ${selfUid})`;
      } catch {}
      bad.push(`${d}${owner}`);
    }
  }
  return bad;
}

type StagedFixName = { origPath: string; origBase: string; stagedPath: string; newName: string; st: fs.Stats };

/** Park one file under its temp name so the rest of the batch cannot be blocked by
 *  the name it currently holds. Returns null when the file needs no move (already
 *  canonical) or could not be parked; either way `results` has the outcome. */
function stageFixName(p: string, st: fs.Stats, newName: string, results: any[]): StagedFixName | null {
  const origBase = path.basename(p);
  const { dest } = planFixNameDest(p, newName, st.ino);
  if (fixNameAlreadyLanded(dest, p, st)) {
    results.push({ path: p, ok: true, skipped: true, old: origBase, new: path.basename(dest) });
    return null;
  }
  const stagedPath = fixNameTempPath(p, st);
  const parked = landFixNameRename(p, stagedPath, st);
  if (!parked.ok) {
    results.push({ path: p, ok: false, error: parked.error, old: origBase, new: path.basename(newName) });
    return null;
  }
  return { origPath: p, origBase, stagedPath, newName, st };
}

/** True when `p` sits directly under managed root `root` (top-level role dir). */
function isDirectChildOfRoot(p: string, root: string): boolean {
  return path.dirname(path.normalize(p)) === path.normalize(root);
}

/** Folder ownership gate: block renames of folders that contain files of a
 *  DIFFERENT franchise. Files with no registered identity are treated as owned —
 *  EXCEPT when their own NAME pins a different IMDb id, because a canonical name
 *  states the film's identity outright. This is what makes multi-season
 *  franchises safe: every season row of the same show shares the show folder
 *  (same library_key) and stays non-blocking. */
function folderOwnedExclusively(db: Database, folder: string, libraryKey: string | null, ownImdbId?: string | null): boolean {
  if (!libraryKey) return false;
  const videoFiles: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (VIDEO_FILE_RE.test(e.name)) videoFiles.push(p);
    }
  };
  walk(folder, 0);
  // The folder's own name is the strongest statement of what it holds. A file
  // inside `Hobbit (2014)/` whose media_files row still points at the 2012 key is
  // a stale row from before the franchise was split, not a squatter: the folder
  // says 2014, so trust the folder and re-register rather than refusing to let
  // the rightful card own it.
  const folderYear = nameYear(path.basename(folder));
  const myYear = requestYear({ title: "", library_key: libraryKey });
  // A file that names OUR id is proof of ownership, and it is exactly as
  // refutable as the folder's year is trustworthy - in the other direction. The
  // folder can be mis-titled ("Akademia pana Kleksa (2023)" holding the 2024
  // film), but a canonical name this app minted cannot name the wrong film, so
  // when the two disagree the id wins. Remembered across the walk and applied
  // to any disagreeing row below, which is what lets a mis-titled folder be
  // repaired instead of blocking the card that owns its contents forever.
  let namedOwnId = false;
  for (const f of videoFiles) {
    // An id written INTO a file is a deliberate statement of what it is, and it
    // outranks the folder's year: a folder can be mis-filed, a name minted by this
    // app cannot name the wrong film. Checked before the year-trust below, which
    // otherwise re-registers an id-bearing file into the folder's year.
    //
    // Role-scoped, though: an unnumbered SPECIAL is expected to carry another
    // film's id (a show's S00 holds films and crossovers), so holding this veto
    // for one bonus feature refused the entire show folder - and since a season
    // row inherits the show folder's verdict, it blocked every Season N rename
    // too. A numbered episode still refuses it, so a foreign show's episodes
    // cannot ride in. `libraryKey` carries the type, so no signature change.
    const named = nameImdbId(path.basename(f));
    const isSeries = libraryKey.startsWith("series:");
    if (ownImdbId && named && named !== ownImdbId && embeddedIdContradicts(isSeries, path.basename(f))) return false;
    if (ownImdbId && named === ownIMDbLower(ownImdbId)) namedOwnId = true;
    try {
      const ident = identifyByPath(db, f);
      if (ident && ident.library_key && ident.library_key !== libraryKey) {
        if (namedOwnId) {
          // This file states it is ours, so the row pointing elsewhere is stale.
          registerVideoTree(db, f, { library_key: libraryKey, title: "", season: 0 });
          continue;
        }
        if (folderYear && myYear === folderYear) {
          // This folder IS the year the registered key's owner does not claim, so
          // the row is wrong. Re-point it at us and keep going.
          registerVideoTree(db, f, { library_key: libraryKey, title: "", season: 0 });
          continue;
        }
        return false;
      }
    } catch {}
  }
  return true;
}

/** nameImdbId lower-cases its result, so compare in the same alphabet. */
function ownIMDbLower(id: string): string {
  return id.toLowerCase();
}

/** Rewrite the directory prefix of every AH processed_files entry across ALL
 * requests (not just this one) — a show-folder rename also relocates sibling
 * seasons' records. Self-heal would recover anyway; this keeps it eager. */
function rewriteProcessedFilesPrefix(db: Database, prefix: string, replacement: string) {
  const rows = db.prepare(
    "SELECT id, processed_files FROM approval_history WHERE processed_files IS NOT NULL AND processed_files != '[]'"
  ).all() as any[];
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.processed_files) as string[];
      let changed = false;
      const next = arr.map((f: string) => {
        if (f.startsWith(prefix)) { changed = true; return replacement + f.slice(prefix.length); }
        return f;
      });
      if (changed) db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(next), r.id);
    } catch {}
  }
}

/** Directory hint for a submitted fix-name path. Loose files under a movie root
 * folder that turn out not to be directories get caught by `stat` upstream. */
function dirKindForPath(p: string): "show" | "season" | "movie" {
  const pn = path.normalize(p);
  const dirP = path.dirname(pn);
  const dirG = path.dirname(dirP);
  const isTvRoot = (r: string) => dirP === path.normalize(r);
  const isTvChild = (r: string) => dirG === path.normalize(r);
  const isMovieRoot = (r: string) => dirP === path.normalize(r);
  if (isTvRoot(PROCESSED_TV) || isTvRoot(MEDIA_TV)) return "show";
  if (isTvChild(PROCESSED_TV) || isTvChild(MEDIA_TV)) return "season";
  if (isMovieRoot(PROCESSED_MOVIES) || isMovieRoot(MEDIA_MOVIES)) return "movie";
  return "movie";
}

/** Rename an owned processed/library folder to its canonical name. Safety: only
 * top-level (show/movie) or show-child (season) folders under the four managed
 * trees, only when the request exclusively owns the whole tree, canonical name
 * is recomputed server-side, destination collisions abort (never silently
 * merge), and AH processed_files prefixes are rewritten for every request under
 * a processed folder (library paths have no bookkeeping — Jellyfin rescans). */
async function applyDirRename(
  db: Database,
  request: any,
  oldDir: string,
  kind: "show" | "season" | "movie",
): Promise<{ ok: boolean; skipped?: boolean; error?: string; old?: string; new?: string; kind: string }> {
  let st: fs.Stats;
  try {
    st = fs.statSync(oldDir);
  } catch {
    return { ok: false, error: "Folder not found", kind };
  }
  if (!st.isDirectory()) return { ok: false, error: "Not a directory", kind };
  const conf = loadNamingConf(db);
  if (!conf.enabled) return { ok: false, error: "Naming disabled in Settings", kind };

  const parent = path.dirname(oldDir);
  let inLibrary: boolean;
  let canonical: string | null = null;
  if (kind === "season") {
    // Must sit directly under a show folder that is itself under PROCESSED_TV or MEDIA_TV.
    inLibrary = isDirectChildOfRoot(parent, MEDIA_TV);
    if (!inLibrary && !isDirectChildOfRoot(parent, PROCESSED_TV)) {
      return { ok: false, error: "Season folder is not directly under a processed/library show folder", kind };
    }
    const sn = parseSeasonNumber(path.basename(oldDir));
    canonical = sn == null ? null : canonicalSeasonDir(conf, sn);
  } else {
    const rootOk = kind === "show"
      ? isDirectChildOfRoot(oldDir, PROCESSED_TV) || isDirectChildOfRoot(oldDir, MEDIA_TV)
      : isDirectChildOfRoot(oldDir, PROCESSED_MOVIES) || isDirectChildOfRoot(oldDir, MEDIA_MOVIES);
    if (!rootOk) return { ok: false, error: "Folder is not at the top of a managed tree", kind };
    inLibrary = kind === "show" ? isDirectChildOfRoot(oldDir, MEDIA_TV) : isDirectChildOfRoot(oldDir, MEDIA_MOVIES);
    // Same resolution the preview used: the show folder (or, for a season dir,
    // its parent) is the on-disk identity hint, and the season cache is warmed so
    // episode titles and the show id agree with what the modal displayed.
    const { pieces, reason } = await fixNamesPieces(db, request, [kind === "show" ? oldDir : parent]);
    if (!pieces) return { ok: false, error: `Could not resolve identity — ${reason || "no IMDb/TVDB id found"}`, kind };
    canonical = kind === "show" ? canonicalSeriesDir(conf, pieces) : canonicalMovieDir(conf, pieces);
  }
  if (!canonical) return { ok: false, error: "Could not resolve canonical folder name", kind };

  const oldName = path.basename(oldDir);
  if (canonical === oldName) return { ok: true, skipped: true, old: oldName, new: canonical, kind };
  if (!folderOwnedExclusively(db, oldDir, request.library_key, requestImdbId(db, request))) {
    return { ok: false, error: "Folder contains files of another franchise — fix identities first", kind };
  }

  const dest = path.join(parent, canonical);
  if (fs.existsSync(dest)) {
    try {
      if (fs.statSync(dest).ino === st.ino) return { ok: true, skipped: true, old: oldName, new: canonical, kind };
    } catch {}
    return { ok: false, error: `Destination already exists: ${canonical}`, kind };
  }
  try {
    fs.renameSync(oldDir, dest);
  } catch (e: any) {
    return { ok: false, error: e.message, kind };
  }
  try {
    if (!fs.statSync(dest).isDirectory()) return { ok: false, error: "Rename produced a non-directory — aborting", kind };
  } catch {
    return { ok: false, error: "Rename verification failed", kind };
  }

  if (!inLibrary) {
    const oldPrefix = kind === "show" ? `${oldName}/` : `${path.basename(parent)}/${oldName}/`;
    const newPrefix = kind === "show" ? `${canonical}/` : `${path.basename(parent)}/${canonical}/`;
    rewriteProcessedFilesPrefix(db, oldPrefix, newPrefix);
  }
  console.log(`[FixNames] renamed dir ${oldDir} -> ${dest}`);
  return { ok: true, old: oldName, new: canonical, kind };
}

/** Roman numeral -> number, canonical spellings only (1-10). A bare "v" is 5, so
 *  non-canonical forms like "IIX" fail the round-trip and read as no numeral. */
const ROMAN_SEQUELS: Record<number, string> = { 1: "i", 2: "ii", 3: "iii", 4: "iv", 5: "v", 6: "vi", 7: "vii", 8: "viii", 9: "ix", 10: "x" };
function romanValue(tok: string): number | null {
  const t = tok.toLowerCase();
  const VALS = [1, 5, 10, 50, 100, 500, 1000];
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = "ivxlcdm".indexOf(t[i]);
    if (v < 0) return null;
    const nxt = i + 1 < t.length ? "ivxlcdm".indexOf(t[i + 1]) : -1;
    total += nxt >= 0 && VALS[nxt] > VALS[v] ? -VALS[v] : VALS[v];
  }
  return ROMAN_SEQUELS[total] === t ? total : null;
}

/** The sequel numeral a normalized title ENDS with, as a number: 2 for "moana 2",
 *  3 for "the neverending story iii". Null when it carries none. */
function trailingSequelNumber(norm: string): number | null {
  const m = norm.match(/(?:^|[\s._-])(?:part|chapter|vol|volume)?[\s._-]*([ivxlcdm]{1,7}|\d{1,3})[\s._-]*$/i);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : romanValue(m[1]);
}

/** A title extended by a sequel numeral: "moana" -> "moana 2", "story ii" ->
 *  "story iii". Roman numerals belong here, not just digits: The NeverEnding
 *  Story II and III share every other word, and NES III's freshly-canonical name
 *  ("The NeverEnding Story III (1994) [imdbid-tt0110647] - ...") is a PREFIX of
 *  the NES II request's title, so the digit-only guard waved it straight through
 *  and NES II's Fix Names proposed renaming NES III's file and folder. */
const SEQUEL_EXTENSION = /^(?:\d{1,3}|[ivxlcdm]{1,7})\b/i;

export function titlesMatch(lookupNorm: string, torrentNorm: string): boolean {
  // A numeral both sides carry is part of the title's identity, never noise.
  const lookupSeq = trailingSequelNumber(lookupNorm);
  const torrentSeq = trailingSequelNumber(torrentNorm);
  if (lookupSeq != null && torrentSeq != null && lookupSeq !== torrentSeq) return false;
  // Primary: prefix match. A sequel numeral means a DIFFERENT film, so the
  // rejection is FINAL here: falling through to word overlap re-admitted the
  // exact case this guards, since "the neverending story ii" shares two of its
  // three words with NES III and three-word titles carry a one-word tolerance.
  if (torrentNorm.startsWith(lookupNorm)) {
    const suffix = torrentNorm.slice(lookupNorm.length).trimStart();
    if (suffix && SEQUEL_EXTENSION.test(suffix)) return false;
    return true;
  }
  if (lookupNorm.startsWith(torrentNorm)) {
    const suffix = lookupNorm.slice(torrentNorm.length).trimStart();
    if (suffix && SEQUEL_EXTENSION.test(suffix)) return false;
    return true;
  }
  // Secondary: lookup title appears in torrent, but must be >= 10 chars to avoid false positives
  // like "Dragons" matching "Ninjago Dragons Rising"
  if (lookupNorm.length >= 10 && torrentNorm.includes(lookupNorm)) return true;
  if (torrentNorm.length >= 10 && lookupNorm.includes(torrentNorm)) return true;

  const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "is", "it", "its"]);

  const shorter = lookupNorm.length <= torrentNorm.length ? lookupNorm : torrentNorm;
  const longer = lookupNorm.length > torrentNorm.length ? lookupNorm : torrentNorm;
  const shorterWords = shorter.split(/\s+/).filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w));
  const longerSet = new Set(longer.split(/\s+/));
  if (shorterWords.length >= 2) {
    const matched = shorterWords.filter((w: string) => longerSet.has(w));
    // Allow 1 missing word for 3+ word titles (handles "LEGO" prefix differences, episode titles appended, etc.)
    const tolerance = shorterWords.length >= 3 ? 1 : 0;
    if (matched.length >= shorterWords.length - tolerance) return true;
  }

  return false;
}

function mapProwlarrToRadarrResult(r: ProwlarrRelease): RadarrSearchResult {
  const guid = r.infoHash || r.guid || r.downloadUrl || `prowlarr-${r.indexerId}-${r.title}`;
  const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
  const isTorrent = r.protocol === "torrent" || !!r.magnetUri || !!r.infoHash;
  const infoOrMagnet = r.magnetUri || r.infoUrl || "";

  const titleLower = (r.title || r.fileName || "").toLowerCase();
  let source = "";
  let resolution = "";

  if (titleLower.includes("dvdremux") || titleLower.includes("dvd remux")) source = "Remux";
  else if (titleLower.includes("remux")) source = "Remux";
  else if (titleLower.includes("web-dl") || titleLower.includes("webdl")) source = "WEBDL";
  else if (titleLower.includes("webrip") || titleLower.includes("web-rip")) source = "WEBRip";
  else if (titleLower.includes("bluray") || titleLower.includes("bdrip") || titleLower.includes("blu-ray")) source = "Bluray";
  else if (titleLower.includes("hdtv")) source = "HDTV";
  else if (titleLower.includes("hdrip") || titleLower.includes("hd-rip")) source = "HDTV";
  else if (titleLower.includes("dvdrip") || titleLower.includes("dvd-rip") || titleLower.includes("dvdr")) source = "DVD";
  else if (titleLower.includes("tvrip") || titleLower.includes("tv-rip") || titleLower.includes("tv rip")) source = "HDTV";
  else if (titleLower.includes("vhsrip") || titleLower.includes("vhs-rip")) source = "VHS";
  else if (titleLower.includes("cam") || titleLower.includes("telesync") || titleLower.includes("telecine") || titleLower.includes("ts ")) source = "CAM";
  else if (titleLower.includes("scr") || titleLower.includes("screener")) source = "SCR";
  else if (titleLower.includes("tc ")) source = "TELECINE";
  else if (titleLower.includes("pal") || titleLower.includes("ntsc")) source = "DVD";
  else source = "Bluray";

  if (titleLower.includes("2160p") || titleLower.includes("4k") || titleLower.includes("uhd")) resolution = "2160p";
  else if (titleLower.includes("1080p")) resolution = "1080p";
  else if (titleLower.includes("720p")) resolution = "720p";
  else if (titleLower.includes("480p")) resolution = "480p";
  else resolution = "1080p";

  let qualityName: string;
  if (source === "Remux") qualityName = titleLower.includes("480p") ? "Remux-480p" : `Remux-${resolution}`;
  else if (source === "VHS") qualityName = "VHS";
  else if (source === "CAM" || source === "SCR" || source === "TELECINE") qualityName = source;
  else if (source === "DVD") qualityName = "DVD";
  else qualityName = `${source}-${resolution}`;

  return {
    guid,
    title: r.title || r.fileName || "",
    quality: { quality: { name: qualityName, resolution: 0, source: "", modifier: "" } },
    customFormats: [],
    customFormatScore: 0,
    indexer: r.indexer || "",
    indexerId: r.indexerId,
    size: r.size || 0,
    protocol: isTorrent ? "torrent" : "usenet",
    seeders: r.seeders,
    leechers: r.leechers,
    infoUrl: infoOrMagnet,
    magnetUrl: r.magnetUri || "",
    infoHash: r.infoHash || "",
    publishDate: r.publishDate || "",
  };
}

function parseReleases(rows: any[]) {
  return rows.map((r: any) => {
    const cf = JSON.parse(r.radarr_custom_formats || "[]");
    return {
      ...r,
      radarr_custom_formats: cf,
      positive_attrs: JSON.parse(r.positive_attrs || "[]"),
      negative_attrs: JSON.parse(r.negative_attrs || "[]"),
      app_score: r.user_score != null ? r.user_score : computeAppScore(r.radarr_quality, cf, r.size_mb, r.radarr_rank),
    };
  });
}

function hardlinkDirRecursive(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      hardlinkDirRecursive(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) {
        try {
          fs.linkSync(srcPath, destPath);
        } catch (err: any) {
          if (err.code === "EXDEV") {
            // Cross-device link: fall back to copy
            fs.copyFileSync(srcPath, destPath);
          } else {
            throw err;
          }
        }
      }
    }
  }
}

function getContentVideoInodes(contentPath: string): { inodes: Set<number>; names: Set<string>; sizes: Set<number> } {
  const inodes = new Set<number>();
  const names = new Set<string>();
  const sizes = new Set<number>();
  if (!fs.existsSync(contentPath)) return { inodes, names, sizes };
  const stat = fs.statSync(contentPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(contentPath)) {
      if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
      const fullPath = path.join(contentPath, entry);
      try {
        const st = fs.statSync(fullPath);
        inodes.add(st.ino);
        names.add(entry);
        if (st.size > 0) sizes.add(st.size);
      } catch {}
    }
  } else {
    inodes.add(stat.ino);
    names.add(path.basename(contentPath));
    if (stat.size > 0) sizes.add(stat.size);
  }
  return { inodes, names, sizes };
}

export function createRequestRoutes(db: Database, radarr: RadarrService, sonarr: SonarrService, qbittorrent: QBittorrentService, prowlarr: ProwlarrService, deletedFranchiseIds?: Set<number>) {
  const router = Router();

  // GET /api/requests - List all pending requests
  router.get("/", (req: Request, res: Response) => {
    try {
      const stmt = db.prepare(`
        SELECT mr.*,
          (SELECT COUNT(*) FROM release_candidates rc 
           JOIN approval_history ah ON ah.release_id = rc.id
           WHERE ah.request_id = mr.id AND rc.torrent_hash != '') as release_count,
          (SELECT COALESCE(SUM(json_array_length(ah.processed_files)), 0) FROM approval_history ah
           WHERE ah.request_id = mr.id AND ah.release_id IS NULL
           AND ah.processed_files IS NOT NULL AND ah.processed_files != '[]') as processed_count
        FROM media_requests mr
        WHERE mr.status NOT IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')
        AND NOT (mr.type = 'series' AND mr.sonarr_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM release_candidates rc 
          JOIN approval_history ah ON ah.release_id = rc.id
          WHERE ah.request_id = mr.id AND rc.torrent_hash != ''
        )
        AND NOT EXISTS (
          SELECT 1 FROM approval_history ah
          WHERE ah.request_id = mr.id AND ah.release_id IS NULL
          AND ah.processed_files IS NOT NULL AND ah.processed_files != '[]'
        )
        AND NOT (
          mr.type = 'series' AND mr.library_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM media_requests sib
            WHERE sib.type = 'series' AND sib.library_key = mr.library_key
            AND (
              sib.status IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')
              OR EXISTS (
                SELECT 1 FROM release_candidates rc6 JOIN approval_history ah6 ON ah6.release_id = rc6.id
                WHERE ah6.request_id = sib.id AND rc6.torrent_hash != ''
              )
              OR EXISTS (
                SELECT 1 FROM approval_history ah7
                WHERE ah7.request_id = sib.id AND ah7.release_id IS NULL
                AND ah7.processed_files IS NOT NULL AND ah7.processed_files != '[]'
              )
            )
          )
        )
        ORDER BY mr.created_at DESC
      `);
      const rows = stmt.all();
      
      const parsedRows = rows.map((row: any) => {
        const approvedRows = db.prepare(
          "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.radarr_quality, rc.size_mb " +
          "FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(row.id) as any[];
        const hasTorrent = approvedRows.some((r: any) => r.torrent_hash);

        const releaseStats = db.prepare(
          "SELECT COUNT(*) as count, COALESCE(SUM(size_mb), 0) as total_size_mb FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(row.id) as any;

        return {
          ...row,
          requested_by: JSON.parse(row.requested_by || "[]"),
          approved_release: approvedRows[0] || null,
          has_torrent: hasTorrent,
          release_count: releaseStats?.count || 0,
          total_size_mb: releaseStats?.total_size_mb || 0,
          candidate_count: (db.prepare("SELECT COUNT(*) as c FROM release_candidates WHERE request_id = ?").get(row.id) as any)?.c || 0,
        };
      });
      
      res.json(parsedRows);
    } catch (error) {
      console.error("Error fetching requests:", error);
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  });

  // POST /api/requests/cleanup - Reset stale SEARCHING requests, clean up orphaned RCs, remove empty dirs
  router.post("/cleanup", (req: Request, res: Response) => {
    try {
      const stuck = db.prepare(
        `UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'SEARCHING'`
      ).run();
      const orphaned = db.prepare(
        `DELETE FROM release_candidates WHERE request_id NOT IN (SELECT id FROM media_requests)`
      ).run();
      // Remove empty dirs in processed/serialy and processed/filmy
      let emptyDirsRemoved = 0;
      const processedTvDir = PROCESSED_TV;
      const processedMovieDir = PROCESSED_MOVIES;
      for (const dir of [processedTvDir, processedMovieDir]) {
        try {
          if (!fs.existsSync(dir)) continue;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const subDir = path.join(dir, entry.name);
            try {
              if (entry.name.match(/^S0*[1-9]\d*$/i)) {
                const hasFiles = fs.readdirSync(subDir).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
                if (!hasFiles) { fs.rmSync(subDir, { recursive: true, force: true }); emptyDirsRemoved++; }
              } else {
                const hasVideoFiles = (() => {
                  for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
                    if (sub.isDirectory()) {
                      const ssub = path.join(subDir, sub.name);
                      try { if (fs.readdirSync(ssub).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f))) return true; } catch {}
                    } else if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(sub.name)) return true;
                  }
                  return false;
                })();
                if (!hasVideoFiles) { fs.rmSync(subDir, { recursive: true, force: true }); emptyDirsRemoved++; }
              }
            } catch {}
          }
        } catch {}
      }
      res.json({ reset: stuck.changes, orphanedRcs: orphaned.changes, emptyDirsRemoved });
    } catch (error) {
      console.error("Error cleaning up:", error);
      res.status(500).json({ error: "Failed to cleanup" });
    }
  });

  // POST /api/requests/cleanup-duplicates - Remove duplicate media_requests by title, keep best one
  router.post("/cleanup-duplicates", async (req: Request, res: Response) => {
    try {
      const dryRun = !!req.body?.dryRun;
      const results: Array<{ title: string; kept: number; deleted: number; movedRcs: number; sonarrDeleted: number[]; radarrDeleted: number[] }> = [];

      // Find duplicates by normalized title + type
      const dupes = db.prepare(`
        SELECT title, type, COUNT(*) as cnt
        FROM media_requests
        GROUP BY LOWER(title), type
        HAVING cnt > 1
      `).all() as any[];

      const sonarrIdsToDelete: number[] = [];
      const radarrIdsToDelete: number[] = [];

      for (const dupe of dupes) {
        const rows = db.prepare(`
          SELECT mr.*,
            (SELECT COUNT(*) FROM release_candidates rc WHERE rc.request_id = mr.id) as rc_count
          FROM media_requests mr
          WHERE LOWER(mr.title) = LOWER(?) AND mr.type = ?
          ORDER BY mr.id ASC
        `).all(dupe.title, dupe.type) as any[];

        // Keep the one with most RCs, or earliest ID
        const keep = rows.reduce((best: any, cur: any) => {
          if (cur.rc_count > best.rc_count) return cur;
          if (cur.rc_count === best.rc_count && cur.id < best.id) return cur;
          return best;
        }, rows[0]);

        const deleteRows = rows.filter((r: any) => r.id !== keep.id);
        let movedRcs = 0;

        if (!dryRun) {
          for (const del of deleteRows) {
            // Move RCs from deleted request to kept request, skip conflicts
            const orphanRcs = db.prepare("SELECT * FROM release_candidates WHERE request_id = ?").all(del.id) as any[];
            for (const rc of orphanRcs) {
              const conflict = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND radarr_release_id = ?").get(keep.id, rc.radarr_release_id);
              if (conflict) {
                // Duplicate RC — delete instead of move
                db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.id);
                db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.id);
              } else {
                db.prepare("UPDATE release_candidates SET request_id = ? WHERE id = ?").run(keep.id, rc.id);
                movedRcs++;
              }
            }
            db.prepare("DELETE FROM media_requests WHERE id = ?").run(del.id);
            if (del.sonarr_id) sonarrIdsToDelete.push(del.sonarr_id);
            if (del.radarr_id) radarrIdsToDelete.push(del.radarr_id);
          }
        } else {
          movedRcs = deleteRows.reduce((sum: number, del: any) => {
            return sum + (db.prepare("SELECT COUNT(*) as c FROM release_candidates WHERE request_id = ?").get(del.id) as any).c;
          }, 0);
          for (const del of deleteRows) {
            if (del.sonarr_id) sonarrIdsToDelete.push(del.sonarr_id);
            if (del.radarr_id) radarrIdsToDelete.push(del.radarr_id);
          }
        }

        results.push({
          title: dupe.title,
          kept: keep.id,
          deleted: deleteRows.length,
          movedRcs,
          sonarrDeleted: deleteRows.map((d: any) => d.sonarr_id).filter(Boolean),
          radarrDeleted: deleteRows.map((d: any) => d.radarr_id).filter(Boolean),
        });
      }

      // Delete duplicate Sonarr/Radarr entries
      let arrDeleteFailures = 0;
      if (!dryRun) {
        const sUrl = process.env.SONARR_URL || "";
        const sKey = process.env.SONARR_API_KEY || "";
        const rUrl = process.env.RADARR_URL || "";
        const rKey = process.env.RADARR_API_KEY || "";
        for (const sid of [...new Set(sonarrIdsToDelete)]) {
          if (!sUrl || !sKey) { arrDeleteFailures++; continue; }
          try {
            const r = await fetch(`${sUrl}/api/v3/series/${sid}?deleteFiles=false`, {
              method: "DELETE",
              headers: { "X-Api-Key": sKey },
            });
            if (!r.ok) {
              console.warn(`[Cleanup] Sonarr DELETE series ${sid} failed: HTTP ${r.status}`);
              arrDeleteFailures++;
            }
          } catch (e: any) {
            console.warn(`[Cleanup] Sonarr DELETE series ${sid} failed: ${e.message}`);
            arrDeleteFailures++;
          }
        }
        for (const rid of [...new Set(radarrIdsToDelete)]) {
          if (!rUrl || !rKey) { arrDeleteFailures++; continue; }
          try {
            const r = await fetch(`${rUrl}/api/v3/movie/${rid}?deleteFiles=false&addImportListExclusion=true`, {
              method: "DELETE",
              headers: { "X-Api-Key": rKey },
            });
            if (!r.ok) {
              console.warn(`[Cleanup] Radarr DELETE movie ${rid} failed: HTTP ${r.status}`);
              arrDeleteFailures++;
            }
          } catch (e: any) {
            console.warn(`[Cleanup] Radarr DELETE movie ${rid} failed: ${e.message}`);
            arrDeleteFailures++;
          }
        }
      }

      // Cleanup orphaned RCs
      if (!dryRun) {
        const orphaned = db.prepare(`
          SELECT rc.id FROM release_candidates rc
          LEFT JOIN media_requests mr ON mr.id = rc.request_id
          WHERE mr.id IS NULL
        `).all() as any[];
        if (orphaned.length > 0) {
          db.prepare(`DELETE FROM release_candidates WHERE id IN (${orphaned.map((r: any) => r.id).join(",")})`).run();
        }
      }

      const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
      console.log(`[Cleanup] ${dryRun ? "DRY RUN: " : ""}Removed ${totalDeleted} duplicate request(s), moved RCs, deleted ${sonarrIdsToDelete.length} Sonarr + ${radarrIdsToDelete.length} Radarr entries`);

      res.json({ success: true, dryRun, duplicates: results.length, results, arrDeleteFailures });
    } catch (error: any) {
      console.error("Error cleaning up duplicates:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/remove-titles - Remove specific entries by title (wrong matches from scan-downloads)
  router.post("/remove-titles", async (req: Request, res: Response) => {
    try {
      const titles: string[] = req.body?.titles || [];
      if (!titles.length) return res.status(400).json({ error: "No titles provided" });

      const removed: Array<{ title: string; id: number; sonarr_id?: number; radarr_id?: number }> = [];
      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";
      const rUrl = process.env.RADARR_URL || "";
      const rKey = process.env.RADARR_API_KEY || "";

      for (const title of titles) {
        const rows = db.prepare("SELECT * FROM media_requests WHERE LOWER(title) = LOWER(?)").all(title) as any[];
        for (const row of rows) {
          db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(row.id);
          db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(row.id);
          db.prepare("DELETE FROM media_requests WHERE id = ?").run(row.id);

          if (row.sonarr_id && sUrl && sKey) {
            try {
              const r = await fetch(`${sUrl}/api/v3/series/${row.sonarr_id}?deleteFiles=false`, {
                method: "DELETE",
                headers: { "X-Api-Key": sKey },
              });
              if (!r.ok) console.warn(`[RemoveTitles] Sonarr DELETE series ${row.sonarr_id} failed: HTTP ${r.status}`);
            } catch (e: any) {
              console.warn(`[RemoveTitles] Sonarr DELETE series ${row.sonarr_id} failed: ${e.message}`);
            }
          }
          if (row.radarr_id && rUrl && rKey) {
            try {
              const r = await fetch(`${rUrl}/api/v3/movie/${row.radarr_id}?deleteFiles=false`, {
                method: "DELETE",
                headers: { "X-Api-Key": rKey },
              });
              if (!r.ok) console.warn(`[RemoveTitles] Radarr DELETE movie ${row.radarr_id} failed: HTTP ${r.status}`);
            } catch (e: any) {
              console.warn(`[RemoveTitles] Radarr DELETE movie ${row.radarr_id} failed: ${e.message}`);
            }
          }

          removed.push({ title: row.title, id: row.id, sonarr_id: row.sonarr_id, radarr_id: row.radarr_id });
          console.log(`[RemoveTitles] Removed: ${row.title} (id=${row.id}, sonarr=${row.sonarr_id}, radarr=${row.radarr_id})`);
        }
      }

      // Cleanup orphaned RCs
      const orphaned = db.prepare(`
        SELECT rc.id FROM release_candidates rc
        LEFT JOIN media_requests mr ON mr.id = rc.request_id
        WHERE mr.id IS NULL
      `).all() as any[];
      if (orphaned.length > 0) {
        db.prepare(`DELETE FROM release_candidates WHERE id IN (${orphaned.map((r: any) => r.id).join(",")})`).run();
      }

      res.json({ success: true, removed: removed.length, results: removed });
    } catch (error: any) {
      console.error("Error removing titles:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/import-missing - Import movies/series from Radarr/Sonarr that have no request in DB
  router.post("/import-missing", async (req: Request, res: Response) => {
    try {
      const imported: Array<{ title: string; id: number }> = [];
      const skipped: Array<{ title: string; radarr_id?: number; sonarr_id?: number; reason: string }> = [];
      let fixed = 0;

      // Import movies from Radarr
      const radarrMovies = await radarr.getAllMovies();
      const existingRadarrIds = new Set(
        db.prepare("SELECT radarr_id FROM media_requests WHERE radarr_id IS NOT NULL")
          .all().map((r: any) => r.radarr_id)
      );
      const existingTitles = new Set(
        db.prepare("SELECT title FROM media_requests WHERE type = 'movie'")
          .all().map((r: any) => r.title.toLowerCase())
      );

      // Fetch qBittorrent torrents once for all torrent detection
      let allTorrents: any[] = [];
      try { allTorrents = await qbittorrent.getTorrents(); } catch {}

      for (const movie of radarrMovies) {
        // Fix existing entries: update NEW→COMPLETED if Radarr says hasFile
        const existing = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ?").get(movie.id) as any;
        if (existing) {
          if (movie.hasFile && existing.status === "NEW") {
            db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(existing.id);
            fixed++;
            console.log(`[Import] Fixed ${movie.title}: NEW→COMPLETED (Radarr hasFile)`);
          }
          continue;
        }
        if (existingTitles.has(movie.title.toLowerCase())) {
          skipped.push({ title: movie.title, radarr_id: movie.id, reason: "title exists in DB" });
          continue;
        }
        const status = movie.hasFile ? "COMPLETED" : "NEW";
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, ?, '[]')"
        ).run(movie.title, movie.id, status);
        const requestId = Number(result.lastInsertRowid);
        console.log(`[Import] Created movie request: ${movie.title} (radarr_id=${movie.id}, status=${status})`);

        // If hasFile=true, try to detect torrent hash from qBittorrent
        if (status === "COMPLETED" && allTorrents.length > 0) {
          const normTitle = movie.title.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
          const match = allTorrents.find((t: any) => {
            const tn = t.name.toLowerCase().replace(/[&]/g, "and").replace(/[:']/g, " ").replace(/[.\-_\[\]()]/g, " ").replace(/\s+/g, " ").trim();
            return tn === normTitle || tn.startsWith(normTitle + " ") || tn.startsWith(normTitle + ".");
          });
          if (match) {
            db.prepare("UPDATE media_requests SET status = 'SEEDING' WHERE id = ?").run(requestId);
            const quality = parseQualityFromName(match.name);
            db.prepare(
              "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'import', ?, ?, ?)"
            ).run(requestId, `imported-${movie.id}`, match.name, match.hash, fromQBittorrentPath(match.save_path), quality);
            db.prepare(
              "INSERT INTO approval_history (request_id, release_id, approved_by) VALUES (?, (SELECT id FROM release_candidates WHERE request_id = ? LIMIT 1), 'system')"
            ).run(requestId, requestId);
            console.log(`[Import] Detected torrent for ${movie.title}: hash=${match.hash}, status→SEEDING`);
          }
        }

        imported.push({ title: movie.title, id: requestId });
      }

      // Import ALL series from Sonarr (not just wanted/missing)
      const allSeries = await sonarr.getAllSeries();
      const existingSonarrKeys = new Set(
        db.prepare("SELECT sonarr_id, season FROM media_requests WHERE sonarr_id IS NOT NULL")
          .all().map((r: any) => `${r.sonarr_id}-${r.season}`)
      );

      for (const s of allSeries) {
        try {
          const detail = await sonarr.getSeries(s.id);
          const seasons = detail.seasons || [];
          for (const season of seasons) {
            const seasonNum = season.seasonNumber;
            const key = `${s.id}-${seasonNum}`;
            const epFileCount = season.statistics?.episodeFileCount || 0;
            const epCount = season.statistics?.episodeCount || 0;

            // Fix existing: update status based on whether files exist
            const existing = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(s.id, seasonNum) as any;
            if (existing) {
              if (epFileCount > 0 && existing.status === "NEW") {
                db.prepare("UPDATE media_requests SET status = 'COMPLETED', episode_count = ? WHERE id = ?").run(epCount || null, existing.id);
                fixed++;
                console.log(`[Import] Fixed ${detail.title} S${String(seasonNum).padStart(2, "0")}: NEW→COMPLETED (${epFileCount}/${epCount} episodes)`);
              }
              continue;
            }

            // Create new entry
            const title = `${detail.title} S${String(seasonNum).padStart(2, "0")}`;
            const status = epFileCount > 0 ? "COMPLETED" : "NEW";
            const result = db.prepare(
              "INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count) VALUES (?, 'series', ?, ?, ?, '[]', ?)"
            ).run(title, s.id, seasonNum, status, epCount || null);
            console.log(`[Import] Created series request: ${title} (sonarr_id=${s.id}, status=${status}, ${epFileCount}/${epCount} episodes)`);
            imported.push({ title, id: Number(result.lastInsertRowid) });
          }
        } catch (e: any) {
          console.error(`[Import] Failed to process series ${s.title}: ${e.message}`);
        }
      }

      // Clean up orphaned requests (radarr_id exists in DB but not in Radarr)
      const radarrIdSet = new Set(radarrMovies.map((m: any) => m.id));
      const allMovieRequests = db.prepare(
        "SELECT id, title, radarr_id FROM media_requests WHERE type = 'movie' AND radarr_id IS NOT NULL"
      ).all() as any[];
      const orphanedMovies: Array<{ title: string; radarr_id: number }> = [];
      for (const req of allMovieRequests) {
        if (!radarrIdSet.has(req.radarr_id)) {
          db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(req.id);
          db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(req.id);
          db.prepare("DELETE FROM media_requests WHERE id = ?").run(req.id);
          orphanedMovies.push({ title: req.title, radarr_id: req.radarr_id });
          console.log(`[Import] Removed orphaned request: ${req.title} (radarr_id=${req.radarr_id} not in Radarr)`);
        }
      }

      res.json({ success: true, imported: imported.length, skipped: skipped.length, fixed, orphaned: orphanedMovies.length, items: imported, skippedItems: skipped, removedOrphans: orphanedMovies.map((o: any) => o.title) });
    } catch (error) {
      console.error("Error importing missing requests:", error);
      res.status(500).json({ error: "Failed to import missing requests" });
    }
  });

  // GET /api/requests/processed - List files in Processed folders
  router.get("/processed", (req: Request, res: Response) => {
    try {
      const listDir = (dir: string): { name: string; size: number; isDir: boolean }[] => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
          const fullPath = path.join(dir, entry.name);
          let size = 0;
          try {
            const stat = fs.statSync(fullPath);
            size = stat.isDirectory() ? 0 : stat.size;
          } catch {}
          return { name: entry.name, size, isDir: entry.isDirectory() };
        }).filter((f) => !f.name.startsWith("."));
      };

      const moviesDir = PROCESSED_MOVIES;
      const tvDir = PROCESSED_TV;
      const movies = listDir(moviesDir);
      const tv = listDir(tvDir);
      res.json({ movies, tv, moviesDir, tvDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/managed - Grouped managed media (series by franchise, movies individual)
  router.get("/managed", async (req: Request, res: Response) => {
    try {
      // All requests with active torrents
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT mr.*, 
            (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2 
             JOIN approval_history ah2 ON ah2.release_id = rc2.id 
              WHERE ah2.request_id = mr.id AND rc2.torrent_hash != '' AND mr.status != 'DOWNLOADING') as total_size_mb,
            (SELECT COUNT(*) FROM release_candidates rc3 
             JOIN approval_history ah3 ON ah3.release_id = rc3.id 
             WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '' AND mr.status != 'DOWNLOADING') as release_count,
           (SELECT COALESCE(SUM(json_array_length(ah4.processed_files)), 0) FROM approval_history ah4 
                WHERE ah4.request_id = mr.id AND ah4.release_id IS NULL
                AND ah4.processed_files IS NOT NULL AND ah4.processed_files != '[]') as processed_count
           FROM media_requests mr
           WHERE mr.status IN ('DOWNLOADING', 'SEEDING', 'COMPLETED', 'NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'APPROVED')
        ) sub
        WHERE (sub.type = 'series' AND sub.sonarr_id IS NOT NULL)
           OR sub.release_count > 0 OR sub.processed_count > 0
           OR sub.status IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')
           OR (sub.type = 'series' AND sub.library_key IS NOT NULL
               AND sub.status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'APPROVED', 'DOWNLOADING', 'SEEDING', 'COMPLETED')
               AND EXISTS (
             SELECT 1 FROM media_requests sib
             WHERE sib.type = 'series' AND sib.library_key = sub.library_key
             AND (
               sib.status IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')
               OR EXISTS (
                 SELECT 1 FROM release_candidates rc6 JOIN approval_history ah6 ON ah6.release_id = rc6.id
                 WHERE ah6.request_id = sib.id AND rc6.torrent_hash != ''
               )
               OR EXISTS (
                 SELECT 1 FROM approval_history ah7
                 WHERE ah7.request_id = sib.id AND ah7.release_id IS NULL
                 AND ah7.processed_files IS NOT NULL AND ah7.processed_files != '[]'
               )
             )
           ))
        ORDER BY sub.title
      `).all() as any[];

      const managed: any[] = [];

      // Group series by sonarr_id (franchise) or library_key (native library)
      const seriesGroups = new Map<string, { sonarrId: number | null; libraryKey: string | null; seasons: any[] }>();
      const movies: any[] = [];

      for (const row of rows) {
        if (row.type === "series") {
          const key = row.sonarr_id ? `s:${row.sonarr_id}` : row.library_key ? `l:${row.library_key}` : null;
          if (key) {
            if (!seriesGroups.has(key)) {
              seriesGroups.set(key, { sonarrId: row.sonarr_id || null, libraryKey: row.library_key || null, seasons: [] });
            }
            seriesGroups.get(key)!.seasons.push(row);
            continue;
          }
        }
        movies.push(row);
      }

      // Build franchise cards for series
      for (const [gk, { sonarrId, libraryKey, seasons }] of seriesGroups) {
        // Backfill episode_count from Sonarr for any seasons missing it
        const seriesObj = sonarrId != null ? await sonarr.getSeries(sonarrId).catch(() => null) : null;
        if (seriesObj && sonarrId != null) {
          for (const s of seasons) {
            if (!s.episode_count) {
              const sn = (seriesObj.seasons || []).find((x: any) => x.seasonNumber === s.season);
              if (sn?.statistics?.episodeCount) {
                s.episode_count = sn.statistics.episodeCount;
                db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(sn.statistics.episodeCount, s.id);
              } else {
                try {
                  const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, s.season);
                  if (sonarrEps.length > 0) {
                    s.episode_count = sonarrEps.length;
                    db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(sonarrEps.length, s.id);
                  }
                } catch {}
              }
            }
          }
        }

      const franchiseTitleSeason = seasons.find((s: any) => s.season !== 0) || seasons[0];
      const franchiseTitle = cleanFranchiseTitle(franchiseTitleSeason.title);
        const firstRequestId = seasons[0].id;
        // Compute total size from processed files (source of truth), fall back to torrent sizes
        const processedTvDir = PROCESSED_TV;
        let processedBytes = 0;
        try {
          for (const s of seasons) {
            const ahRows = db.prepare(`
              SELECT processed_files FROM approval_history
              WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'
            `).all(s.id) as any[];
            for (const ah of ahRows) {
              const files: string[] = JSON.parse(ah.processed_files || "[]");
              for (const f of files) {
                const fullPath = path.join(processedTvDir, f);
                try { processedBytes += fs.statSync(fullPath).size; } catch {}
              }
            }
          }
        } catch {}
        let franchiseSize = processedBytes > 0
          ? processedBytes / (1024 * 1024)
          : seasons.reduce((sum: number, s: any) => sum + s.total_size_mb, 0);
        const mappedSeasons = seasons.map((s: any) => {
          // Covered episodes — same logic as the franchise page (/native-franchise)
          // so dashboard counts always agree with the episode grid. This counts ALL
          // processed_files rows (including torrent-linked ones), unlike the old
          // inline version which only counted release_id IS NULL rows.
          const coveredEps = coveredEpisodesForRequest(db, s);
          const extras = unnumberedFilesInSeasonFolder(db, franchiseTitle, s.season, libraryKeyYear(libraryKey));
          // Compute folder size from the season folder (source of truth)
          let folderSizeBytes = 0;
          try {
            const seasonFolder = seasonFolderForLibraryKey(db, libraryKey, franchiseTitle, s.season);
            if (seasonFolder) {
              for (const f of fs.readdirSync(seasonFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                try { folderSizeBytes += fs.statSync(path.join(seasonFolder, f)).size; } catch {}
              }
            }
          } catch {}
          const folderSizeMb = folderSizeBytes / (1024 * 1024);
          const totalSizeMb = Math.max(s.total_size_mb || 0, folderSizeMb);
          return {
            season: s.season,
            request_id: s.id,
            status: s.status,
            total_size_mb: totalSizeMb,
            release_count: s.release_count,
            title: s.title,
            // Specials rows imported from a loose-root library miscast their
            // episode_count as a file snapshot; so does a regular season that
            // imported a numbered special ("S11E00"). The real denominator is
            // TMDB's count for the season, floored by what the folder holds.
            episode_count:
              sonarrId == null
                ? s.season === 0
                  ? nativeSpecialDenominator(db, libraryKey, franchiseTitle, coveredEps, extras)
                  : nativeSeasonDenominator(db, libraryKey, s.season, coveredEps, extras, s.episode_count)
                : s.episode_count,
            covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
            extras,
          };
        }).sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
        const existingSeasons = new Set(mappedSeasons.map((s: any) => s.season));
        // Inject unrequested seasons listed by Sonarr (e.g., Specials/season 0)
        if (seriesObj && sonarrId != null) {
          for (const sn of (seriesObj.seasons || [])) {
            if (existingSeasons.has(sn.seasonNumber)) continue;
            const epCount = sn.statistics?.episodeCount || 0;
            const seasonFolder = path.join(processedTvDir, franchiseTitle, `S${String(sn.seasonNumber).padStart(2, "0")}`);
            const coveredEps = new Set<number>();
            try {
              if (fs.existsSync(seasonFolder)) {
                for (const f of fs.readdirSync(seasonFolder)) {
                  for (const n of episodeNumsFromFilename(f)) coveredEps.add(n);
                }
              }
            } catch {}
            let actualEpCount = epCount;
            try {
              const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, sn.seasonNumber);
              actualEpCount = Math.max(sonarrEps.length, coveredEps.size);
            } catch {
              if (!actualEpCount && coveredEps.size > 0) actualEpCount = coveredEps.size;
            }
            mappedSeasons.push({
              season: sn.seasonNumber,
              request_id: null,
              status: null,
              total_size_mb: 0,
              release_count: 0,
              title: franchiseTitle,
              episode_count: actualEpCount,
              covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
              extras: unnumberedFilesInSeasonFolder(db, franchiseTitle, sn.seasonNumber),
            });
            existingSeasons.add(sn.seasonNumber);
          }
        }
        // Inject disk season folders absent from request rows. The processed
        // tree is the source of truth, so any season folder with files shows up
        // even when Sonarr/Radarr are unreachable or don't list the season
        // (e.g. Specials folders) — pointed out by Death in Paradise. Sonarr
        // groups get DOMs driven by disk too; a later Sonarr-listed injection
        // above simply wins for seasons both sources agree on.
        {
          const franchiseYear = libraryKeyYear(libraryKey);
          const fallbackShowDir = processedShowDirFromFiles(db, seasons.map((s: any) => s.id)) ?? showDirByStructure(seasons.map((s: any) => s.season ?? 0), franchiseTitle);
          const diskSeasons = diskSeasonFolders(franchiseTitle, franchiseYear, fallbackShowDir);
          for (const [sn, files] of diskSeasons) {
            if (existingSeasons.has(sn)) continue;
            let tmdbCount = 0;
            try {
              const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ?").get(libraryKey, sn) as any;
              if (tc) tmdbCount = (JSON.parse(tc.payload)?.episodes || []).length || 0;
            } catch {}
            const coveredEps = new Set<number>();
            let extras = 0;
            for (const f of files) {
              const epNums = episodeNumsFromFilename(f);
              if (epNums.length) for (const n of epNums) coveredEps.add(n);
              else extras++;
            }
            mappedSeasons.push({
              season: sn,
              request_id: null,
              status: null,
              total_size_mb: 0,
              release_count: 0,
              title: franchiseTitle,
              episode_count: Math.max(tmdbCount, coveredEps.size + extras),
              covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
              extras,
            });
            existingSeasons.add(sn);
          }
          // Specials with no request row (native franchises — they carry a
          // library_key for the cache): inject from cached TMDB season-0, or
          // actively fetch when the show has an S00 folder on disk (even empty).
          if (sonarrId == null && !existingSeasons.has(0) && libraryKey) {
            let tmdbSpecials = 0;
            try {
              const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = 0").get(libraryKey) as any;
              if (tc) tmdbSpecials = namedSpecialCount(tc.payload);
            } catch {}
            if (tmdbSpecials === 0 && seasonFolderOnDisk(franchiseTitle, 0, franchiseYear, fallbackShowDir)) {
              try {
                const meta = await fetchTMDBSeason(db, libraryKey, 0, franchiseTitle, {
                  language: franchiseLanguage(db, libraryKey),
                  altTitle: fallbackShowDir ? path.basename(fallbackShowDir) : null,
                });
                if (meta) tmdbSpecials = namedSpecialCount(JSON.stringify(meta));
              } catch {}
            }
            if (tmdbSpecials > 0) {
              mappedSeasons.push({
                season: 0,
                request_id: null,
                status: null,
                total_size_mb: 0,
                release_count: 0,
                title: franchiseTitle,
                episode_count: tmdbSpecials,
                covered_episodes: [],
                extras: 0,
              });
              existingSeasons.add(0);
            }
          }
          // A native franchise has no arr to enumerate its seasons, so TMDB is
          // the only authority on how many seasons the show HAS. Without this a
          // native card lists only seasons that happen to have a request row or
          // a folder — "Sofia the First" reads as 1 season when TMDB knows 4,
          // and S02-S04 stay invisible until something creates them. The Sonarr
          // block above answers the same question from seriesObj; this is its
          // arr-free equivalent, and every consumer already handles a
          // request_id: null row because the S00 pill above is one.
          if (sonarrId == null && libraryKey) {
            const showId = cachedShowIdForKey(db, libraryKey);
            if (showId) {
              let tmdbSeasonList: Array<{ season_number: number; episode_count: number }> = [];
              try {
                tmdbSeasonList = await seasonListForShow(showId, franchiseLanguage(db, libraryKey));
              } catch {}
              for (const sn of tmdbSeasonList) {
                if (existingSeasons.has(sn.season_number)) continue;
                mappedSeasons.push({
                  season: sn.season_number,
                  request_id: null,
                  status: null,
                  total_size_mb: 0,
                  release_count: 0,
                  title: franchiseTitle,
                  episode_count: sn.episode_count || 0,
                  covered_episodes: [],
                  extras: 0,
                });
                existingSeasons.add(sn.season_number);
              }
            }
          }
        }
        mappedSeasons.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
        if (processedBytes === 0) {
          franchiseSize = mappedSeasons.reduce((sum: number, s: any) => sum + (s.total_size_mb || 0), 0);
        }
        const totalCovered = mappedSeasons.reduce((sum: number, s: any) => sum + (s.covered_episodes?.length || 0) + (s.extras || 0), 0);
        managed.push({
          title: franchiseDisplayTitle(franchiseTitle, libraryKey),
          type: "series",
          sonarr_id: sonarrId,
          library_key: libraryKey,
          group_key: gk,
          first_request_id: firstRequestId,
          seasons: mappedSeasons,
          total_size_mb: franchiseSize,
          total_releases: seasons.reduce((sum: number, s: any) => sum + s.release_count, 0),
          total_covered: totalCovered,
        });
      }

      // Add individual movies
      const processedMoviesDir = PROCESSED_MOVIES;
      for (const movie of movies) {
        let pSize = movie.total_size_mb;
        if ((movie.processed_count || 0) > 0) {
          try {
            const ahRows = db.prepare(`
              SELECT processed_files FROM approval_history
              WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'
            `).all(movie.id) as any[];
            let totalBytes = 0;
            for (const ah of ahRows) {
              const files: string[] = JSON.parse(ah.processed_files || "[]");
              for (const f of files) {
                const fullPath = path.join(processedMoviesDir, f);
                try { totalBytes += fs.statSync(fullPath).size; } catch {}
              }
            }
            if (totalBytes > 0) pSize += totalBytes / (1024 * 1024);
          } catch {}
        }
        managed.push({
          title: movie.title,
          type: "movie",
          request_id: movie.id,
          status: movie.status,
          total_size_mb: pSize,
          release_count: movie.release_count,
          processed_count: movie.processed_count || 0,
        });
      }

      // Sort: series first, then movies, alphabetical within each
      managed.sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === "series" ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

      res.json(managed);
    } catch (error) {
      console.error("Error fetching managed media:", error);
      res.status(500).json({ error: "Failed to fetch managed media" });
    }
  });

  // DELETE /api/requests/managed/:sonarrId - Delete entire franchise (all seasons + Sonarr entry)
  router.delete("/managed/:sonarrId", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const rows = db.prepare("SELECT id, title FROM media_requests WHERE sonarr_id = ?").all(sonarrId) as any[];
      if (rows.length === 0) return res.json({ success: true, deleted: 0, title: null });

      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";

      let sonarrDeleteFailed = false;
      // Delete from Sonarr (best-effort — DB rows are removed regardless so a
      // down/unconfigured arr doesn't block the local delete)
      if (sUrl && sKey) {
        try {
          const r = await fetch(`${sUrl}/api/v3/series/${sonarrId}?deleteFiles=false`, { method: "DELETE", headers: { "X-Api-Key": sKey } });
          if (!r.ok) {
            console.warn(`[Delete] Sonarr DELETE franchise ${sonarrId} failed: HTTP ${r.status}`);
            sonarrDeleteFailed = true;
          }
        } catch (e: any) {
          console.warn(`[Delete] Sonarr DELETE franchise ${sonarrId} failed: ${e.message}`);
          sonarrDeleteFailed = true;
        }
      } else {
        sonarrDeleteFailed = true;
      }

      // Delete all requests + RCs + approval history
      for (const row of rows) {
        db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(row.id);
        db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(row.id);
        db.prepare("DELETE FROM media_requests WHERE id = ?").run(row.id);
      }

      console.log(`[Delete] Deleted franchise sonarr_id=${sonarrId}: ${rows[0].title} (${rows.length} requests, sonarrDeleteFailed=${sonarrDeleteFailed})`);
      deletedFranchiseIds?.add(sonarrId);
      res.json({ success: true, deleted: rows.length, title: rows[0].title, sonarrDeleteFailed });
    } catch (error: any) {
      console.error("Error deleting franchise:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/managed/:sonarrId/seasons - Lightweight: all seasons from Sonarr + which are requested
  router.get("/managed/:sonarrId/seasons", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const series = await sonarr.getSeries(sonarrId).catch(() => null);
      if (!series) return res.status(404).json({ error: "Series not found in Sonarr" });
      const sonarrSeasons = (series.seasons || []).map((s: any) => s.seasonNumber);

      const requestedSeasons = db.prepare(
        "SELECT season, id, status, title FROM media_requests WHERE sonarr_id = ? AND type = 'series'"
      ).all(sonarrId) as any[];

      const requestedMap = new Map<number, any>();
      for (const rs of requestedSeasons) requestedMap.set(rs.season, rs);

      const seasons = sonarrSeasons.map((sn: number) => ({
        season: sn,
        requested: requestedMap.get(sn) || null,
      }));

      res.json({ title: series.title, sonarr_id: sonarrId, seasons });
    } catch (error: any) {
      console.error("Error fetching franchise seasons:", error);
      res.status(500).json({ error: error.message || "Failed to fetch seasons" });
    }
  });

  // GET /api/requests/managed/:sonarrId - Franchise detail: all seasons + all releases
  router.get("/managed/:sonarrId", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasons = db.prepare(`
        SELECT mr.*,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           JOIN approval_history ah2 ON ah2.release_id = rc2.id AND ah2.request_id = mr.id
           WHERE rc2.torrent_hash != '' AND mr.status != 'DOWNLOADING') as total_size_mb,
           (SELECT COUNT(*) FROM release_candidates rc3
            JOIN approval_history ah3 ON ah3.release_id = rc3.id AND ah3.request_id = mr.id
            WHERE rc3.torrent_hash != '' AND mr.status != 'DOWNLOADING') as release_count,
          (SELECT COUNT(*) FROM release_candidates rc4
           WHERE rc4.request_id = mr.id) as total_candidates
        FROM media_requests mr
        WHERE mr.sonarr_id = ? AND mr.type = 'series'
        ORDER BY mr.season
      `).all(sonarrId) as any[];

      if (seasons.length === 0) {
        return res.status(404).json({ error: "Franchise not found" });
      }

        const franchiseTitleSeason = seasons.find((s: any) => s.season !== 0) || seasons[0];
        const franchiseTitle = franchiseTitleSeason.title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");

      const seasonDetails: any[] = [];
      for (const s of seasons) {
        // Backfill episode_count from Sonarr if null
        let episodeCount = s.episode_count;
        if (!episodeCount && s.sonarr_id) {
          try {
            const series = await sonarr.getSeries(s.sonarr_id);
            const sonarrSeason = (series.seasons || []).find((sn: any) => sn.seasonNumber === s.season);
            if (sonarrSeason?.statistics?.episodeCount) {
              episodeCount = sonarrSeason.statistics.episodeCount;
              db.prepare("UPDATE media_requests SET episode_count = ? WHERE id = ?").run(episodeCount, s.id);
            }
          } catch {}
        }

        const releases = db.prepare(`
          SELECT rc.*, ah.approved_at, ah.approval_reason
          FROM release_candidates rc
          LEFT JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = ?
          WHERE rc.request_id = ?
          ORDER BY rc.app_score DESC, rc.size_mb DESC
        `).all(s.id, s.id) as any[];

        // Get covered episodes — only from approved releases with torrent_hash (actually have these episodes)
        const coveredEps = new Set<number>();
        for (const r of releases) {
          if (r.approved_at && r.torrent_hash) {
            if (r.parsed_episodes) {
              const epMatches = r.parsed_episodes.match(/E(\d{1,3})/g);
              if (epMatches) {
                for (const em of epMatches) coveredEps.add(parseInt(em.slice(1), 10));
              }
              const rangeMatch = r.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
              if (rangeMatch) {
                for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) coveredEps.add(i);
              }
            } else if (episodeCount && s.season != null && isSeasonPackTitle(r.title || '', s.season)) {
              for (let i = 1; i <= episodeCount; i++) coveredEps.add(i);
            }
          }
        }

        // Also count library-imported files — parse episode numbers from processed_files paths (verify on disk)
        const processedTvDir = PROCESSED_TV;
        const processedAh = db.prepare(`
          SELECT processed_files FROM approval_history
          WHERE request_id = ? AND (release_id IS NULL OR release_id = 0)
          AND processed_files IS NOT NULL AND processed_files != '[]'
        `).all(s.id) as any[];
        for (const pa of processedAh) {
          const files: string[] = JSON.parse(pa.processed_files || "[]");
          for (const pf of files) {
            const fullPath = path.join(processedTvDir, franchiseTitle, pf);
            if (!fs.existsSync(fullPath)) continue;
            for (const n of episodeNumsFromFilename(pf)) coveredEps.add(n);
          }
        }
        // Also scan the season folder on disk for files not yet in approval_history
        let folderSizeBytes = 0;
        const diskEps = new Set<number>();
        try {
          const seasonFolder = path.join(processedTvDir, franchiseTitle, `S${String(s.season).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              for (const n of episodeNumsFromFilename(f)) diskEps.add(n);
              try { folderSizeBytes += fs.statSync(path.join(seasonFolder, f)).size; } catch {}
            }
            // Prefer disk coverage over RC coverage when season folder exists
            for (const ep of coveredEps) {
              if (diskEps.has(ep)) continue;
              coveredEps.delete(ep);
            }
          }
        } catch {}
        // Also add disk-only episodes (files without RC)
        for (const ep of diskEps) coveredEps.add(ep);
        const folderSizeMb = folderSizeBytes / (1024 * 1024);
        const totalSizeMb = Math.max(s.total_size_mb || 0, folderSizeMb);

        seasonDetails.push({
          season: s.season,
          request_id: s.id,
          status: s.status,
          total_size_mb: totalSizeMb,
          release_count: s.release_count,
          title: s.title,
          episode_count: episodeCount,
          covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
          releases: releases.map((r: any) => ({
            id: r.id,
            title: r.title,
            size_mb: r.size_mb,
            quality: r.radarr_quality,
            seeders: r.seeders,
            leechers: r.leechers,
            release_group: r.release_group,
            torrent_hash: r.torrent_hash,
            app_score: r.app_score,
            parsed_episodes: r.parsed_episodes || '',
            approved: !!r.approved_at,
            approved_at: r.approved_at || null,
            info_url: r.info_url || '',
            indexer: r.indexer || '',
          })),
        });
      }

      // Inject unrequested seasons from Sonarr (e.g., Specials)
      const seriesObj2 = await sonarr.getSeries(sonarrId).catch(() => null);
      if (seriesObj2) {
        const existingSeasons = new Set(seasonDetails.map((s: any) => s.season));
        const processedTvDir2 = PROCESSED_TV;
        for (const sn of (seriesObj2.seasons || [])) {
          if (!existingSeasons.has(sn.seasonNumber)) {
            const epCount = sn.statistics?.episodeCount || 0;
            const seasonFolder2 = path.join(processedTvDir2, franchiseTitle, `S${String(sn.seasonNumber).padStart(2, "0")}`);
            const coveredEps3 = new Set<number>();
            let folderSize = 0;
            try {
              if (fs.existsSync(seasonFolder2)) {
                for (const f of fs.readdirSync(seasonFolder2)) {
                  const fp = path.join(seasonFolder2, f);
                  try { folderSize += fs.statSync(fp).size; } catch {}
                  for (const n of episodeNumsFromFilename(f)) coveredEps3.add(n);
                }
              }
            } catch {}
            // Use filesystem count if Sonarr returns 0 but files exist
            let actualEpCount = epCount;
            if (!actualEpCount && coveredEps3.size > 0) {
              try {
                const sonarrEps = await sonarr.getSeasonEpisodes(sonarrId, sn.seasonNumber);
                actualEpCount = Math.max(sonarrEps.length, coveredEps3.size);
              } catch { actualEpCount = coveredEps3.size; }
            }
            seasonDetails.push({
              season: sn.seasonNumber,
              request_id: null,
              status: null,
              total_size_mb: folderSize / (1024 * 1024),
              release_count: 0,
              title: franchiseTitle,
              episode_count: actualEpCount,
              covered_episodes: Array.from(coveredEps3).sort((a, b) => a - b),
              releases: [],
            });
          }
        }
        seasonDetails.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
      }

      res.json({
        title: franchiseTitle,
        sonarr_id: sonarrId,
        seasons: seasonDetails,
        total_size_mb: seasonDetails.reduce((sum: number, s: any) => sum + (s.total_size_mb || 0), 0),
        total_releases: seasonDetails.reduce((sum: number, s: any) => sum + (s.release_count || 0), 0),
      });
    } catch (error) {
      console.error("Error fetching franchise detail:", error);
      res.status(500).json({ error: "Failed to fetch franchise detail" });
    }
  });

  // GET /api/requests/managed/:sonarrId/season/:season/episodes - Episode list with coverage from Sonarr
  router.get("/managed/:sonarrId/season/:season/episodes", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasonNum = Number(req.params.season);

      const row = db.prepare(
        "SELECT id, sonarr_id, title, season, episode_count FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND season = ?"
      ).get(sonarrId, seasonNum) as any;

      if (!row) {
        // No DB entry — fetch from Sonarr + filesystem (e.g., Specials)
        let sonarrEpisodes2: Array<{ episodeNumber: number; title: string; hasFile: boolean; airDateUtc?: string }> = [];
        try {
          const episodes2 = await sonarr.getSeasonEpisodes(sonarrId, seasonNum);
          sonarrEpisodes2 = episodes2.map((e: any) => ({
            episodeNumber: e.episodeNumber,
            title: e.title,
            hasFile: e.hasFile,
            airDateUtc: e.airDateUtc,
          }));
        } catch {}
        // Scan processed filesystem for files in S00 folder
        const seriesObj3 = await sonarr.getSeries(sonarrId).catch(() => null);
        const franchiseTitle3 = seriesObj3?.title || `Series ${sonarrId}`;
        const processedTvDir3 = PROCESSED_TV;
        const seasonFolder3 = path.join(processedTvDir3, franchiseTitle3, `S${String(seasonNum).padStart(2, "0")}`);
        const coveredEpsFS = new Set<number>();
        const epQualityFS: Record<number, string> = {};
        try {
          if (fs.existsSync(seasonFolder3)) {
            for (const f of fs.readdirSync(seasonFolder3)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              for (const n of episodeNumsFromFilename(f)) {
                coveredEpsFS.add(n);
                if (!epQualityFS[n]) epQualityFS[n] = "WEB-DL";
              }
            }
          }
        } catch {}
        const episodes3 = sonarrEpisodes2.map((e: any) => ({
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.hasFile,
          covered: coveredEpsFS.has(e.episodeNumber),
          quality: epQualityFS[e.episodeNumber] || "",
          airDateUtc: e.airDateUtc || "",
        }));
        // Also add filesystem-only eps not in Sonarr
        for (const epNum of coveredEpsFS) {
          if (!episodes3.some((e: any) => e.episodeNumber === epNum)) {
            episodes3.push({
              episodeNumber: epNum,
              title: "",
              hasFile: false,
              covered: true,
              quality: epQualityFS[epNum] || "",
              airDateUtc: "",
            });
          }
        }
        episodes3.sort((a: any, b: any) => a.episodeNumber - b.episodeNumber);
        return res.json({
          episodeCount: sonarrEpisodes2.length,
          coveredCount: coveredEpsFS.size,
          episodes: episodes3,
        });
      }

      let sonarrEpisodes: Array<{ episodeNumber: number; title: string; hasFile: boolean; airDateUtc?: string }> = [];
      try {
        const episodes = await sonarr.getSeasonEpisodes(row.sonarr_id, seasonNum);
        sonarrEpisodes = episodes.map((e) => ({
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.hasFile,
          airDateUtc: e.airDateUtc,
        }));
      } catch {
        // Sonarr might not have the series, fall back to empty
      }

      const coveredEps = new Set<number>();
      const epQuality: Record<number, string> = {};
      const releases = db.prepare(`
        SELECT rc.parsed_episodes, rc.radarr_quality, rc.title, ah.approved_at, rc.torrent_hash
        FROM release_candidates rc
        LEFT JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = ?
        WHERE rc.request_id = ?
      `).all(row.id, row.id) as any[];

      let hasSeasonPack = false;
      for (const r of releases) {
          if (r.approved_at && r.torrent_hash) {
            if (r.parsed_episodes) {
              const quality = r.radarr_quality?.toLowerCase() === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
              const epMatches = r.parsed_episodes.match(/E(\d{1,3})/g);
            if (epMatches) {
              for (const em of epMatches) {
                const epNum = parseInt(em.slice(1), 10);
                coveredEps.add(epNum);
                if (!epQuality[epNum] || quality.toLowerCase().includes("remux")) epQuality[epNum] = quality;
              }
            }
            const rangeMatch = r.parsed_episodes.match(/E(\d{1,3})\s*-\s*(\d{1,3})/);
            if (rangeMatch) {
              for (let i = parseInt(rangeMatch[1], 10); i <= parseInt(rangeMatch[2], 10); i++) {
                coveredEps.add(i);
                if (!epQuality[i] || quality.toLowerCase().includes("remux")) epQuality[i] = quality;
              }
            }
          } else if (row.season != null && isSeasonPackTitle(r.title || '', row.season)) {
            hasSeasonPack = true;
            const quality = r.radarr_quality?.toLowerCase() === 'unknown' ? parseQualityFromName(r.title || '') : (r.radarr_quality || "");
            for (let i = 1; i <= (sonarrEpisodes.length || row.episode_count || 0); i++) {
              if (!epQuality[i] || quality.toLowerCase().includes("remux")) epQuality[i] = quality;
            }
          }
        }
      }

      // Also count library-imported files (no RC) as full season coverage
      const processedAh2 = db.prepare(`
        SELECT processed_files FROM approval_history
        WHERE request_id = ? AND (release_id IS NULL OR release_id = 0)
        AND processed_files IS NOT NULL AND processed_files != '[]'
      `).all(row.id) as any[];
      for (const pa of processedAh2) {
        const files: string[] = JSON.parse(pa.processed_files || "[]");
        for (const pf of files) {
          const quality = "WEB-DL";
          for (const n of episodeNumsFromFilename(pf)) {
            coveredEps.add(n);
            if (!epQuality[n] || quality.toLowerCase().includes("remux")) epQuality[n] = quality;
          }
        }
      }

      // Also count files on disk in the season folder (prefer disk over RC)
      const diskEps2 = new Set<number>();
      try {
        const series = await sonarr.getSeries(row.sonarr_id);
        const fTitle = series.title;
        const processedTvDir = PROCESSED_TV;
        const seasonFolder = path.join(processedTvDir, fTitle, `S${String(seasonNum).padStart(2, "0")}`);
        if (fs.existsSync(seasonFolder)) {
          for (const f of fs.readdirSync(seasonFolder)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            for (const n of episodeNumsFromFilename(f)) diskEps2.add(n);
          }
          // Prefer disk coverage over RC coverage when season folder exists
          for (const ep of coveredEps) {
            if (diskEps2.has(ep)) continue;
            coveredEps.delete(ep);
          }
        }
      } catch {}
      // Add disk-only episodes
      for (const ep of diskEps2) {
        coveredEps.add(ep);
        if (!epQuality[ep]) epQuality[ep] = "WEB-DL";
      }

      if (sonarrEpisodes.length > 0) {
        if (hasSeasonPack) {
          for (const e of sonarrEpisodes) coveredEps.add(e.episodeNumber);
        }
        const episodes = sonarrEpisodes.map((e) => ({
          ...e,
          covered: coveredEps.has(e.episodeNumber),
          quality: epQuality[e.episodeNumber] || "",
        }));
        res.json({ episodeCount: episodes.length, coveredCount: coveredEps.size, episodes });
      } else {
        const epCount = row.episode_count || 0;
        if (hasSeasonPack) {
          for (let i = 1; i <= epCount; i++) coveredEps.add(i);
        }
        const episodes = Array.from({ length: epCount }, (_, i) => ({
          episodeNumber: i + 1,
          title: `Episode ${i + 1}`,
          hasFile: false,
          covered: coveredEps.has(i + 1),
        }));
        res.json({ episodeCount: epCount, coveredCount: coveredEps.size, episodes });
      }
    } catch (error: any) {
      console.error("Error fetching season episodes:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to fetch episodes" });
    }
  });

  // GET /api/requests/managed/:sonarrId/torrent-statuses - All torrent statuses across all seasons
  router.get("/managed/:sonarrId/torrent-statuses", async (req: Request, res: Response) => {
    try {
      const sonarrId = Number(req.params.sonarrId);
      const seasons = db.prepare(
        "SELECT id, season, title, sonarr_id FROM media_requests WHERE sonarr_id = ? AND type = 'series'"
      ).all(sonarrId) as any[];

      if (seasons.length === 0) {
        return res.status(404).json({ error: "Franchise not found" });
      }

      const requestIds = seasons.map((s: any) => s.id);
      const placeholders = requestIds.map(() => "?").join(",");

      const releases = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id, rc.size_mb, ah.request_id " +
        "FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id " +
        `WHERE ah.request_id IN (${placeholders}) AND rc.torrent_hash != ''`
      ).all(...requestIds) as any[];

      if (releases.length === 0) {
        return res.json([]);
      }

      const torrents = await qbittorrent.getTorrents();
      const results: any[] = [];

      for (const release of releases) {
        const torrent = torrents.find((t: any) => t.hash === release.torrent_hash);
        if (!torrent) {
          results.push({ release_id: release.release_id, request_id: release.request_id, title: release.title, found: false });
          continue;
        }

        const season = seasons.find((s: any) => s.id === release.request_id);
        let inLibrary = false;
        let libraryPath = "";

        if (season) {
          try {
            const series = await sonarr.getSeries(season.sonarr_id);
            const seasonFolder = path.join(
              series.path || path.join(MEDIA_TV, series.title),
              `S${String(season.season).padStart(2, "0")}`
            );
            if (fs.existsSync(seasonFolder)) {
              let contentPath = fromQBittorrentPath(torrent.content_path);
              if (!fs.existsSync(contentPath)) contentPath = torrent.content_path;
              const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);
              for (const f of fs.readdirSync(seasonFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const fPath = path.join(seasonFolder, f);
                try {
                  if (contentInodes.size > 0 && contentInodes.has(fs.statSync(fPath).ino)) {
                    inLibrary = true;
                    libraryPath = fPath;
                    break;
                  }
                } catch {}
              }
              // Fallback: filename match
              if (!inLibrary) {
                const match = fs.readdirSync(seasonFolder).find((f: string) => contentNames.has(f));
                if (match) { inLibrary = true; libraryPath = path.join(seasonFolder, match); }
              }
            }
          } catch {}
        }

        results.push({
          release_id: release.release_id,
          request_id: release.request_id,
          season: season?.season,
          title: release.title,
          found: true,
          hash: torrent.hash,
          name: torrent.name,
          state: torrent.state,
          progress: Math.round(torrent.progress * 100),
          dlspeed: torrent.dlspeed,
          upspeed: torrent.upspeed,
          uploaded: torrent.uploaded,
          seeding_time: torrent.seeding_time,
          ratio: Math.round(torrent.ratio * 100) / 100,
          eta: torrent.eta,
          save_path: fromQBittorrentPath(torrent.save_path),
          content_path: fromQBittorrentPath(torrent.content_path),
          in_library: inLibrary,
          library_path: libraryPath,
          num_seeds: torrent.num_seeds,
          num_leechs: torrent.num_leechs,
        });
      }

      res.json(results);
    } catch (error: any) {
      console.error("Error fetching franchise torrent statuses:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/reactivate-all - Re-activate all DISMISSED requests
  // Requests with approved releases go to DOWNLOADING + re-detect torrent hashes
  router.post("/reactivate-all", async (req: Request, res: Response) => {
    try {
      const dismissed = db.prepare(
        "SELECT id, title, radarr_id, sonarr_id FROM media_requests WHERE status = 'DISMISSED'"
      ).all() as any[];

      // Get all qBittorrent torrents once for matching
      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {}

      let reactivated = 0;
      for (const r of dismissed) {
        const approvedRelease = db.prepare(
          "SELECT rc.id, rc.torrent_hash, rc.title FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? LIMIT 1"
        ).get(r.id) as any;

        if (approvedRelease) {
          // Has approved release — go to DOWNLOADING
          db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);

          // If hash is empty, try to re-detect from qBittorrent
          if (!approvedRelease.torrent_hash && allTorrents.length > 0) {
            // Match by title (fuzzy — check if torrent name contains the release title)
            const match = allTorrents.find((t: any) =>
              t.name.toLowerCase().includes(approvedRelease.title.toLowerCase().slice(0, 20)) ||
              approvedRelease.title.toLowerCase().includes(t.name.toLowerCase().slice(0, 20))
            );
            if (match) {
              db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                .run(match.hash, fromQBittorrentPath(match.save_path), approvedRelease.id);
              console.log(`[Reactivate] Re-detected torrent for ${r.title}: ${match.hash}`);
            }
          }
        } else {
          // No approved release — go to NEW for poller to search
          db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
        }
        reactivated++;
      }

      console.log(`[Reactivate] Re-activated ${reactivated} dismissed requests`);
      res.json({ success: true, reactivated });
    } catch (error) {
      console.error("Error reactivating requests:", error);
      res.status(500).json({ error: "Failed to reactivate requests" });
    }
  });

  // POST /api/requests/delete-dismissed - Permanently delete all DISMISSED requests from DB
  router.post("/delete-dismissed", (req: Request, res: Response) => {
    try {
      const result = db.prepare(
        "DELETE FROM media_requests WHERE status = 'DISMISSED'"
      ).run();
      console.log(`[Delete] Permanently deleted ${result.changes} dismissed requests`);
      res.json({ success: true, deleted: result.changes });
    } catch (error) {
      console.error("Error deleting dismissed requests:", error);
      res.status(500).json({ error: "Failed to delete dismissed requests" });
    }
  });

  // POST /api/requests/detect-torrents - Scan qBittorrent for orphaned requests and link them
  router.post("/detect-torrents", async (req: Request, res: Response) => {
    try {
      // Find requests with no active torrent hash — includes DOWNLOADING items whose entries were wiped
      const orphans = db.prepare(
        "SELECT mr.id, mr.title FROM media_requests mr " +
        "WHERE mr.status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'DOWNLOADING') " +
        "AND NOT EXISTS (" +
        "  SELECT 1 FROM release_candidates rc " +
        "  JOIN approval_history ah ON ah.release_id = rc.id " +
        "  WHERE ah.request_id = mr.id AND rc.torrent_hash != ''" +
        ")"
      ).all() as any[];

      if (orphans.length === 0) {
        return res.json({ success: true, detected: 0, total: 0, matches: [] });
      }

      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {
        return res.json({ success: true, detected: 0, total: orphans.length, error: "qBittorrent unavailable", matches: [] });
      }

      const matchedTorrentHashes = new Set<string>();
      const matches: Array<{ request_id: number; request_title: string; torrent_name: string; torrent_hash: string; episodes: string }> = [];
      let detected = 0;

      for (const orphan of orphans) {
        const titleWords = orphan.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 0 && !["the", "and", "for"].includes(w));

        const match = allTorrents.find((t: any) => {
          if (matchedTorrentHashes.has(t.hash)) return false;
          const tLower = t.name.toLowerCase().replace(/[^a-z0-9\s.]/g, " ").replace(/\s+/g, " ").trim();
          // Require ALL significant title words to appear in the torrent name
          const allWordsPresent = titleWords.every((w: string) => tLower.includes(w));
          if (!allWordsPresent) return false;
          // Extra check: short titles (1-2 words) must match at the start, followed by separator+non-digit or end
          if (titleWords.length <= 2) {
            const firstWord = titleWords[0];
            if (!tLower.startsWith(firstWord)) return false;
            const afterTitle = tLower.slice(firstWord.length);
            // After the first word, expect separator then either:
            // - second word (if 2-word title), year (4+ digits), quality marker, or end
            // - NOT a single digit sequel indicator (2, 3, 4...) unless the title itself has that digit
            if (titleWords.length === 2) {
              if (!afterTitle.includes(titleWords[1])) return false;
              const idx2 = afterTitle.indexOf(titleWords[1]);
              const afterSecond = afterTitle.slice(idx2 + titleWords[1].length).trim();
              // After both words, check next char isn't a sequel number
              if (/^[.\-_\s]*\d{1,2}[.\-_\s]/.test(afterSecond) && !/^[.\-_\s]*(19|20)\d{2}/.test(afterSecond)) return false;
            } else {
              // Single word title: after matching, next should be separator then year/quality/end, NOT sequel digit
              const nextChars = afterTitle.replace(/^[\s.\-_]+/, "");
              if (/^\d{1,2}[\s.\-_]/.test(nextChars) && !/^(19|20)\d{2}/.test(nextChars)) return false;
            }
          }
          return true;
        });

        if (match) {
          matchedTorrentHashes.add(match.hash);
          const sizeMb = Math.round((match.size || 0) / (1024 * 1024));
          const parsed = parseTorrentName(match.name);
          const episodeStr = parsed.season !== null ? (parsed.episodes.length > 0 ? formatEpisodes(parsed) : `S${String(parsed.season).padStart(2, "0")}`) : '';

          // Dedup: check if this torrent hash already exists for this request
          const existingHash = db.prepare(
            "SELECT 1 FROM release_candidates WHERE torrent_hash = ? AND request_id = ?"
          ).get(match.hash, orphan.id);
          if (existingHash) {
            console.log(`[Detect] Skipping duplicate torrent hash for ${orphan.title}: ${match.hash}`);
            continue;
          }

          const quality = parseQualityFromName(match.name);

          const rcResult = db.prepare(
            "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, torrent_hash, save_path, parsed_episodes) " +
            "VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)"
          ).run(orphan.id, `manual-${match.hash.slice(0, 12)}`, match.name, sizeMb, quality, match.hash, fromQBittorrentPath(match.save_path), episodeStr);

          db.prepare(
            "INSERT INTO approval_history (request_id, release_id) VALUES (?, ?)"
          ).run(orphan.id, rcResult.lastInsertRowid);

          db.prepare(
            "UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(orphan.id);

          detected++;
          matches.push({ request_id: orphan.id, request_title: orphan.title, torrent_name: match.name, torrent_hash: match.hash,           episodes: episodeStr || '' });
          console.log(`[Detect] Linked torrent for ${orphan.title} → ${match.name}${episodeStr ? ` (${episodeStr})` : ''}`);
        }
      }

      res.json({ success: true, detected, total: orphans.length, matches });
    } catch (error) {
      console.error("Error detecting torrents:", error);
      res.status(500).json({ error: "Failed to detect torrents" });
    }
  });

  // POST /api/requests/scan-downloads - Scan all qBittorrent torrents, import into Radarr/Sonarr + DB
  router.post("/scan-downloads", async (req: Request, res: Response) => {
    try {
      let allTorrents: any[] = [];
      try {
        allTorrents = await qbittorrent.getTorrents();
      } catch {
        return res.status(500).json({ error: "qBittorrent unavailable" });
      }

      const existingHashes = new Set(
        db.prepare("SELECT torrent_hash FROM release_candidates WHERE torrent_hash != ''")
          .all().map((r: any) => r.torrent_hash)
      );

      // Always run title+season mismatch detection (even when there are new torrents)
      const qbitHashesForCheck = new Set(allTorrents.map((t: any) => t.hash));
      // Fix season mismatches: RCs attached to wrong-season requests
      const allRcWithReq = db.prepare(
        "SELECT rc.id as rc_id, rc.request_id, rc.torrent_hash, rc.title as rc_title, mr.season as req_season, mr.sonarr_id, mr.type " +
        "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL AND mr.type = 'series'"
      ).all() as any[];
      let seasonFixed = 0;
      for (const rc of allRcWithReq) {
        if (!qbitHashesForCheck.has(rc.torrent_hash)) continue;
        const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
        if (!torrent) continue;
        const parsed = parseTorrentName(torrent.name);
        const torrentSeason = parsed.season || 1;
        if (rc.req_season != null && torrentSeason !== rc.req_season) {
          db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.rc_id);
          db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.rc_id);
          console.log(`[ScanDownloads] Season mismatch: RC ${rc.rc_id} (S${rc.req_season}) <- torrent S${torrentSeason} "${torrent.name.slice(0, 60)}"`);
          seasonFixed++;
        }
      }
      // Fix title mismatches: RCs attached to wrong-title requests (e.g. Moana 2 torrent matched to Moana, or Ninjago linked to "The Rising")
      const allRcWithTitle = db.prepare(
        "SELECT rc.id as rc_id, rc.request_id, rc.torrent_hash, rc.title as rc_title, mr.title as req_title, mr.type " +
        "FROM release_candidates rc JOIN media_requests mr ON mr.id = rc.request_id " +
        "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
      ).all() as any[];
      let titleFixed = 0;
      for (const rc of allRcWithTitle) {
        if (!qbitHashesForCheck.has(rc.torrent_hash)) continue;
        const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
        if (!torrent) continue;
        const torrentNorm = normalizeTitleForMatch(torrent.name);
        const reqNorm = normalizeTitleForMatch(rc.req_title);
        if (!titlesMatch(reqNorm, torrentNorm)) {
          db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(rc.rc_id);
          db.prepare("DELETE FROM release_candidates WHERE id = ?").run(rc.rc_id);
          console.log(`[ScanDownloads] Title mismatch: RC ${rc.rc_id} (request "${rc.req_title}") <- torrent "${torrent.name.slice(0, 60)}"`);
          titleFixed++;
        }
      }
      if (seasonFixed > 0) console.log(`[ScanDownloads] Removed ${seasonFixed} season-mismatched RC(s)`);
      if (titleFixed > 0) console.log(`[ScanDownloads] Removed ${titleFixed} title-mismatched RC(s)`);

      let newTorrents = allTorrents.filter((t: any) => !existingHashes.has(t.hash));

      // Also include freed torrents from mismatch cleanup
      if (seasonFixed > 0 || titleFixed > 0) {
        const freshHashes = new Set(
          db.prepare("SELECT torrent_hash FROM release_candidates WHERE torrent_hash != ''")
            .all().map((r: any) => r.torrent_hash)
        );
        newTorrents = allTorrents.filter((t: any) => !freshHashes.has(t.hash));
      }

      if (newTorrents.length === 0) {
        const qbitHashes = new Set(allTorrents.map((t: any) => t.hash));
        const orphaned = db.prepare(
          "SELECT rc.id, rc.request_id, rc.torrent_hash FROM release_candidates rc " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL " +
          "AND NOT EXISTS (SELECT 1 FROM approval_history ah WHERE ah.release_id = rc.id AND ah.request_id = rc.request_id)"
        ).all() as any[];
        let backfilled = 0;
        for (const orph of orphaned) {
          if (!qbitHashes.has(orph.torrent_hash)) continue;
          db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(orph.id, orph.request_id);
          backfilled++;
        }
        // Remove approval_history for RCs whose torrent is no longer in qBittorrent
        const allApprovedRcs = db.prepare(
          "SELECT DISTINCT ah.release_id, rc.torrent_hash FROM approval_history ah " +
          "JOIN release_candidates rc ON rc.id = ah.release_id " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
        ).all() as any[];
        const toRemove = allApprovedRcs.filter((r: any) => !qbitHashes.has(r.torrent_hash));
        if (toRemove.length > 0) {
          const removeIds = toRemove.map((r: any) => r.release_id);
          db.prepare(`DELETE FROM approval_history WHERE release_id IN (${removeIds.map(() => "?").join(",")})`).run(...removeIds);
          console.log(`[ScanDownloads] Removed ${toRemove.length} stale approval(s) for RCs not in qBittorrent`);
        }
        // Sync request statuses — any request with approved RCs in qBittorrent should be DOWNLOADING/SEEDING
        let staleFixed = 0;
        const staleStatus = db.prepare(
          "SELECT DISTINCT mr.id, mr.status FROM media_requests mr " +
          "JOIN approval_history ah ON ah.request_id = mr.id " +
          "JOIN release_candidates rc ON rc.id = ah.release_id AND rc.request_id = mr.id " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL " +
          "AND mr.status NOT IN ('DOWNLOADING', 'SEEDING', 'COMPLETED')"
        ).all() as any[];
        for (const row of staleStatus) {
          const rcHashes = db.prepare(
            "SELECT rc.torrent_hash FROM release_candidates rc " +
            "JOIN approval_history ah ON ah.release_id = rc.id AND ah.request_id = rc.request_id " +
            "WHERE rc.request_id = ? AND rc.torrent_hash != ''"
          ).all(row.id) as any[];
          const hasInQbit = rcHashes.some((r: any) => qbitHashes.has(r.torrent_hash));
          if (hasInQbit) {
            db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
            console.log(`[ScanDownloads] Fixed status: request ${row.id} ${row.status} -> DOWNLOADING`);
            staleFixed++;
          }
        }
        // Fix RCs with wrong title or Unknown quality
        const rcToFix = db.prepare(
          "SELECT rc.id, rc.title, rc.torrent_hash, rc.radarr_quality FROM release_candidates rc " +
          "WHERE rc.torrent_hash != '' AND rc.torrent_hash IS NOT NULL"
        ).all() as any[];
        let rcFixed = 0;
        for (const rc of rcToFix) {
          if (!qbitHashes.has(rc.torrent_hash)) continue;
          const torrent = allTorrents.find((t: any) => t.hash === rc.torrent_hash);
          if (!torrent) continue;
          const correctQuality = parseQualityFromName(torrent.name);
          if (rc.title !== torrent.name || rc.radarr_quality?.toLowerCase() === 'unknown') {
            db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, rc.id);
            console.log(`[ScanDownloads] Fixed RC ${rc.id}: title="${torrent.name.slice(0, 60)}", quality="${correctQuality}"`);
            rcFixed++;
          }
        }
        if (rcFixed > 0) console.log(`[ScanDownloads] Fixed ${rcFixed} RC(s) with wrong title/quality`);
        if (backfilled > 0) console.log(`[ScanDownloads] Backfilled ${backfilled} orphaned RC(s) with approval_history`);

        return res.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, total: allTorrents.length, results: [], backfilled, staleRemoved: toRemove.length, statusFixed: staleFixed, rcFixed });
      }

      if (newTorrents.length === 0) {
        return res.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, total: allTorrents.length, results: [] });
      }

      const results: Array<{ title: string; status: string; type?: string; request_id?: number; error?: string }> = [];

      let radarrProfiles: any[] = [];
      let radarrRootFolders: any[] = [];
      let sonarrProfiles: any[] = [];
      let sonarrRootFolders: any[] = [];

      try { radarrProfiles = await radarr.getQualityProfiles(); } catch {}
      try { radarrRootFolders = await radarr.getRootFolders(); } catch {}
      try { sonarrProfiles = await sonarr.getQualityProfiles(); } catch {}
      try { sonarrRootFolders = await sonarr.getRootFolders(); } catch {}

      const radarrProfileId = radarrProfiles[0]?.id;
      const radarrRootPath = radarrRootFolders[0]?.path;
      const sonarrProfileId = sonarrProfiles[0]?.id;
      const sonarrRootPath = sonarrRootFolders[0]?.path;

      // Pre-fetch all existing media to avoid duplicate imports within the same batch
      const allRadarrMovies = await radarr.getAllMovies().catch((e) => { console.error(`[ScanDownloads] getAllMovies failed: ${e.message}`); return [] as any[]; });
      const allSonarrSeries = await sonarr.getAllSeries().catch((e) => { console.error(`[ScanDownloads] getAllSeries failed: ${e.message}`); return [] as any[]; });

      console.log(`[ScanDownloads] Fetched ${allRadarrMovies.length} Radarr movies, ${allSonarrSeries.length} Sonarr series`);

      // Build lookup maps by normalized title
      const existingRadarrByTitle = new Map<string, any>();
      for (const m of allRadarrMovies) {
        existingRadarrByTitle.set(m.title.toLowerCase(), m);
      }
      const existingSonarrByTitle = new Map<string, any>();
      for (const s of allSonarrSeries) {
        existingSonarrByTitle.set(s.title.toLowerCase(), s);
      }

      // Native (library_key) requests: matchable even when Radarr/Sonarr are down.
      const allNativeMovies = db.prepare(
        "SELECT id, title, library_key, status FROM media_requests WHERE type = 'movie' AND library_key IS NOT NULL"
      ).all() as any[];
      const allNativeSeries = db.prepare(
        "SELECT id, title, season, library_key, status FROM media_requests WHERE type = 'series' AND library_key IS NOT NULL"
      ).all() as any[];

      for (const torrent of newTorrents) {
        const parsed = parseTorrentName(torrent.name);
        const savePath = (fromQBittorrentPath(torrent.save_path) || "").toLowerCase();

        let type: "movie" | "series" = "movie";
        if (parsed.season !== null || /\bS\d{1,2}\b/.test(torrent.name) || /season/i.test(torrent.name)) {
          type = "series";
        } else if (/serial|season|episode|ep\d/i.test(torrent.name)) {
          type = "series";
        } else if (savePath.includes("serial") || savePath.includes("series") || savePath.includes("tv")) {
          type = "series";
        } else if (savePath.includes("film") || savePath.includes("movie")) {
          type = "movie";
        }

        const titleClean = torrent.name
          .replace(/\bS\d{1,2}(?:E\d{1,3}(?:[-–]\d{1,3})?)?\b/gi, "")
          .replace(/\bSeason\s*\d+\b/gi, "")
          .replace(/\b(?:1080p|2160p|720p|480p|BluRay|WEB-?DL|WEB-?RIP|HDRip|DVDRip|REMUX|x264|x265|HEVC|AAC|FLAC|DTS|AC3|\.mkv|\.mp4|\.avi)\b/gi, "")
          .replace(/[\[\]()]/g, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const lookupTitle = torrent.name
          .replace(/\bS\d{1,2}(?:E\d{1,3}(?:[-–]\d{1,3})?)?\b/gi, "")
          .replace(/\bSeason\s*\d+\b/gi, "")
          .replace(/\b(?:1080p|2160p|720p|480p|BluRay|WEB-?DL|WEB-?RIP|HDRip|DVDRip|REMUX|x264|x265|HEVC|AAC|FLAC|DTS|AC3|DDP?\.?5\.?1|ATMOS|EAC3|DOLBY|DUBBED|DUBBING|DUB|MULTI|NF|HDR10\+?|DV|10bit|H\.?26[45]|AV1|60fps|23\.976|25fps|DDP|DD)\b/gi, "")
          .replace(/\[.*?\]/g, " ")
          .replace(/[-–/\\]+/g, " ")
          .replace(/[._]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        try {
          const season = parsed.season || 1;
          const epStr = parsed.season !== null ? (parsed.episodes.length > 0 ? formatEpisodes(parsed) : `S${String(parsed.season).padStart(2, "0")}`) : '';
          const tNorm = normalizeTitleForMatch(titleClean);

          // Step 1: Try to match against existing Radarr/Sonarr entries
          let matchedRadarr: any = null;
          let matchedSonarr: any = null;

          if (type === "movie") {
            matchedRadarr = [...existingRadarrByTitle.values()].find((m: any) => {
              const mNorm = normalizeTitleForMatch(m.title);
              return titlesMatch(mNorm, tNorm);
            });
          } else if (type === "series") {
            matchedSonarr = [...existingSonarrByTitle.values()].find((s: any) => {
              if (deletedFranchiseIds?.has(s.id)) return false;
              const sNorm = normalizeTitleForMatch(s.title);
              return titlesMatch(sNorm, tNorm);
            });
          }

          // Step 1b: No arr match — fall back to existing native (library_key)
          // requests, so content already tracked arr-free gets its torrent
          // attached without needing Radarr/Sonarr at all.
          let nativeMatch: any = null;
          if (!matchedRadarr && !matchedSonarr) {
            // A torrent whose name pins a film's IMDb id belongs to exactly that
            // film. Without this veto, "Mufasa The Lion King (2024) [imdbid-
            // tt13186482]" gets attached to The Lion King (1994) on title
            // overlap alone, which then propagates into the processed panel.
            const tImdb = nameImdbId(torrent.name || "");
            if (type === "movie") {
              nativeMatch = allNativeMovies.find((m: any) => {
                const mine = tImdb ? requestImdbId(db, m) : null;
                if (tImdb && mine && tImdb !== mine) return false;
                const mNorm = normalizeTitleForMatch(m.title);
                return titlesMatch(mNorm, tNorm);
              }) || null;
            } else if (type === "series") {
              nativeMatch = allNativeSeries.find((s: any) => {
                const sNorm = normalizeTitleForMatch(s.title);
                return titlesMatch(sNorm, tNorm);
              }) || null;
            }
          }

          // Step 2: If no local match, use Sonarr/Radarr lookup — try all results until one validates
          let radarrId: number | null = null;
          let sonarrId: number | null = null;
          let matchedTitle = "";

          if (type === "movie" && !matchedRadarr && radarrProfileId) {
            try {
              const lookup = await radarr.lookupMovie(lookupTitle);
              for (const found of lookup) {
                const foundNorm = normalizeTitleForMatch(found.title);
                const altTitles = (found.alternativeTitles || found.alternateTitles || []).map((a: any) => normalizeTitleForMatch(a.title || ""));
                const allTitles = [foundNorm, ...altTitles];
                const matchFound = allTitles.some((t: string) => titlesMatch(t, tNorm));
                if (matchFound) {
                  const existingLocal = [...existingRadarrByTitle.values()].find((m: any) => m.tmdbId === found.tmdbId || m.title?.toLowerCase() === found.title?.toLowerCase());
                  if (existingLocal) {
                    radarrId = existingLocal.id;
                    matchedTitle = existingLocal.title;
                    matchedRadarr = existingLocal;
                    console.log(`[ScanDownloads] Matched lookup "${found.title}" to existing Radarr movie #${radarrId} "${matchedTitle}"`);
                    break;
                  }
                  try {
                    const added = await radarr.addMovie({
                      ...found,
                      qualityProfileId: radarrProfileId,
                      rootFolderPath: radarrRootPath,
                      monitored: true,
                      addOptions: { searchForMovie: false },
                    });
                    radarrId = added.id;
                    matchedTitle = found.title;
                    existingRadarrByTitle.set(found.title.toLowerCase(), added);
                    console.log(`[ScanDownloads] Created Radarr: ${found.title} (radarr_id=${added.id})`);
                  } catch (addErr: any) {
                    console.error(`[ScanDownloads] Radarr addMovie failed for "${found.title}": ${addErr.message}`);
                  }
                  break;
                }
              }
              if (!radarrId) {
                try {
                  const candidates = lookup.map((f: any) => ({
                    id: f.tmdbId || f.id,
                    title: f.title,
                    year: f.year,
                    overview: (f.overview || "").slice(0, 200),
                    normalized: normalizeTitleForMatch(f.title),
                  }));
                  db.prepare(`INSERT OR REPLACE INTO unmatched_torrents
                    (torrent_name, torrent_hash, save_path, type, size, lookup_title, candidate_results, skipped)
                    VALUES (?, ?, ?, 'movie', ?, ?, ?, 0)`)
                    .run(torrent.name, torrent.hash, fromQBittorrentPath(torrent.save_path), torrent.size || 0, lookupTitle, JSON.stringify(candidates));
                } catch {}
                const topTitles = lookup.slice(0, 3).map((f: any) => `${f.title} [${normalizeTitleForMatch(f.title)}]`).join(", ");
                console.log(`[ScanDownloads] No valid Radarr match for "${lookupTitle}" (tNorm="${tNorm}") (${lookup.length} results: ${topTitles})`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] Radarr lookup failed for "${lookupTitle}": ${err.message}`);
            }
          } else if (type === "movie" && !matchedRadarr && !radarrProfileId && !nativeMatch) {
            // Arr-less fallback: pre-fill candidates straight from TMDB so the
            // unmatched panel still offers pick buttons.
            try {
              const hits = (await searchTMDB(cleanFranchiseTitle(lookupTitle), "movie")) || [];
              const candidates = hits.map((f: any) => ({
                id: f.id,
                title: f.title,
                year: f.year,
                overview: f.overview,
                normalized: normalizeTitleForMatch(f.title),
              }));
              if (candidates.length > 0) {
                db.prepare(`INSERT OR REPLACE INTO unmatched_torrents
                  (torrent_name, torrent_hash, save_path, type, size, lookup_title, candidate_results, skipped)
                  VALUES (?, ?, ?, 'movie', ?, ?, ?, 0)`)
                  .run(torrent.name, torrent.hash, fromQBittorrentPath(torrent.save_path), torrent.size || 0, lookupTitle, JSON.stringify(candidates));
                console.log(`[ScanDownloads] (arr-less) TMDB movie candidates for "${lookupTitle}": ${candidates.length}`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] TMDB movie lookup failed for "${lookupTitle}": ${err.message}`);
            }
          } else if (type === "series" && !matchedSonarr && sonarrProfileId) {
            try {
              const lookup = await sonarr.lookupSeries(lookupTitle);
              for (const found of lookup) {
                const foundNorm = normalizeTitleForMatch(found.title);
                // Check main title and alternate titles (handles foreign-language torrents matching English Sonarr entries)
                const altTitles = (found.alternateTitles || []).map((a: any) => normalizeTitleForMatch(a.title || ""));
                const allTitles = [foundNorm, ...altTitles];
                const matchFound = allTitles.some((t: string) => titlesMatch(t, tNorm));
                if (matchFound) {
                  // Check if this series already exists in Sonarr (don't try to add duplicates)
                  const existingLocal = [...existingSonarrByTitle.values()].find((s: any) => s.tvdbId === found.tvdbId || s.title?.toLowerCase() === found.title?.toLowerCase());
                  if (existingLocal) {
                    sonarrId = existingLocal.id;
                    matchedTitle = existingLocal.title;
                    matchedSonarr = { ...existingLocal, alternateTitles: found.alternateTitles };
                    console.log(`[ScanDownloads] Matched lookup "${found.title}" to existing Sonarr series #${sonarrId} "${matchedTitle}"`);
                    break;
                  }
                  try {
                    const added = await sonarr.addSeries({
                      ...found,
                      qualityProfileId: sonarrProfileId,
                      path: sonarrRootPath ? `${sonarrRootPath}/${found.title}` : found.path,
                      monitored: true,
                      seasonFolder: true,
                      addOptions: { searchForMissingEpisodes: false },
                      seasons: (found.seasons || []).map((s: any) => ({ ...s, monitored: true })),
                    });
                    sonarrId = added.id;
                    matchedTitle = found.title;
                    existingSonarrByTitle.set(found.title.toLowerCase(), { id: added.id, title: found.title });
                    console.log(`[ScanDownloads] Created Sonarr: ${found.title} (sonarr_id=${added.id})`);
                  } catch (addErr: any) {
                    console.error(`[ScanDownloads] Sonarr addSeries failed for "${found.title}": ${addErr.message}`);
                  }
                  break;
                }
              }
              if (!sonarrId) {
                try {
                  const candidates = lookup.map((f: any) => ({
                    id: f.tvdbId || f.id,
                    title: f.title,
                    year: f.year,
                    overview: (f.overview || "").slice(0, 200),
                    normalized: normalizeTitleForMatch(f.title),
                  }));
                  db.prepare(`INSERT OR REPLACE INTO unmatched_torrents
                    (torrent_name, torrent_hash, save_path, type, size, lookup_title, candidate_results, skipped)
                    VALUES (?, ?, ?, 'series', ?, ?, ?, 0)`)
                    .run(torrent.name, torrent.hash, fromQBittorrentPath(torrent.save_path), torrent.size || 0, lookupTitle, JSON.stringify(candidates));
                } catch {}
                const topTitles = lookup.slice(0, 5).map((f: any) => `${f.title} [${normalizeTitleForMatch(f.title)}]`).join(", ");
                console.log(`[ScanDownloads] No valid Sonarr match for "${lookupTitle}" (tNorm="${tNorm}") (${lookup.length} results: ${topTitles})`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] Sonarr lookup failed for "${lookupTitle}": ${err.message}`);
            }
          } else if (type === "series" && !matchedSonarr && !sonarrProfileId && !nativeMatch) {
            // Arr-less fallback: pre-fill candidates straight from TMDB so the
            // unmatched panel still offers pick buttons.
            try {
              const hits = (await searchTMDB(cleanFranchiseTitle(lookupTitle), "series")) || [];
              const candidates = hits.map((f: any) => ({
                id: f.id,
                title: f.title,
                year: f.year,
                overview: f.overview,
                normalized: normalizeTitleForMatch(f.title),
              }));
              if (candidates.length > 0) {
                db.prepare(`INSERT OR REPLACE INTO unmatched_torrents
                  (torrent_name, torrent_hash, save_path, type, size, lookup_title, candidate_results, skipped)
                  VALUES (?, ?, ?, 'series', ?, ?, ?, 0)`)
                  .run(torrent.name, torrent.hash, fromQBittorrentPath(torrent.save_path), torrent.size || 0, lookupTitle, JSON.stringify(candidates));
                console.log(`[ScanDownloads] (arr-less) TMDB series candidates for "${lookupTitle}": ${candidates.length}`);
              }
            } catch (err: any) {
              console.error(`[ScanDownloads] TMDB series lookup failed for "${lookupTitle}": ${err.message}`);
            }
          }

          // Step 3: Create request + RC using matched entry
          if (type === "movie" && (matchedRadarr || radarrId)) {
            const finalRadarrId = matchedRadarr?.id || radarrId!;
            const title = matchedRadarr?.title || matchedTitle;
            const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ?").get(finalRadarrId) as any;
            if (!existingReq) {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, 'DOWNLOADING', '[]')"
              ).run(title, finalRadarrId);
              const requestId = result.lastInsertRowid as number;
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
              ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name));
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
              results.push({ title, status: "imported", type: "movie", request_id: Number(requestId) });
              console.log(`[ScanDownloads] Movie: ${title} (radarr_id=${finalRadarrId})`);
            } else {
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id, title, radarr_quality FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name));
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                console.log(`[ScanDownloads] Added RC for movie: ${title} (hash=${torrent.hash.slice(0, 12)})`);
              } else {
                const correctQuality = parseQualityFromName(torrent.name);
                if (existingRc.title !== torrent.name || existingRc.radarr_quality?.toLowerCase() === 'unknown') {
                  db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, existingRc.id);
                  console.log(`[ScanDownloads] Fixed RC ${existingRc.id}: title="${torrent.name}", quality="${correctQuality}"`);
                }
                const hasApproval = db.prepare("SELECT 1 FROM approval_history WHERE release_id = ? AND request_id = ?").get(existingRc.id, existingReq.id);
                if (!hasApproval) {
                  db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(existingRc.id, existingReq.id);
                  console.log(`[ScanDownloads] Backfilled approval for RC ${existingRc.id} (movie: ${title})`);
                }
              }
              results.push({ title, status: "skipped", type: "movie", error: "Already imported" });
            }
          } else if (type === "series" && (matchedSonarr || sonarrId)) {
            const finalSonarrId = matchedSonarr?.id || sonarrId!;
            if (deletedFranchiseIds?.has(finalSonarrId)) continue;
            const title = matchedSonarr?.title || matchedTitle;

            // Determine which seasons this torrent covers by scanning content_path
            const contentPath = fromQBittorrentPath(torrent.content_path) || "";
            const seasonDirs: number[] = [];
            if (contentPath && fs.existsSync(contentPath)) {
              const st = fs.statSync(contentPath);
              if (st.isDirectory()) {
                for (const entry of fs.readdirSync(contentPath)) {
                  const sn = parseSeasonNumber(entry);
                  if (sn !== null) seasonDirs.push(sn);
                }
              }
            }
            // Fall back to parsed season if no dirs found or content_path is a file
            const seasonsToCreate = seasonDirs.length > 0 ? seasonDirs : [season];

            for (const s of seasonsToCreate) {
              const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(finalSonarrId, s) as any;
              if (!existingReq) {
                const result = db.prepare(
                  "INSERT INTO media_requests (title, type, sonarr_id, status, season, requested_by) VALUES (?, 'series', ?, 'DOWNLOADING', ?, '[]')"
                ).run(title, finalSonarrId, s);
                const requestId = result.lastInsertRowid as number;
                const epStr2 = seasonDirs.length > 0 ? `S${String(s).padStart(2, "0")}` : epStr;
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
                ).run(requestId, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name), epStr2);
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
                results.push({ title, status: "imported", type: "series", request_id: Number(requestId) });
                console.log(`[ScanDownloads] Series: ${title} (sonarr_id=${finalSonarrId}, S${String(s).padStart(2, "0")})`);
              } else {
                if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                  db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
                }
                const existingRc = db.prepare("SELECT id, title, radarr_quality FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
                if (!existingRc) {
                  const rcResult = db.prepare(
                    "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
                  ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name), epStr);
                  db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
                  console.log(`[ScanDownloads] Added RC for series: ${title} (hash=${torrent.hash.slice(0, 12)}, S${String(s).padStart(2, "0")})`);
                } else {
                  const correctQuality = parseQualityFromName(torrent.name);
                  if (existingRc.title !== torrent.name || existingRc.radarr_quality?.toLowerCase() === 'unknown') {
                    db.prepare("UPDATE release_candidates SET title = ?, radarr_quality = ? WHERE id = ?").run(torrent.name, correctQuality, existingRc.id);
                    console.log(`[ScanDownloads] Fixed RC ${existingRc.id}: title="${torrent.name}", quality="${correctQuality}"`);
                  }
                  const hasApproval = db.prepare("SELECT 1 FROM approval_history WHERE release_id = ? AND request_id = ?").get(existingRc.id, existingReq.id);
                  if (!hasApproval) {
                    db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(existingRc.id, existingReq.id);
                    console.log(`[ScanDownloads] Backfilled approval for RC ${existingRc.id} (series: ${title})`);
                  }
                }
                results.push({ title, status: "skipped", type: "series", error: "Already imported" });
              }
            }
          } else if (type === "movie" && nativeMatch) {
            const title = nativeMatch.title;
            let existingReq = db.prepare(
              "SELECT id, status FROM media_requests WHERE library_key = ? AND type = 'movie'"
            ).get(nativeMatch.library_key) as any;
            if (!existingReq) {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, library_key, status, requested_by) VALUES (?, 'movie', ?, 'DOWNLOADING', '[]')"
              ).run(title, nativeMatch.library_key);
              existingReq = { id: result.lastInsertRowid as number, status: "DOWNLOADING" };
            } else if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
              db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
            }
            const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
            if (!existingRc) {
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
              ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name));
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
            }
            results.push({ title, status: "imported", type: "movie", request_id: Number(existingReq.id) });
            console.log(`[ScanDownloads] Movie (native): ${title} (key=${nativeMatch.library_key})`);
          } else if (type === "series" && nativeMatch) {
            const title = nativeMatch.title;
            const contentPath = fromQBittorrentPath(torrent.content_path) || "";
            const seasonDirs: number[] = [];
            if (contentPath && fs.existsSync(contentPath)) {
              const st = fs.statSync(contentPath);
              if (st.isDirectory()) {
                for (const entry of fs.readdirSync(contentPath)) {
                  const sn = parseSeasonNumber(entry);
                  if (sn !== null) seasonDirs.push(sn);
                }
              }
            }
            const seasonsToCreate = seasonDirs.length > 0 ? seasonDirs : [season];
            for (const s of seasonsToCreate) {
              const epStr2 = seasonDirs.length > 0 ? `S${String(s).padStart(2, "0")}` : epStr;
              let existingReq = db.prepare(
                "SELECT id, status FROM media_requests WHERE library_key = ? AND season = ?"
              ).get(nativeMatch.library_key, s) as any;
              if (!existingReq) {
                const result = db.prepare(
                  "INSERT INTO media_requests (title, type, library_key, season, status, requested_by) VALUES (?, 'series', ?, ?, 'DOWNLOADING', '[]')"
                ).run(title, nativeMatch.library_key, s);
                existingReq = { id: result.lastInsertRowid as number, status: "DOWNLOADING" };
              } else if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingReq.id);
              }
              const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(existingReq.id, torrent.hash) as any;
              if (!existingRc) {
                const rcResult = db.prepare(
                  "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, parsed_episodes) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?, ?)"
                ).run(existingReq.id, `qbit-${torrent.hash.slice(0, 12)}`, torrent.name, Math.round((torrent.size || 0) / (1024 * 1024)), torrent.hash, fromQBittorrentPath(torrent.save_path), parseQualityFromName(torrent.name), epStr2);
                db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, existingReq.id);
              }
              results.push({ title, status: "imported", type: "series", request_id: Number(existingReq.id) });
              console.log(`[ScanDownloads] Series (native): ${title} S${String(s).padStart(2, "0")} (key=${nativeMatch.library_key})`);
            }
          } else {
            results.push({ title: torrent.name, status: "no_match", type });
          }
        } catch (err: any) {
          console.error(`[ScanDownloads] Error processing ${torrent.name}:`, err.message);
          results.push({ title: torrent.name, status: "error", error: err.message });
        }
      }

      const imported = results.filter((r) => r.status === "imported").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const noMatch = results.filter((r) => r.status === "no_match").length;
      const errors = results.filter((r) => r.status === "error").length;
      console.log(`[ScanDownloads] Done: ${imported} imported, ${skipped} skipped, ${noMatch} no match, ${errors} errors (${allTorrents.length} total)`);

      res.json({ success: true, imported, skipped, noMatch, errors, total: allTorrents.length, results });
    } catch (error: any) {
      console.error("Error scanning downloads:", error);
      res.status(500).json({ error: `Failed to scan downloads: ${error.message}` });
    }
  });

  // POST /api/requests/scan-download-dirs - Read-only scan of the download
  // directories (DOWNLOADS_MOVIES/DOWNLOADS_TV) for content no longer tracked by
  // any qBittorrent torrent (e.g. after trackers/torrents were wiped). Reports
  // which entries still have a live torrent and which already exist in Processed
  // (by inode) so the user can attach / move / delete per item.
  router.post("/scan-download-dirs", async (req: Request, res: Response) => {
    try {
      let torrents: any[] = [];
      try {
        torrents = await qbittorrent.getTorrents();
      } catch {}

      const movieProcInodes = fs.existsSync(PROCESSED_MOVIES)
        ? collectVideoInodes(PROCESSED_MOVIES)
        : new Set<number>();
      const seriesProcInodes = fs.existsSync(PROCESSED_TV)
        ? collectVideoInodes(PROCESSED_TV)
        : new Set<number>();

      const items: any[] = [];

      const scanRoot = (root: string, type: string) => {
        if (!fs.existsSync(root)) return;
        const procInodes = type === "movie" ? movieProcInodes : seriesProcInodes;
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(root, e.name);

          let tracked = false;
          let trackedName = "";
          let trackedHash = "";
          for (const t of torrents) {
            const cp = t.content_path ? fromQBittorrentPath(t.content_path) : "";
            if (cp === full || cp.startsWith(full + path.sep)) {
              tracked = true;
              trackedName = t.name;
              trackedHash = t.hash || "";
              break;
            }
          }
          if (!tracked) {
            const want = normalizeTitleForMatch(e.name);
            for (const t of torrents) {
              const tn = normalizeTitleForMatch(t.name || "");
              if (tn && want && titlesMatch(want, tn)) {
                tracked = true;
                trackedName = t.name;
                trackedHash = t.hash || "";
                break;
              }
            }
          }

          const inodes = collectVideoInodes(full);
          let existsInProcessed = false;
          for (const ino of inodes) {
            if (procInodes.has(ino)) {
              existsInProcessed = true;
              break;
            }
          }

          const parsed = parseTorrentName(e.name);
          const matchedReq = findBestRequestForDownload(
            db,
            e.name,
            type,
            type === "series" && parsed.season != null ? parsed.season : null
          );

          // A torrent that is already wired to a release_candidate (e.g. via
          // attach/import/detect) counts as linked; the torrent panel shows.
          const linked = trackedHash
            ? !!db.prepare("SELECT 1 FROM release_candidates WHERE torrent_hash = ?").get(trackedHash)
            : false;

          items.push({
            type,
            name: e.name,
            path: full,
            isDir: e.isDirectory(),
            sizeMb: Math.round(dirSizeBytes(full) / (1024 * 1024)),
            tracked,
            trackedName,
            trackedHash,
            linked,
            existsInProcessed,
            videoCount: inodes.size,
            matchedRequest: matchedReq
              ? { id: matchedReq.id, title: matchedReq.title, season: matchedReq.season ?? null }
              : null,
          });
        }
      };

      scanRoot(DOWNLOADS_MOVIES, "movie");
      scanRoot(DOWNLOADS_TV, "series");

      items.sort(
        (a, b) =>
          (a.tracked ? 1 : 0) - (b.tracked ? 1 : 0) ||
          a.type.localeCompare(b.type) ||
          a.name.localeCompare(b.name)
      );

      res.json({ items, downloadRoots: { movies: DOWNLOADS_MOVIES, tv: DOWNLOADS_TV } });
    } catch (error: any) {
      console.error("Error scanning download dirs:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/scan-download-dirs/apply - Apply per-item actions chosen
  // in the UI for orphaned download entries:
//   attach            - add magnet/.torrent to qBittorrent (saves into the download root)
//   link              - wire an already-tracked torrent to the best-matching request
//   hardlink-process  - capture content into /Processed (no source deletion)
//   move-process      - rename content into /Processed (orphan becomes app-owned)
//   delete            - remove the download entry (requires exists-in-processed or force)
  router.post("/scan-download-dirs/apply", async (req: Request, res: Response) => {
    try {
      const bodyItems: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
      if (bodyItems.length === 0) return res.status(400).json({ error: "No items provided" });

      const results: any[] = [];

      for (const item of bodyItems) {
        const entryPath: string = item?.path;
        const action: string = item?.action;
        const force: boolean = !!item?.force;

        if (!entryPath || !action) {
          results.push({ path: entryPath || "?", action, ok: false, error: "Missing path or action" });
          continue;
        }
        const root = isWithinDownloadRoot(entryPath);
        if (!root) {
          results.push({ path: entryPath, action, ok: false, error: "Path is outside download directories" });
          continue;
        }
        if (!fs.existsSync(entryPath)) {
          results.push({ path: entryPath, action, ok: false, error: "Path no longer exists" });
          continue;
        }
        const type = root === DOWNLOADS_MOVIES ? "movie" : "series";

        try {
          if (action === "attach") {
            const magnetUrl: string = item?.magnet || "";
            const torrentBase64: string = item?.torrentFileBase64 || "";
            if (!magnetUrl && !torrentBase64) {
              results.push({ path: entryPath, action, ok: false, error: "Provide magnetUrl or torrentFileBase64" });
              continue;
            }
            const qbitSavePath = toQBittorrentPath(root);
            const preHashes = new Set((await qbittorrent.getTorrents()).map((t: any) => t.hash));

            if (magnetUrl) {
              await qbittorrent.addTorrent(magnetUrl, qbitSavePath);
            } else {
              const buf = Buffer.from(torrentBase64, "base64");
              await qbittorrent.addTorrentFile(buf, item?.torrentFilename || "attached.torrent", qbitSavePath);
            }

            // Poll qBittorrent for the newly added torrent (so we can link it).
            let newTorrent: any = null;
            for (let attempt = 0; attempt < 10; attempt++) {
              await new Promise((r) => setTimeout(r, 3000));
              const torrents = await qbittorrent.getTorrents();
              newTorrent = torrents.find((t: any) => !preHashes.has(t.hash)) || null;
              if (newTorrent) break;
            }

            const entryName = path.basename(entryPath);
            let linked: any = null;
            if (newTorrent) {
              linked = linkTorrentToRequest(db, newTorrent, entryName, type, root);
            }

            results.push({
              path: entryPath,
              action,
              ok: true,
              detail: magnetUrl ? "torrent added from magnet" : "torrent added from file",
              savePath: root,
              hash: newTorrent?.hash || "",
              linked: linked ? { requestId: linked.id, title: linked.title, existing: !!linked.existing } : null,
            });
          } else if (action === "link") {
            const torrents = await qbittorrent.getTorrents();
            let theTorrent: any = null;
            for (const t of torrents) {
              const cp = t.content_path ? fromQBittorrentPath(t.content_path) : "";
              if (cp === entryPath || cp.startsWith(entryPath + path.sep)) {
                theTorrent = t;
                break;
              }
            }
            if (!theTorrent) {
              results.push({ path: entryPath, action, ok: false, error: "No live torrent found for this entry" });
              continue;
            }
            const linked = linkTorrentToRequest(db, theTorrent, path.basename(entryPath), type, root);
            results.push({
              path: entryPath,
              action,
              ok: true,
              detail: linked ? (linked.existing ? "already linked" : "linked torrent to request") : "no matching request found",
              hash: theTorrent.hash || "",
              linked,
            });
          } else if (action === "hardlink-process" || action === "move-process") {
            const { destDir, base } = processedDestForEntry(entryPath, type);
            fs.mkdirSync(destDir, { recursive: true });
            if (action === "hardlink-process") {
              const dest = type === "movie"
                ? path.join(destDir, path.basename(entryPath))
                : path.join(destDir, base);
              if (fs.existsSync(dest)) {
                results.push({ path: entryPath, action, ok: false, error: `Destination already exists: ${dest}` });
                continue;
              }
              const count = hardlinkTree(entryPath, dest);
              results.push({ path: entryPath, action, ok: true, detail: `hardlinked ${count} file(s)`, dest });
            } else {
              // move-process
              const dest = type === "movie"
                ? path.join(destDir, path.basename(entryPath))
                : path.join(destDir, base);
              if (fs.existsSync(dest)) {
                results.push({ path: entryPath, action, ok: false, error: `Destination already exists: ${dest}` });
                continue;
              }
              fs.renameSync(entryPath, dest);
              results.push({ path: entryPath, action, ok: true, detail: "moved", dest });
            }
          } else if (action === "delete") {
            const inodes = collectVideoInodes(entryPath);
            const procInodes = type === "movie"
              ? (fs.existsSync(PROCESSED_MOVIES) ? collectVideoInodes(PROCESSED_MOVIES) : new Set<number>())
              : (fs.existsSync(PROCESSED_TV) ? collectVideoInodes(PROCESSED_TV) : new Set<number>());
            const existsInProcessed = [...inodes].some((ino) => procInodes.has(ino));
            if (!existsInProcessed && !force) {
              results.push({
                path: entryPath,
                action,
                ok: false,
                error: "Not found in Processed — refusing to delete without force (would lose data)",
              });
              continue;
            }
            fs.rmSync(entryPath, { recursive: true, force: true });
            results.push({ path: entryPath, action, ok: true, detail: "deleted" });
          } else {
            results.push({ path: entryPath, action, ok: false, error: `Unknown action: ${action}` });
          }
        } catch (err: any) {
          results.push({ path: entryPath, action, ok: false, error: err.message });
        }
      }

      res.json({ results });
    } catch (error: any) {
      console.error("Error applying download-dir actions:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/unmatched — list unmatched torrents awaiting user match
  router.get("/unmatched", (req: Request, res: Response) => {
    const rows = db.prepare(
      "SELECT * FROM unmatched_torrents WHERE matched_at IS NULL AND skipped = 0 ORDER BY created_at DESC"
    ).all();
    for (const r of rows as any[]) {
      try { r.candidate_results = JSON.parse(r.candidate_results || "[]"); } catch { r.candidate_results = []; }
    }
    res.json(rows);
  });

  // POST /api/requests/unmatched/:id/match — user picks a candidate
  router.post("/unmatched/:id/match", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { candidateIndex } = req.body;
      const row = db.prepare("SELECT * FROM unmatched_torrents WHERE id = ?").get(id) as any;
      if (!row) return res.status(404).json({ error: "Unmatched entry not found" });
      const candidates: any[] = typeof row.candidate_results === "string" ? JSON.parse(row.candidate_results) : row.candidate_results;
      const pick = candidates[candidateIndex];
      if (!pick) return res.status(400).json({ error: "Invalid candidate index" });

      // Fetch profiles
      const radarrProfiles = await radarr.getQualityProfiles().catch(() => []);
      const sonarrProfiles = await sonarr.getQualityProfiles().catch(() => []);
      const radarrRootFolders = await radarr.getRootFolders().catch(() => []);
      const sonarrRootFolders = await sonarr.getRootFolders().catch(() => []);
      const radarrProfileId = req.body.radarrProfileId || radarrProfiles[0]?.id;
      const sonarrProfileId = req.body.sonarrProfileId || sonarrProfiles[0]?.id;
      const radarrRootPath = radarrRootFolders[0]?.path || "";
      const sonarrRootPath = sonarrRootFolders[0]?.path || "";

      /** Native fallback: resolve the pick on TMDB and build a library_key. */
      const resolveNativeKey = async (): Promise<{ key: string; title: string } | null> => {
        const cleaned = cleanFranchiseTitle(pick.title);
        const hits = (await searchTMDB(cleaned, row.type === "movie" ? "movie" : "series")) || [];
        const resolved = hits.find((h: any) => h.id === pick.id) || hits[0];
        if (!resolved) return null;
        const prefix = row.type === "movie" ? "movie" : "series";
        return { key: `${prefix}:${slugForKeyTitle(resolved.title)}:${resolved.year ?? 0}`, title: cleaned };
      };

      if (row.type === "movie") {
        const radarrOk = !!(radarrProfileId && radarrRootPath);
        let native = !radarrOk;
        if (radarrOk) {
          try {
        const lookup = await radarr.lookupMovie(pick.title);
        const found = lookup.find((f: any) => f.tmdbId === pick.id || f.title?.toLowerCase() === pick.title?.toLowerCase());
        if (!found) throw new Error("Movie not found in Radarr lookup");
        // Check if already in Radarr
        const allMovies = await radarr.getAllMovies();
        const existingMovie = allMovies.find((m: any) => m.tmdbId === found.tmdbId || m.title?.toLowerCase() === found.title?.toLowerCase());
        let radarrId: number;
        if (existingMovie) {
          radarrId = existingMovie.id;
        } else {
          const added = await radarr.addMovie({
            ...found,
            qualityProfileId: radarrProfileId,
            rootFolderPath: radarrRootPath,
            monitored: true,
            addOptions: { searchForMovie: false },
          });
          radarrId = added.id;
        }
        // Create request + RC + approval
        const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ?").get(radarrId) as any;
        let requestId: number;
        if (existingReq) {
          requestId = existingReq.id;
          if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
            db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
          }
        } else {
          const result = db.prepare(
            "INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, 'DOWNLOADING', '[]')"
          ).run(pick.title, radarrId);
          requestId = result.lastInsertRowid as number;
        }
        const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(requestId, row.torrent_hash) as any;
        if (!existingRc) {
          const rcResult = db.prepare(
            "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
          ).run(requestId, `qbit-${row.torrent_hash.slice(0, 12)}`, row.torrent_name, Math.round((row.size || 0) / (1024 * 1024)), row.torrent_hash, row.save_path, parseQualityFromName(row.torrent_name));
          db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
        }
        db.prepare("UPDATE unmatched_torrents SET matched_at = datetime('now'), matched_id = ?, matched_title = ? WHERE id = ?").run(radarrId, pick.title, id);
            return res.json({ success: true, type: "movie", request_id: requestId, title: pick.title });
          } catch (err: any) {
            console.warn(`[Unmatched Match] Radarr path failed, falling back to native: ${err.message}`);
            native = true;
          }
        }
        if (native) {
          const r = await resolveNativeKey();
          if (!r) return res.status(400).json({ error: "Could not resolve movie on TMDB" });
          let existingReq = db.prepare("SELECT id, status FROM media_requests WHERE library_key = ? AND type = 'movie'").get(r.key) as any;
          let requestId: number;
          if (existingReq) {
            requestId = existingReq.id;
            if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
              db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
            }
          } else {
            const result = db.prepare(
              "INSERT INTO media_requests (title, type, library_key, status, requested_by) VALUES (?, 'movie', ?, 'DOWNLOADING', '[]')"
            ).run(r.title, r.key);
            requestId = result.lastInsertRowid as number;
          }
          const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(requestId, row.torrent_hash) as any;
          if (!existingRc) {
            const rcResult = db.prepare(
              "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
            ).run(requestId, `qbit-${row.torrent_hash.slice(0, 12)}`, row.torrent_name, Math.round((row.size || 0) / (1024 * 1024)), row.torrent_hash, row.save_path, parseQualityFromName(row.torrent_name));
            db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
          }
          db.prepare("UPDATE unmatched_torrents SET matched_at = datetime('now'), matched_id = ?, matched_title = ? WHERE id = ?").run(r.key, r.title, id);
          return res.json({ success: true, type: "movie", request_id: requestId, title: r.title, native: true });
        }
      } else if (row.type === "series") {
        // Series path
        const sonarrOk = !!(sonarrProfileId && sonarrRootPath);
        let native = !sonarrOk;
        if (sonarrOk) {
          try {
        const lookup = await sonarr.lookupSeries(pick.title);
        const found = lookup.find((f: any) => f.tvdbId === pick.id || f.title?.toLowerCase() === pick.title?.toLowerCase());
        if (!found) throw new Error("Series not found in Sonarr lookup");
        // Check if already in Sonarr
        const allSeries = await sonarr.getAllSeries();
        const existingSeries = allSeries.find((s: any) => s.tvdbId === found.tvdbId || s.title?.toLowerCase() === found.title?.toLowerCase());
        let sonarrId: number;
        if (existingSeries) {
          sonarrId = existingSeries.id;
        } else {
          const added = await sonarr.addSeries({
            ...found,
            qualityProfileId: sonarrProfileId,
            path: sonarrRootPath ? `${sonarrRootPath}/${found.title}` : found.path,
            monitored: true,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: false },
            seasons: (found.seasons || []).map((s: any) => ({ ...s, monitored: true })),
          });
          sonarrId = added.id;
        }
        // Detect multi-season packs by scanning content_path
        let seasonsToCreate: number[] = [];
        try {
          const torrents = await qbittorrent.getTorrents();
          const t = torrents.find((t2: any) => t2.hash === row.torrent_hash);
          if (t?.content_path) {
            const cp = fromQBittorrentPath(t.content_path);
            if (cp && fs.existsSync(cp) && fs.statSync(cp).isDirectory()) {
              for (const entry of fs.readdirSync(cp)) {
                const sn = parseSeasonNumber(entry);
                if (sn !== null) seasonsToCreate.push(sn);
              }
            }
          }
        } catch {}
        if (seasonsToCreate.length === 0) {
          const defaultSeason = req.body.season != null ? req.body.season : 1;
          seasonsToCreate = [defaultSeason];
        }
        const createdSeasons: number[] = [];
        for (const s of seasonsToCreate) {
          const existingReq = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND season = ?").get(sonarrId, s) as any;
          let requestId: number;
          if (existingReq) {
            requestId = existingReq.id;
            if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
              db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
            }
          } else {
            const result = db.prepare(
              "INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by) VALUES (?, 'series', ?, ?, 'DOWNLOADING', '[]')"
            ).run(pick.title, sonarrId, s);
            requestId = result.lastInsertRowid as number;
          }
          const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(requestId, row.torrent_hash) as any;
          if (!existingRc) {
            const rcResult = db.prepare(
              "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
            ).run(requestId, `qbit-${row.torrent_hash.slice(0, 12)}`, row.torrent_name, Math.round((row.size || 0) / (1024 * 1024)), row.torrent_hash, row.save_path, parseQualityFromName(row.torrent_name));
            db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
          }
          createdSeasons.push(s);
        }
        db.prepare("UPDATE unmatched_torrents SET matched_at = datetime('now'), matched_id = ?, matched_title = ? WHERE id = ?").run(sonarrId, pick.title, id);
            return res.json({ success: true, type: "series", seasons: createdSeasons, title: pick.title });
          } catch (err: any) {
            console.warn(`[Unmatched Match] Sonarr path failed, falling back to native: ${err.message}`);
            native = true;
          }
        }
        if (native) {
          const r = await resolveNativeKey();
          if (!r) return res.status(400).json({ error: "Could not resolve series on TMDB" });
          let seasonsToCreate: number[] = [];
          let createdSeasons: number[] = [];
          try {
            const torrents = await qbittorrent.getTorrents();
            const t = torrents.find((t2: any) => t2.hash === row.torrent_hash);
            if (t?.content_path) {
              const cp = fromQBittorrentPath(t.content_path);
              if (cp && fs.existsSync(cp) && fs.statSync(cp).isDirectory()) {
                for (const entry of fs.readdirSync(cp)) {
                  const sn = parseSeasonNumber(entry);
                  if (sn !== null) seasonsToCreate.push(sn);
                }
              }
            }
          } catch {}
          if (seasonsToCreate.length === 0) {
            const defaultSeason = req.body.season != null ? req.body.season : 1;
            seasonsToCreate = [defaultSeason];
          }
          for (const s of seasonsToCreate) {
            let existingReq = db.prepare("SELECT id, status FROM media_requests WHERE library_key = ? AND season = ?").get(r.key, s) as any;
            let requestId: number;
            if (existingReq) {
              requestId = existingReq.id;
              if (existingReq.status !== "DOWNLOADING" && existingReq.status !== "SEEDING") {
                db.prepare("UPDATE media_requests SET status = 'DOWNLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
              }
            } else {
              const result = db.prepare(
                "INSERT INTO media_requests (title, type, library_key, season, status, requested_by) VALUES (?, 'series', ?, ?, 'DOWNLOADING', '[]')"
              ).run(r.title, r.key, s);
              requestId = result.lastInsertRowid as number;
            }
            const existingRc = db.prepare("SELECT id FROM release_candidates WHERE request_id = ? AND torrent_hash = ?").get(requestId, row.torrent_hash) as any;
            if (!existingRc) {
              const rcResult = db.prepare(
                "INSERT INTO release_candidates (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality) VALUES (?, ?, ?, 'qBittorrent', ?, ?, ?, ?)"
              ).run(requestId, `qbit-${row.torrent_hash.slice(0, 12)}`, row.torrent_name, Math.round((row.size || 0) / (1024 * 1024)), row.torrent_hash, row.save_path, parseQualityFromName(row.torrent_name));
              db.prepare("INSERT INTO approval_history (release_id, request_id, approved_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(rcResult.lastInsertRowid, requestId);
            }
            createdSeasons.push(s);
          }
          db.prepare("UPDATE unmatched_torrents SET matched_at = datetime('now'), matched_id = ?, matched_title = ? WHERE id = ?").run(r.key, r.title, id);
          return res.json({ success: true, type: "series", seasons: createdSeasons, title: r.title, native: true });
        }
      } else {
        return res.status(400).json({ error: `Unsupported type: ${row.type}` });
      }
      return res.status(500).json({ error: "Match failed" });
    } catch (error: any) {
      console.error("[Unmatched Match] Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/unmatched/:id/skip — skip this unmatched entry
  router.post("/unmatched/:id/skip", (req: Request, res: Response) => {
    const { id } = req.params;
    db.prepare("UPDATE unmatched_torrents SET skipped = 1 WHERE id = ?").run(id);
    res.json({ success: true });
  });

  // GET /api/requests/discover?q=... — TMDB keyword search for the Discover
  // modal. Arr-free: purely TMDB, returns combined movie + series hits the
  // user can turn into native requests.
  router.get("/discover", async (req: Request, res: Response) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    try {
      const [movies, series] = await Promise.all([
        searchTMDB(q, "movie"),
        searchTMDB(q, "series"),
      ]);
      const results = [
        ...movies.map((m: any) => ({ type: "movie", id: m.id, title: m.title, year: m.year, overview: m.overview, poster: m.poster })),
        ...series.map((s: any) => ({ type: "series", id: s.id, title: s.title, year: s.year, overview: s.overview, poster: s.poster })),
      ];
      res.json({ results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/discover/tv/:tmdbId/seasons — season list for the picker.
  router.get("/discover/tv/:tmdbId/seasons", async (req: Request, res: Response) => {
    try {
      const seasons = await fetchTMDBTVSeasons(Number(req.params.tmdbId));
      res.json({ seasons });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/discover/request — create a native request from a
  // discovered TMDB title. Idempotent: returns the existing request when the
  // same library_key (movie) or key+season (series) is already tracked.
  router.post("/discover/request", (req: Request, res: Response) => {
    try {
      const { type, tmdbId, title, year, season } = req.body as {
        type?: string;
        tmdbId?: number;
        title?: string;
        year?: number;
        season?: number;
      };
      const mediaType = type === "series" ? "series" : "movie";
      if (!tmdbId || !title) return res.status(400).json({ error: "type, tmdbId and title required" });
      const cleaned = cleanFranchiseTitle(title);
      const key = `${mediaType}:${slugForKeyTitle(cleaned)}:${year ?? 0}`;
      const reqSeason = mediaType === "series" ? (Number.isFinite(season) ? season! : 1) : null;

      let existing: any;
      if (mediaType === "movie") {
        existing = db.prepare("SELECT id FROM media_requests WHERE library_key = ? AND type = 'movie'").get(key) as any;
      } else {
        existing = db.prepare("SELECT id FROM media_requests WHERE library_key = ? AND season = ?").get(key, reqSeason) as any;
      }
      if (existing) {
        console.log(`[Discover] Already tracked: ${cleaned} (request_id=${existing.id})`);
        return res.json({ success: true, request_id: Number(existing.id), existed: true, type: mediaType, title: cleaned });
      }

      let requestId: number;
      if (mediaType === "movie") {
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, library_key, status, requested_by) VALUES (?, 'movie', ?, 'NEW', '[]')"
        ).run(cleaned, key);
        requestId = result.lastInsertRowid as number;
      } else {
        const result = db.prepare(
          "INSERT INTO media_requests (title, type, library_key, season, status, requested_by) VALUES (?, 'series', ?, ?, 'NEW', '[]')"
        ).run(cleaned, key, reqSeason);
        requestId = result.lastInsertRowid as number;
      }
      console.log(`[Discover] Created ${mediaType} request ${requestId}: ${cleaned} (key=${key}, season=${reqSeason ?? "—"})`);
      res.json({ success: true, request_id: Number(requestId), existed: false, type: mediaType, title: cleaned });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/import-library - Scan Radarr/Sonarr library, hardlink files into processed dirs
  // GET /api/requests/library-audit - read-only reconciliation report.
  //
  // Walks the library and processed trees and reports what the import needs to
  // know before it writes anything. Deliberately writes nothing: the library
  // has inconsistent naming and the two trees overlap heavily, so the parse
  // has to be verified against real data before any rows are inserted.
  router.get("/library-audit", (_req: Request, res: Response) => {
    try {
      const lib = scanLibrary();
      const proc = scanProcessed();
      const dl = scanDownload();

      const libFiles: ScannedFile[] = [
        ...lib.movies.flatMap((m) => m.files),
        ...lib.shows.flatMap((s) => s.files),
      ];
      const procFiles: ScannedFile[] = [
        ...proc.movieFiles,
        ...proc.shows.flatMap((s) => s.files),
      ];
      const dlFiles: ScannedFile[] = [
        ...dl.movieFiles,
        ...dl.shows.flatMap((s) => s.files),
      ];

      // Hardlinked files share an inode, so that -- not the name -- is what
      // identifies "the same file" across the trees.
      const procByIno = new Map<number, string[]>();
      for (const f of procFiles) {
        const list = procByIno.get(f.ino);
        if (list) list.push(f.path);
        else procByIno.set(f.ino, [f.path]);
      }
      const libByIno = new Set(libFiles.map((f) => f.ino));
      const dlByIno = new Set(dlFiles.map((f) => f.ino));

      let libraryInProcessed = 0;
      let libraryOrphan = 0;
      for (const f of libFiles) {
        if (procByIno.has(f.ino)) libraryInProcessed++;
        else libraryOrphan++;
      }
      let processedInLibrary = 0;
      let processedNotInLibrary = 0;
      for (const f of procFiles) {
        if (libByIno.has(f.ino)) processedInLibrary++;
        else processedNotInLibrary++;
      }

      // Same basename but a different inode means two real copies on disk.
      // These are the ones worth surfacing -- name matching alone would treat
      // them as already imported and silently hide the duplication.
      const procByName = new Map<string, ScannedFile[]>();
      for (const f of procFiles) {
        const key = path.basename(f.path).toLowerCase();
        const list = procByName.get(key);
        if (list) list.push(f);
        else procByName.set(key, [f]);
      }
      const nameOnlyDuplicates: Array<{ name: string; library: string; processed: string[] }> = [];
      for (const f of libFiles) {
        const candidates = procByName.get(path.basename(f.path).toLowerCase());
        if (!candidates) continue;
        if (candidates.some((c) => c.ino === f.ino)) continue;
        nameOnlyDuplicates.push({
          name: path.basename(f.path),
          library: f.path,
          processed: candidates.map((c) => c.path),
        });
      }

      // How reliably season numbers resolve decides whether the series import
      // can be trusted.
      const seasonSources = { name: 0, folder: 0, specials: 0, unknown: 0 };
      for (const s of lib.shows) for (const f of s.files) seasonSources[f.seasonSource]++;

      const procSeasonSources = { name: 0, folder: 0, specials: 0, unknown: 0 };
      for (const s of proc.shows) for (const f of s.files) procSeasonSources[f.seasonSource]++;

      // Attribute library shows to processed shows by shared inode, not title.
      // The two trees use different naming: the library carries localized or
      // bilingual names ("Kacze opowieści - DuckTales 2017-2021 [Sezon 01-03]")
      // while processed keeps the original ("DuckTales"), and separators differ
      // too ("Avatar - The Last Airbender" vs "Avatar: The Last Airbender").
      // File overlap is immune to all of that.
      const procShowByIno = new Map<number, string>();
      for (const s of proc.shows) {
        for (const f of s.files) procShowByIno.set(f.ino, s.dir);
      }
      const showAttribution = lib.shows
        .map((s) => {
          const counts = new Map<string, number>();
          let matched = 0;
          for (const f of s.files) {
            const owner = procShowByIno.get(f.ino);
            if (owner) {
              matched++;
              counts.set(owner, (counts.get(owner) || 0) + 1);
            }
          }
          let best: string | null = null;
          let bestN = 0;
          for (const [dir, n] of counts) {
            if (n > bestN) {
              best = dir;
              bestN = n;
            }
          }
          return {
            library_dir: s.dir,
            library_title: s.title,
            imdb_id: s.imdbId,
            tvdb_id: s.tvdbId,
            files: s.files.length,
            matched_by_inode: matched,
            match_ratio: s.files.length ? Number((matched / s.files.length).toFixed(2)) : 0,
            best_processed_match: best,
            best_match_files: bestN,
          };
        })
        // Worst first: the shows that need attention are the unmatchable ones.
        .sort((a, b) => a.match_ratio - b.match_ratio);

      const movieAttribution = lib.movies
        .map((m) => ({
          library_dir: m.dir,
          title: m.title,
          year: m.year,
          imdb_id: m.imdbId,
          versions: m.files.length,
          matched_by_inode: m.files.filter((f) => procByIno.has(f.ino)).length,
        }))
        .sort((a, b) => a.matched_by_inode - b.matched_by_inode);

      const SAMPLE = 50;
      const moviesWithoutImdb = lib.movies.filter((m) => !m.imdbId).map((m) => m.dir);

      res.json({
        generated_at: new Date().toISOString(),
        library: {
          movie_folders: lib.movies.length,
          movie_files: lib.movies.reduce((n, m) => n + m.files.length, 0),
          movies_with_imdb_id: lib.movies.filter((m) => m.imdbId).length,
          movies_without_imdb_id: moviesWithoutImdb.length,
          movies_without_imdb_sample: moviesWithoutImdb.slice(0, SAMPLE),
          // Movie folders that hold no video directly inside them. Extras-only
          // or artwork-only folders get dropped by the scanner, so anything
          // listed here needs a look before import.
          movies_without_files: lib.movies.filter((m) => !m.files.length).map((m) => m.dir),
          series_shows: lib.shows.length,
          series_files: lib.shows.reduce((n, s) => n + s.files.length, 0),
          series_with_imdb_id: lib.shows.filter((s) => s.imdbId).length,
          series_with_tvdb_id: lib.shows.filter((s) => s.tvdbId).length,
          season_sources: seasonSources,
          unparsed_count: lib.unparsed.length,
          unparsed_sample: lib.unparsed.slice(0, SAMPLE),
        },
        processed: {
          movie_files: proc.movieFiles.length,
          series_shows: proc.shows.length,
          series_files: proc.shows.reduce((n, s) => n + s.files.length, 0),
          season_sources: procSeasonSources,
        },
        // Download is the source of truth but is read only (qBittorrent seeds
        // from it). A library file absent from processed but present here is
        // adoptable: hardlink it into processed and the chain is intact again.
        download: {
          movie_files: dl.movieFiles.length,
          series_shows: dl.shows.length,
          series_files: dl.shows.reduce((n, s) => n + s.files.length, 0),
          files_already_in_processed: dlFiles.filter((f) => procByIno.has(f.ino)).length,
          files_missing_from_processed: dlFiles.filter((f) => !procByIno.has(f.ino)).length,
        },
        // Per-show attribution, worst match ratio first. A high ratio means the
        // library and processed trees describe the same show and can be joined
        // without relying on titles at all.
        show_attribution: showAttribution,
        movie_attribution: movieAttribution,
        // The actionable set: library files that are not in processed yet. The
        // first group can be adopted by hardlinking, the second has no
        // processed or download origin at all and needs a human decision.
        adoption: {
          library_files_missing_from_processed: libraryOrphan,
          adoptable_from_download: libFiles.filter((f) => !procByIno.has(f.ino) && dlByIno.has(f.ino))
            .length,
          with_no_download_origin: libFiles.filter((f) => !procByIno.has(f.ino) && !dlByIno.has(f.ino))
            .length,
          no_download_origin_sample: libFiles
            .filter((f) => !procByIno.has(f.ino) && !dlByIno.has(f.ino))
            .slice(0, SAMPLE)
            .map((f) => f.path),
          movies_needing_adoption: lib.movies
            .filter((m) => m.files.some((f) => !procByIno.has(f.ino)))
            .map((m) => ({
              library_dir: m.dir,
              title: m.title,
              year: m.year,
              imdb_id: m.imdbId,
              versions: m.files.length,
              missing: m.files.filter((f) => !procByIno.has(f.ino)).length,
              available_in_download: m.files.filter((f) => dlByIno.has(f.ino)).length,
            })),
          shows_needing_adoption: lib.shows
            .filter((s) => s.files.some((f) => !procByIno.has(f.ino)))
            .map((s) => ({
              library_dir: s.dir,
              title: s.title,
              tvdb_id: s.tvdbId,
              files: s.files.length,
              missing: s.files.filter((f) => !procByIno.has(f.ino)).length,
              available_in_download: s.files.filter((f) => dlByIno.has(f.ino)).length,
            })),
        },
        overlap: {
          library_files_total: libFiles.length,
          processed_files_total: procFiles.length,
          library_files_already_in_processed: libraryInProcessed,
          library_files_not_in_processed: libraryOrphan,
          processed_files_already_in_library: processedInLibrary,
          processed_files_not_in_library: processedNotInLibrary,
          name_only_duplicate_count: nameOnlyDuplicates.length,
          name_only_duplicate_sample: nameOnlyDuplicates.slice(0, SAMPLE),
        },
        errors: [...lib.errors, ...proc.errors].slice(0, SAMPLE),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Hardlink library files that have no processed counterpart into processed.
   *
   * Dry run unless `apply: true`. Only creates new links under processed; never
   * modifies the library, processed or download contents, and never copies.
   */
  router.post("/adopt-into-processed", (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        apply?: boolean;
        includeUnbacked?: boolean;
        onlyMovies?: boolean;
        onlySeries?: boolean;
        showDirs?: string[];
        movieDirs?: string[];
      };
      const apply = body.apply === true;

      const plan = planAdoption({
        requireDownloadOrigin: body.includeUnbacked !== true,
        onlyMovies: body.onlyMovies,
        onlySeries: body.onlySeries,
        showDirs: body.showDirs,
        movieDirs: body.movieDirs,
      });

      if (!apply) {
        res.json({
          dry_run: true,
          totals: plan.totals,
          planned: plan.items.length,
          already_present: plan.alreadyPresent,
          conflicts: plan.conflicts,
          items: plan.items.slice(0, 200),
          truncated: plan.items.length > 200,
          errors: plan.errors,
        });
        return;
      }

      const result = executeAdoption(plan);
      // Register identity for the newly adopted processed links. Adoption
      // targets pre-app library files, so there's no request row in hand — the
      // identity is recovered from the processed path (title + Sxx) matched
      // against media_requests. Best-effort; adoption never fails on a miss.
      let registered = 0;
      for (const destPath of result.linked) {
        const id = autodetectIdentity(db, destPath);
        if (id) registered += registerVideoTree(db, destPath, id);
      }
      console.log(`[Identity] adopt-into-processed registered ${registered} file(s)`);
      res.json({
        applied: true,
        linked: result.linked.length,
        failed: result.failed,
        already_present: plan.alreadyPresent,
        conflicts: plan.conflicts,
        errors: plan.errors,
        sample: result.linked.slice(0, 50),
      });
    } catch (err: any) {
      console.error(`[Adopt-into-processed] failed:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /import-library/native - Arr-free library reconcile (dry run unless apply)
  // Scans the library tree, ensures a COMPLETED media_request per movie/series
  // season (keyed by our own library_key identity), and links each library file
  // to its processed counterpart by inode. Never touches active requests.
  router.post("/import-library/native", async (req: Request, res: Response) => {
    try {
      const apply = req.body?.apply === true;
      const plan = planLibraryImport(db);
      if (!apply) {
        return res.json({ dryRun: true, ...plan });
      }
      const result = executeLibraryImport(db, plan);
      // Register identity for created/adopted candidates: the library tree and
      // any associated processed links. Dormant-system reconciliation, so these
      // inodes are the ones every future read (and the Fix Names tool) resolves.
      for (const c of plan.candidates) {
        if (c.action !== "create" && c.action !== "adopt") continue;
        const id = { library_key: c.libraryKey, title: c.title, season: c.season ?? 0 };
        if (c.libraryDir) registerVideoTree(db, c.libraryDir, id);
        for (const rel of c.processedRelPaths || []) {
          const root = c.kind === "series" ? PROCESSED_TV : PROCESSED_MOVIES;
          registerVideoTree(db, path.join(root, rel), id);
        }
      }
      console.log(
        `[ImportLibrary] Reconcile done: ${result.totals.create} created, ${result.totals.adopt} adopted, ${result.totals.update} updated, ${result.totals.skip} skipped, ${result.filesAssociated} files associated`,
      );
      return res.json({ dryRun: false, ...plan, result });
    } catch (error: any) {
      console.error("Error in native library import:", error);
      res.status(500).json({ error: `Failed to import library: ${error.message}` });
    }
  });

  router.post("/import-library", async (req: Request, res: Response) => {
    try {
      const results: Array<{ title: string; status: string; path?: string; error?: string }> = [];
      const processedMoviesDir = PROCESSED_MOVIES;
      const processedTvDir = PROCESSED_TV;

      // Scan Radarr movies
      try {
        const movies = await radarr.getAllMovies();
        for (const m of movies) {
          if (!m.hasFile) continue;
          try {
            const movie = await radarr.getMovie(m.id);
            const filePath = movie.movieFile?.path;
            if (!filePath || !fs.existsSync(filePath)) {
              results.push({ title: m.title, status: "skipped", path: filePath, error: "file not found on disk" });
              continue;
            }
            const fileName = path.basename(filePath);
            const destPath = path.join(processedMoviesDir, fileName);
            // Dedup: check by inode across ALL files in processed dir (Radarr renames files)
            let alreadyImported = false;
            const srcIno = (() => { try { return fs.statSync(filePath).ino; } catch { return 0; } })();
            if (srcIno > 0) {
              for (const existing of fs.readdirSync(processedMoviesDir)) {
                try {
                  if (fs.statSync(path.join(processedMoviesDir, existing)).ino === srcIno) {
                    alreadyImported = true;
                    break;
                  }
                } catch {}
              }
            } else if (fs.existsSync(destPath)) {
              alreadyImported = true;
            }
            if (!alreadyImported) {
              fs.linkSync(filePath, destPath);
              console.log(`[ImportLibrary] Hardlinked ${fileName} → processed/filmy`);
              results.push({ title: m.title, status: "imported", path: destPath });
            } else {
              results.push({ title: m.title, status: "exists", path: filePath });
            }
          try {
            let req = db.prepare("SELECT id, status FROM media_requests WHERE radarr_id = ? AND type = 'movie'").get(m.id) as any;
            if (!req) {
              req = db.prepare("SELECT id, status FROM media_requests WHERE title = ? AND type = 'movie'").get(m.title) as any;
            }
            if (!req) {
              const result = db.prepare("INSERT INTO media_requests (title, type, radarr_id, status, requested_by) VALUES (?, 'movie', ?, 'COMPLETED', '[]')").run(m.title, m.id);
              console.log(`[ImportLibrary] Created media_request for ${m.title} (COMPLETED)`);
              req = { id: Number(result.lastInsertRowid), status: 'COMPLETED' };
            }
            if (req.status !== 'COMPLETED' && req.status !== 'DOWNLOADING' && req.status !== 'SEEDING') {
              db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(req.id);
              console.log(`[ImportLibrary] Updated ${m.title} status to COMPLETED (was ${req.status})`);
            }
            const processedFiles: string[] = [];
            // Add Radarr-managed file (skip if already in processed via MoveToProcessed)
            if (!alreadyImported && !processedFiles.includes(fileName)) processedFiles.push(fileName);
            // Also scan movie folder for additional video files not tracked by Radarr
            const movieFolder = movie.path || path.dirname(filePath);
            if (fs.existsSync(movieFolder)) {
              for (const entry of fs.readdirSync(movieFolder)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
                if (entry === fileName) continue; // already imported above
                const extraPath = path.join(movieFolder, entry);
                const extraDest = path.join(processedMoviesDir, entry);
                const extraIno = (() => { try { return fs.statSync(extraPath).ino; } catch { return 0; } })();
                let alreadyExtra = false;
                if (extraIno > 0) {
                  for (const existing of fs.readdirSync(processedMoviesDir)) {
                    try {
                      if (fs.statSync(path.join(processedMoviesDir, existing)).ino === extraIno) {
alreadyExtra = true;
                        break;
                      }
                    } catch {}
                  }
                } else if (fs.existsSync(extraDest)) {
                  alreadyExtra = true;
                }
                if (!alreadyExtra) {
                  try {
                    fs.linkSync(extraPath, extraDest);
                    console.log(`[ImportLibrary] Hardlinked extra ${entry} → processed/filmy`);
                  } catch (e2: any) {
                    console.error(`[ImportLibrary] Failed to hardlink extra ${entry}: ${e2.message}`);
                  }
                }
                if (!alreadyExtra && !processedFiles.includes(entry)) processedFiles.push(entry);
              }
            }
            const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(req.id) as any;
            if (ah) {
              const existing = JSON.parse(ah.processed_files || "[]");
              for (const pf of processedFiles) {
                if (!existing.includes(pf)) existing.push(pf);
              }
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
            } else {
              db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(req.id, JSON.stringify(processedFiles));
            }
          } catch (e: any) {
            console.error(`[ImportLibrary] Failed to associate ${m.title}:`, e.message);
          }
          } catch (e: any) {
            results.push({ title: m.title, status: "error", error: e.message });
          }
        }
      } catch (e: any) {
        results.push({ title: "(Radarr)", status: "error", error: `Failed to fetch movies: ${e.message}` });
      }

      // Helper: ensure media_requests exists for a series season, create COMPLETED if not
      function ensureSeriesRequest(sonarrId: number, seasonNum: number, title: string): number | null {
        let req = db.prepare("SELECT id, status FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND season = ?").get(sonarrId, seasonNum) as any;
        if (!req) {
          req = db.prepare("SELECT id, status FROM media_requests WHERE title LIKE ? AND type = 'series' AND season = ?").get(`%${title}%`, seasonNum) as any;
        }
        if (!req) {
          const result = db.prepare("INSERT INTO media_requests (title, type, sonarr_id, season, status, requested_by, episode_count) VALUES (?, 'series', ?, ?, 'COMPLETED', '[]', ?)").run(title, sonarrId, seasonNum, null);
          console.log(`[ImportLibrary] Created media_request for ${title} S${String(seasonNum).padStart(2, "0")} (COMPLETED)`);
          return Number(result.lastInsertRowid);
        }
        if (req.status !== 'COMPLETED' && req.status !== 'DOWNLOADING' && req.status !== 'SEEDING') {
          db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(req.id);
          console.log(`[ImportLibrary] Updated ${title} S${String(seasonNum).padStart(2, "0")} status to COMPLETED (was ${req.status})`);
        }
        return req.id;
      }

      // Scan Sonarr series
      try {
        const seriesList = await sonarr.getAllSeries();
        for (const s of seriesList) {
          try {
            const detail = await sonarr.getSeries(s.id);
            let seriesPath = detail.path;
            if (!seriesPath || !fs.existsSync(seriesPath)) {
              const mediaTv = MEDIA_TV;
              const fallback = path.join(mediaTv, path.basename(seriesPath || ""), s.title);
              const fallback2 = path.join(mediaTv, s.title);
              if (seriesPath && fs.existsSync(fallback)) seriesPath = fallback;
              else if (fs.existsSync(fallback2)) seriesPath = fallback2;
              else {
                // Fuzzy match: find a dir in MEDIA_TV containing the series title (case-insensitive)
                const titleLower = s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                try {
                  for (const entry of fs.readdirSync(mediaTv, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    const entryLower = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                    if (entryLower.includes(titleLower) || titleLower.includes(entryLower)) {
                      const candidate = path.join(mediaTv, entry.name);
                      seriesPath = candidate;
                      console.log(`[ImportLibrary] ${s.title}: fuzzy matched to "${entry.name}"`);
                      break;
                    }
                  }
                } catch {}
                if (!seriesPath || !fs.existsSync(seriesPath)) {
                  console.log(`[ImportLibrary] Skipping ${s.title}: Sonarr path "${detail.path}" not found on host`);
                  continue;
                }
              }
            }
            // Create series subfolder in processed
            const seriesDest = path.join(processedTvDir, s.title);
            if (!fs.existsSync(seriesDest)) fs.mkdirSync(seriesDest, { recursive: true });
            // Pre-create S00 folder for specials only if Sonarr has season 0
            const hasSpecials = detail.seasons?.some((sn: any) => Number(sn.seasonNumber) === 0);
            if (hasSpecials) {
              const specialsDest = path.join(seriesDest, "S00");
              if (!fs.existsSync(specialsDest)) {
                fs.mkdirSync(specialsDest, { recursive: true });
                console.log(`[ImportLibrary] Created S00 folder for ${s.title} (specials)`);
              }
            }
            const seriesEntries = fs.readdirSync(seriesPath, { withFileTypes: true });
            const seasonDirs = seriesEntries.filter(e => e.isDirectory() && parseSeasonNumber(e.name) !== null);
            let seriesFiles = 0;
            // Walk season dirs for video files
            for (const entry of seasonDirs) {
              const seasonNum = parseSeasonNumber(entry.name);
              const seasonDir = path.join(seriesPath, entry.name);
              const seasonDest = path.join(seriesDest, `S${String(seasonNum).padStart(2, "0")}`);
              if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
              for (const f of fs.readdirSync(seasonDir)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                seriesFiles++;
                const srcPath = path.join(seasonDir, f);
                const destPath = path.join(seasonDest, f);
                const relPath = path.join(s.title, `S${String(seasonNum).padStart(2, "0")}`, f);
                const alreadyImported = (() => {
                  if (!fs.existsSync(destPath)) return false;
                  try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
                })();
                if (!alreadyImported) {
                  try {
                    fs.linkSync(srcPath, destPath);
                    console.log(`[ImportLibrary] Hardlinked ${s.title} ${entry.name}/${f} → processed/serialy`);
                    results.push({ title: `${s.title} ${entry.name}/${f}`, status: "imported", path: destPath });
                  } catch (linkErr: any) {
                    console.error(`[ImportLibrary] Failed to hardlink ${s.title} ${entry.name}/${f}:`, linkErr.message);
                    results.push({ title: `${s.title} ${entry.name}/${f}`, status: "error", error: linkErr.message });
                    continue;
                  }
                }
                if (!alreadyImported) {
                  try {
                    const reqId = ensureSeriesRequest(s.id, seasonNum!, s.title);
                    if (reqId) {
                      const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                      if (ah) {
                        const existing = JSON.parse(ah.processed_files || "[]");
                        if (!existing.includes(relPath)) {
                          existing.push(relPath);
                          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
                        }
                      } else {
                        db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                      }
                    }
                  } catch (e: any) {
                    console.error(`[ImportLibrary] Failed to associate ${s.title} ${f}:`, e.message);
                  }
                }
              }
            }
            // Also handle video files directly in series root (no season subdirs)
            const rootVideoFiles = seriesEntries.filter(e => !e.isDirectory() && /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e.name));
            for (const vf of rootVideoFiles) {
              const seasonNum = parseSeasonNumber(vf.name) || 1;
              const srcPath = path.join(seriesPath, vf.name);
              const seasonDest = path.join(seriesDest, `S${String(seasonNum).padStart(2, "0")}`);
              if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
              const destPath = path.join(seasonDest, vf.name);
              const relPath = path.join(s.title, `S${String(seasonNum).padStart(2, "0")}`, vf.name);
              seriesFiles++;
              const alreadyImported = (() => {
                if (!fs.existsSync(destPath)) return false;
                try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
              })();
              if (!alreadyImported) {
                try {
                  fs.linkSync(srcPath, destPath);
                  console.log(`[ImportLibrary] Hardlinked ${s.title} root/${vf.name} → processed/serialy`);
                  results.push({ title: `${s.title} ${vf.name}`, status: "imported", path: destPath });
                } catch (linkErr: any) {
                  console.error(`[ImportLibrary] Failed to hardlink ${s.title} root/${vf.name}:`, linkErr.message);
                  results.push({ title: `${s.title} ${vf.name}`, status: "error", error: linkErr.message });
                }
              }
              if (!alreadyImported) {
                try {
                  const reqId = ensureSeriesRequest(s.id, seasonNum, s.title);
                  if (reqId) {
                    const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                    if (ah) {
                      const existing = JSON.parse(ah.processed_files || "[]");
                      if (!existing.includes(relPath)) { existing.push(relPath); db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id); }
                    } else {
                      db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                    }
                  }
                } catch {}
              }
            }
            // Also scan unmatched dirs that may contain video files (e.g. "Show S01 (720p)[Group]/")
            const unmatchedDirs = seriesEntries.filter(e => e.isDirectory() && !seasonDirs.includes(e));
            for (const ud of unmatchedDirs) {
              const udSeason = parseSeasonNumber(ud.name);
              if (udSeason === null) continue;
              const udPath = path.join(seriesPath, ud.name);
              const udFiles = (() => { try { return fs.readdirSync(udPath); } catch { return []; } })();
              for (const f of udFiles) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const seasonDest = path.join(seriesDest, `S${String(udSeason).padStart(2, "0")}`);
                if (!fs.existsSync(seasonDest)) fs.mkdirSync(seasonDest, { recursive: true });
                const srcPath = path.join(udPath, f);
                const destPath = path.join(seasonDest, f);
                const relPath = path.join(s.title, `S${String(udSeason).padStart(2, "0")}`, f);
                seriesFiles++;
                const alreadyImported = (() => {
                  if (!fs.existsSync(destPath)) return false;
                  try { return fs.statSync(srcPath).ino === fs.statSync(destPath).ino; } catch { return false; }
                })();
                if (!alreadyImported) {
                  try {
                    fs.linkSync(srcPath, destPath);
                    console.log(`[ImportLibrary] Hardlinked ${s.title} ${ud.name}/${f} → processed/serialy`);
                    results.push({ title: `${s.title} ${ud.name}/${f}`, status: "imported", path: destPath });
                  } catch (linkErr: any) {
                    console.error(`[ImportLibrary] Failed to hardlink ${s.title} ${ud.name}/${f}:`, linkErr.message);
                    results.push({ title: `${s.title} ${ud.name}/${f}`, status: "error", error: linkErr.message });
                  }
                }
                if (!alreadyImported) {
                  try {
                    const reqId = ensureSeriesRequest(s.id, udSeason, s.title);
                    if (reqId) {
                      const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(reqId) as any;
                      if (ah) {
                        const existing = JSON.parse(ah.processed_files || "[]");
                        if (!existing.includes(relPath)) { existing.push(relPath); db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id); }
                      } else {
                        db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(reqId, JSON.stringify([relPath]));
                      }
                    }
                  } catch {}
                }
              }
            }
            if (seasonDirs.length === 0) {
              const allDirs = seriesEntries.filter(e => e.isDirectory()).map(e => e.name);
              console.log(`[ImportLibrary] ${s.title}: path="${seriesPath}" — no S## dirs found. Dirs: [${allDirs.join(", ")}]`);
            } else if (seriesFiles === 0) {
              console.log(`[ImportLibrary] ${s.title}: ${seasonDirs.length} season dirs but 0 video files. Checking extensions...`);
              for (const sd of seasonDirs.slice(0, 2)) {
                const files = fs.readdirSync(path.join(seriesPath, sd.name));
                console.log(`[ImportLibrary]   ${sd.name}: [${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}] (${files.length} total)`);
              }
            } else {
              console.log(`[ImportLibrary] ${s.title}: ${seasonDirs.length} seasons, ${seriesFiles} video files`);
            }
            // Upgrade any remaining NEW/AWAITING_APPROVAL seasons for this series to COMPLETED
            try {
              const remaining = db.prepare("SELECT id, title, season, status FROM media_requests WHERE sonarr_id = ? AND type = 'series' AND status NOT IN ('COMPLETED', 'DOWNLOADING', 'SEEDING')").all(s.id) as any[];
              for (const r of remaining) {
                db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(r.id);
                console.log(`[ImportLibrary] Updated ${r.title} status to COMPLETED (was ${r.status})`);
              }
            } catch {}
          } catch (e: any) {
            results.push({ title: s.title, status: "error", error: e.message });
          }
        }
      } catch (e: any) {
        results.push({ title: "(Sonarr)", status: "error", error: `Failed to fetch series: ${e.message}` });
      }

      // Cleanup: remove flat video files in processed/serialy that are now inside subfolders (duplicates from first import)
      try {
        const topEntries = fs.readdirSync(processedTvDir, { withFileTypes: true });
        for (const te of topEntries) {
          if (te.isDirectory() || !/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(te.name)) continue;
          const flatPath = path.join(processedTvDir, te.name);
          const flatIno = (() => { try { return fs.statSync(flatPath).ino; } catch { return 0; } })();
          // Check if this file exists inside any series subfolder (same inode = duplicate)
          for (const se of topEntries) {
            if (!se.isDirectory()) continue;
            const seasonBase = path.join(processedTvDir, se.name);
            for (const sub of fs.readdirSync(seasonBase, { withFileTypes: true })) {
              if (!sub.isDirectory() || !/^S\d+$/i.test(sub.name)) continue;
              const seasonDir = path.join(seasonBase, sub.name);
              for (const f of fs.readdirSync(seasonDir)) {
                if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
                const subPath = path.join(seasonDir, f);
                const subIno = (() => { try { return fs.statSync(subPath).ino; } catch { return 0; } })();
                if (flatIno > 0 && flatIno === subIno) {
                  fs.unlinkSync(flatPath);
                  console.log(`[ImportLibrary] Cleaned up flat duplicate: ${te.name}`);
                  break;
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.error(`[ImportLibrary] Cleanup error:`, e.message);
      }

      // Cleanup: remove empty season dirs and series dirs in processed/serialy
      try {
        const topEntries2 = fs.readdirSync(processedTvDir, { withFileTypes: true });
        for (const se of topEntries2) {
          if (!se.isDirectory()) continue;
          const seriesDir = path.join(processedTvDir, se.name);
          const seasonDirs = fs.readdirSync(seriesDir, { withFileTypes: true }).filter(d => d.isDirectory() && /^S0*[1-9]\d*$/i.test(d.name));
          for (const sd of seasonDirs) {
            const seasonDir = path.join(seriesDir, sd.name);
            const hasFiles = fs.readdirSync(seasonDir).some(f => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f));
            if (!hasFiles) {
              fs.rmSync(seasonDir, { recursive: true, force: true });
              console.log(`[ImportLibrary] Removed empty season dir: ${se.name}/${sd.name}`);
            }
          }
          // Remove series dir if now empty
          if (fs.readdirSync(seriesDir).length === 0) {
            fs.rmSync(seriesDir, { recursive: true, force: true });
            console.log(`[ImportLibrary] Removed empty series dir: ${se.name}`);
          }
        }
      } catch (e: any) {
        console.error(`[ImportLibrary] Empty dir cleanup error:`, e.message);
      }

      const imported = results.filter(r => r.status === "imported").length;
      const exists = results.filter(r => r.status === "exists").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const errors = results.filter(r => r.status === "error").length;
      res.json({ imported, exists, skipped, errors, total: results.length, results });
    } catch (error: any) {
      console.error("Error importing library:", error);
      res.status(500).json({ error: `Failed to import library: ${error.message}` });
    }
  });

  // POST /api/requests/managed/:sonarrId/search-all - Search all seasons in parallel (SSE)
  router.post("/managed/:sonarrId/search-all", async (req: Request, res: Response) => {
    const sonarrId = Number(req.params.sonarrId);
    const forceAll = !!req.body?.force;
    const SKIP_MINUTES = 5;
    const cutoff = new Date(Date.now() - SKIP_MINUTES * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    const allSeasons = db.prepare(
      "SELECT id, season, title, type, last_searched_at FROM media_requests WHERE sonarr_id = ? AND type = 'series' ORDER BY season"
    ).all(sonarrId) as any[];

    if (allSeasons.length === 0) {
      return res.status(404).json({ error: "No seasons found for this franchise" });
    }

    const seasons = forceAll ? allSeasons : allSeasons.filter(
      (s) => !s.last_searched_at || s.last_searched_at < cutoff
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!process.env.PROWLARR_URL || !process.env.PROWLARR_API_KEY || !prowlarr) {
      send("error", { success: false, error: "Prowlarr is not configured — set PROWLARR_URL and PROWLARR_API_KEY" });
      send("done", { success: false, totalFound: 0, seasons: 0, errors: 1, skipped: allSeasons.length });
      res.end();
      return;
    }

    if (seasons.length === 0) {
      send("done", { success: true, totalFound: 0, seasons: 0, errors: 0, skipped: allSeasons.length });
      res.end();
      return;
    }

    const getSeasonData = (seasonId: number) => {
      const row = db.prepare(`
        SELECT mr.status, mr.episode_count,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           WHERE rc2.request_id = mr.id) as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3
           WHERE rc3.request_id = mr.id) as release_count
        FROM media_requests mr WHERE mr.id = ?
      `).get(seasonId) as any;
      return row || {};
    };

    const searchOneSeason = async (season: any): Promise<{ season: number; found: number; error?: string; data?: any }> => {
      const prevStatus = db.prepare("SELECT status FROM media_requests WHERE id = ?").get(season.id) as any;
      const preserveStatus = prevStatus?.status === "DOWNLOADING" || prevStatus?.status === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
      }

      let mappedCount = 0;
      try {
        const query = req.body?.searchTerm || season.title.replace(/\s+S\d+$/, "");
        const results = await Promise.race([
          prowlarr.search(query, [5000]),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), 45000)),
        ]);
          const allMapped = (results as any[]).map(mapProwlarrToRadarrResult);
          const targetSeason = season.season;
          const mapped = allMapped.filter((r: RadarrSearchResult) => {
            const title = (r.title || "").toUpperCase();
            // "_" is a word char, so "\bS" never matches an underscore-glued
            // season marker ("Show_S01E01") — look behind on alphanumerics only.
            const sMatch = title.match(/(?<![A-Za-z0-9])S(\d{1,2})(?:E\d|\b)/);
            if (sMatch) {
              return parseInt(sMatch[1], 10) === targetSeason;
            }
            return true;
          });
          mappedCount = mapped.length;

          const insertStmt = db.prepare(`
            INSERT INTO release_candidates
            (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
              title = excluded.title, indexer = excluded.indexer, size_mb = excluded.size_mb,
              radarr_quality = excluded.radarr_quality, app_score = excluded.app_score,
              seeders = excluded.seeders, leechers = excluded.leechers,
              torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END,
              info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END
          `);

          for (let i = 0; i < mapped.length; i++) {
            const r = mapped[i];
            const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
            const qualityName = r.quality?.quality?.name || "Unknown";
            const cfNames = r.customFormats?.map((f: any) => f.name) || [];
            insertStmt.run(season.id, r.guid, r.title, r.indexer, sizeMb, qualityName, JSON.stringify(cfNames), computeAppScore(qualityName, cfNames, sizeMb, i + 1), i + 1, r.languages?.map((l: any) => l.name).join(", ") || "", r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");
          }

          if (!preserveStatus) {
            db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
          }

        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        const data = getSeasonData(season.id);
        return { season: season.season, found: mappedCount, data };
      } catch (err: any) {
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        }
        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(season.id);
        const data = getSeasonData(season.id);
        return { season: season.season, found: 0, error: err.message, data };
      }
    };

    const CONCURRENCY = 3;
    const results: { season: number; found: number; error?: string; data?: any }[] = [];
    let idx = 0;

    const runNext = async (): Promise<void> => {
      while (idx < seasons.length) {
        const current = idx++;
        send("progress", { step: "searching", season: seasons[current].season, message: `Searching S${String(seasons[current].season).padStart(2, "0")}...` });
        const result = await searchOneSeason(seasons[current]);
        results.push(result);
        const label = result.error ? `error: ${result.error}` : `${result.found} releases`;
        send("found", {
          season: result.season,
          message: `S${String(result.season).padStart(2, "0")}: ${label}`,
          found: result.found,
          ...result.data,
        });
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, seasons.length) }, () => runNext());
    await Promise.all(workers);

    const totalFound = results.reduce((sum, r) => sum + r.found, 0);
    const totalErrors = results.filter(r => r.error).length;
    send("done", { success: true, totalFound, seasons: results.length, errors: totalErrors, skipped: allSeasons.length - seasons.length });
    console.log(`[SearchAll] sonarrId=${sonarrId}: ${totalFound} releases across ${results.length} seasons (${totalErrors} errors, ${allSeasons.length - seasons.length} skipped)`);
    res.end();
  });

  // POST /api/requests/managed/search-all-movies - Search all wanted movies in parallel (SSE)
  router.post("/managed/search-all-movies", async (req: Request, res: Response) => {
    const SKIP_MINUTES = 5;
    const cutoff = new Date(Date.now() - SKIP_MINUTES * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const forceAll = !!req.body?.force;

    const allMovies = db.prepare(
      "SELECT id, title, radarr_id, last_searched_at FROM media_requests WHERE type = 'movie' ORDER BY title"
    ).all() as any[];

    const movies = forceAll ? allMovies : allMovies.filter(
      (m) => !m.last_searched_at || m.last_searched_at < cutoff
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!process.env.PROWLARR_URL || !process.env.PROWLARR_API_KEY || !prowlarr) {
      send("error", { success: false, error: "Prowlarr is not configured — set PROWLARR_URL and PROWLARR_API_KEY" });
      send("done", { success: false, totalFound: 0, movies: 0, errors: 1, skipped: allMovies.length });
      res.end();
      return;
    }

    if (movies.length === 0) {
      send("done", { success: true, totalFound: 0, movies: 0, errors: 0, skipped: allMovies.length });
      res.end();
      return;
    }

    const getMovieData = (movieId: number) => {
      return db.prepare(`
        SELECT mr.status,
          (SELECT COALESCE(SUM(rc2.size_mb), 0) FROM release_candidates rc2
           JOIN approval_history ah2 ON ah2.release_id = rc2.id
            WHERE ah2.request_id = mr.id AND rc2.torrent_hash != '' AND mr.status != 'DOWNLOADING') as total_size_mb,
          (SELECT COUNT(*) FROM release_candidates rc3
           JOIN approval_history ah3 ON ah3.release_id = rc3.id
           WHERE ah3.request_id = mr.id AND rc3.torrent_hash != '' AND mr.status != 'DOWNLOADING') as release_count
         FROM media_requests mr WHERE mr.id = ?
      `).get(movieId) as any || {};
    };

    const searchOneMovie = async (movie: any): Promise<{ id: number; title: string; found: number; error?: string; data?: any }> => {
      const prevStatus = db.prepare("SELECT status FROM media_requests WHERE id = ?").get(movie.id) as any;
      const preserveStatus = prevStatus?.status === "DOWNLOADING" || prevStatus?.status === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
      }

      let mappedCount = 0;
      try {
        const query = req.body?.searchTerm || movie.title;
        const results = await Promise.race([
          prowlarr.search(query, [2000]),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), 45000)),
        ]);
          const mapped = (results as any[]).map(mapProwlarrToRadarrResult);
          mappedCount = mapped.length;

          const insertStmt = db.prepare(`
            INSERT INTO release_candidates
            (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
              title = excluded.title, indexer = excluded.indexer, size_mb = excluded.size_mb,
              radarr_quality = excluded.radarr_quality, app_score = excluded.app_score,
              seeders = excluded.seeders, leechers = excluded.leechers,
              torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END,
              info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END
          `);

          for (let i = 0; i < mapped.length; i++) {
            const r = mapped[i];
            const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
            const qualityName = r.quality?.quality?.name || "Unknown";
            const cfNames = r.customFormats?.map((f: any) => f.name) || [];
            insertStmt.run(movie.id, r.guid, r.title, r.indexer, sizeMb, qualityName, JSON.stringify(cfNames), computeAppScore(qualityName, cfNames, sizeMb, i + 1), i + 1, r.languages?.map((l: any) => l.name).join(", ") || "", r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");
          }

          if (!preserveStatus) {
            db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
          }

        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        const data = getMovieData(movie.id);
        return { id: movie.id, title: movie.title, found: mappedCount, data };
      } catch (err: any) {
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        }
        db.prepare("UPDATE media_requests SET last_searched_at = CURRENT_TIMESTAMP WHERE id = ?").run(movie.id);
        const data = getMovieData(movie.id);
        return { id: movie.id, title: movie.title, found: 0, error: err.message, data };
      }
    };

    const CONCURRENCY = 3;
    const results: { id: number; title: string; found: number; error?: string; data?: any }[] = [];
    let idx = 0;

    const runNext = async (): Promise<void> => {
      while (idx < movies.length) {
        const current = idx++;
        send("progress", { step: "searching", title: movies[current].title, message: `Searching "${movies[current].title}"...` });
        const result = await searchOneMovie(movies[current]);
        results.push(result);
        const label = result.error ? `error: ${result.error}` : `${result.found} releases`;
        send("found", { id: result.id, title: result.title, message: `"${result.title}": ${label}`, found: result.found, ...result.data });
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, movies.length) }, () => runNext());
    await Promise.all(workers);

    const totalFound = results.reduce((sum, r) => sum + r.found, 0);
    const totalErrors = results.filter(r => r.error).length;
    send("done", { success: true, totalFound, movies: results.length, errors: totalErrors, skipped: allMovies.length - movies.length });
    console.log(`[SearchAllMovies] ${totalFound} releases across ${results.length} movies (${totalErrors} errors, ${allMovies.length - movies.length} skipped)`);
    res.end();
  });

  // GET /api/workspaces/active - List all active workspaces across all requests
  router.get("/workspaces/active", async (req: Request, res: Response) => {
    try {
      const requests = db.prepare("SELECT id, title, type FROM media_requests").all() as any[];
      const allWorkspaces: any[] = [];
      for (const req2 of requests) {
        const ws = listWorkspaces(req2.id, req2.title);
        for (const w of ws) {
          allWorkspaces.push({
            ...w,
            requestId: req2.id,
            mediaTitle: req2.title,
            mediaType: req2.type,
          });
        }
      }
      res.json({ workspaces: allWorkspaces });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/workspaces/scan - Scan all workspace dirs, report orphaned/empty
  router.post("/workspaces/scan", async (req: Request, res: Response) => {
    try {
      const workspaceBase = PROCESSING_WORKSPACE;
      if (!fs.existsSync(workspaceBase)) return res.json({ workspaces: [], empty: true });

      const requests = db.prepare("SELECT id, title, type FROM media_requests").all() as any[];
      const requestMap = new Map<number, any>();
      for (const r of requests) requestMap.set(r.id, r);

      const entries = fs.readdirSync(workspaceBase, { withFileTypes: true });
      const results: any[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wsDir = path.join(workspaceBase, entry.name);
        const match = entry.name.match(/^(\d+)-/);
        const requestId = match ? parseInt(match[1], 10) : null;
        const request = requestId ? requestMap.get(requestId) : null;

        const inputsDir = path.join(wsDir, "inputs");
        const outputDir = path.join(wsDir, "output");
        const metaPath = path.join(wsDir, "metadata.json");

        let inputCount = 0;
        let outputCount = 0;
        let metadata: any = null;

        try { inputCount = fs.readdirSync(inputsDir).length; } catch {}
        try { outputCount = fs.readdirSync(outputDir).length; } catch {}
        try { metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}

        let status = "active";
        if (!request) status = "orphaned";
        else if (inputCount === 0 && outputCount === 0) status = "empty";

        results.push({
          dirName: entry.name,
          path: wsDir,
          requestId,
          requestTitle: request?.title || null,
          requestType: request?.type || null,
          inputCount,
          outputCount,
          metadata,
          status,
        });
      }

      res.json({ workspaces: results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/workspaces/cleanup - Delete orphaned/empty workspace dirs
  router.post("/workspaces/cleanup", async (req: Request, res: Response) => {
    try {
      const { dirNames } = req.body as { dirNames?: string[] };
      if (!dirNames || !Array.isArray(dirNames) || dirNames.length === 0) {
        return res.status(400).json({ error: "dirNames array required" });
      }

      const workspaceBase = PROCESSING_WORKSPACE;
      let deleted = 0;
      const errors: string[] = [];

      for (const name of dirNames) {
        const dirPath = path.join(workspaceBase, name);
        if (!dirPath.startsWith(workspaceBase)) continue;
        if (!fs.existsSync(dirPath)) continue;
        try {
          deleteWorkspace(dirPath);
          deleted++;
        } catch (err: any) {
          errors.push(`${name}: ${err.message}`);
        }
      }

      res.json({ deleted, errors });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/reactivate - Re-activate a single DISMISSED request
  router.post("/:id/reactivate", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.status !== "DISMISSED") {
        return res.status(400).json({ error: "Request is not dismissed", status: request.status });
      }
      const hasApproved = db.prepare(
        "SELECT 1 FROM approval_history WHERE request_id = ? LIMIT 1"
      ).get(id);
      const newStatus = hasApproved ? "DOWNLOADING" : "NEW";
      db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newStatus, id);
      console.log(`[Reactivate] Re-activated ${request.title} → ${newStatus}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error reactivating request:", error);
      res.status(500).json({ error: "Failed to reactivate request" });
    }
  });

  // GET /api/requests/db/:table - View raw table data for debugging.
  // All non-sqlite_ tables are browsable (validated against sqlite_master so
  // the name can never reach the query raw); read-only.
  router.get("/db/:table", (req: Request, res: Response) => {
    const table = req.params.table;
    const realTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map((r: any) => r.name);
    if (!realTables.includes(table)) {
      return res.status(400).json({ error: `Invalid table. Available: ${realTables.join(", ")}` });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      // rowid keeps this working for tables without an id column
      // (tmdb_season_cache, tmdb_franchise_prefs are keyed by composite PKs).
      const query = `SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT ? OFFSET ?`;
      const rows = db.prepare(query).all(limit, offset) as any[];
      const total = db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as any;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      res.json({ table, columns, rows, total: total.c, limit, offset });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/:id", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const stmt = db.prepare("SELECT * FROM media_requests WHERE id = ?");
      const request = stmt.get(id) as any;
      
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      request.requested_by = JSON.parse(request.requested_by || "[]");
      // The TMDB language preference is keyed by library_key, so movies carry it
      // too — without it the client cannot preselect the language dropdown.
      request.language = request.library_key ? franchiseLanguage(db, request.library_key) : null;

      // Get all approved releases
      const approvedRows = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? ORDER BY ah.approved_at DESC"
      ).all(id) as any[];
      const approved_releases = approvedRows.length > 0 ? parseReleases(approvedRows) : [];
      const approvedIds = new Set(approved_releases.map((r: any) => r.id));

      // Get all releases, excluding approved ones
      const releaseStmt = db.prepare("SELECT * FROM release_candidates WHERE request_id = ? ORDER BY radarr_rank ASC");
      const allReleases = parseReleases(releaseStmt.all(id));
      const releases = allReleases.filter((r: any) => !approvedIds.has(r.id));

      res.json({ ...request, releases, approved_releases });
    } catch (error) {
      console.error("Error fetching request:", error);
      res.status(500).json({ error: "Failed to fetch request" });
    }
  });

  // GET /api/requests/:id/episodes - arr-free season episode grid (TMDB metadata
  // with on-disk coverage). Falls back to file-derived gaps when no metadata.
  router.get("/:id/episodes", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.type !== "series") {
        return res.json({ type: "movie", season: null, episodes: [], covered: [], metadata: null });
      }
      const season = request.season ?? 0;
      const covered = coveredEpisodesForRequest(db, request);
      // Present files with no parseable episode number (e.g. S00 movies like
      // "Candace Against the Universe") — TMDB has no special entry, but the
      // file is there and should show as FILLED.
      const baseTitle = cleanFranchiseTitle(request.title || "");
      const extras: { name: string }[] = [];
      let seasonFolder: string | null = null;
      try {
        seasonFolder = seasonFolderForLibraryKey(db, request.library_key, baseTitle, season);
        if (seasonFolder) {
          for (const f of fs.readdirSync(seasonFolder)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            if (extractEpisodeFromFilename(f) == null) {
              const row = identifyByPath(db, path.join(seasonFolder, f));
              if (row && row.role === "numbered") continue;
              extras.push({ name: f.replace(/\.[^.]+$/, "") });
            }
          }
        }
      } catch {}
      let meta: SeasonMeta | null = null;
      if (request.library_key) {
        try {
          meta = await fetchTMDBSeason(db, request.library_key, season, baseTitle, {
            language: franchiseLanguage(db, request.library_key),
            altTitle: seasonFolder ? path.basename(path.dirname(seasonFolder)) : null,
          });
        } catch (err: any) {
          console.error(`[TMDB] episode fetch failed for request ${id}: ${err.message}`);
        }
      }
let episodes: any[];
      if (meta) {
        episodes = meta.episodes.map((ep: any) => ({ ...ep, present: covered.has(ep.episode_number) }));
        const metaNums = new Set(meta.episodes.map((e: any) => e.episode_number));
        for (const n of covered) {
          if (!metaNums.has(n)) episodes.push({ episode_number: n, name: "", air_date: null, present: true });
        }
        episodes.sort((a, b) => a.episode_number - b.episode_number);
      } else {
        const max = covered.size ? Math.max(...covered) : 0;
        episodes = [];
        for (let n = 1; n <= max; n++) {
          episodes.push({ episode_number: n, name: "", air_date: null, present: covered.has(n) });
        }
      }
      // Specials grids: drop TMDB's unnamed "Episode N" mirror entries unless
      // the episode is actually present on disk (they're structure noise).
      if (season === 0) {
        episodes = episodes.filter(
          (ep: any) => ep.present || ((ep.name || "").trim() !== "" && !/^episode\s*\d+$/i.test(ep.name))
        );
      }
      res.json({
        type: "series",
        season,
        title: baseTitle,
        library_key: request.library_key,
        episodes,
        extras,
        covered: Array.from(covered).sort((a, b) => a - b),
        metadata: meta
          ? { tmdb_show_id: meta.tmdb_show_id, show_name: meta.show_name, resolvedVia: meta.resolvedVia, source: "tmdb" }
          : null,
      });
    } catch (error) {
      console.error("Error fetching request episodes:", error);
      res.status(500).json({ error: "Failed to fetch episodes" });
    }
  });

  // GET /api/requests/native-franchise/:id - arr-free franchise overview: all
  // seasons grouped by the library_key of a seed request, each with file-derived
  // coverage. Episodes themselves come from GET /:id/episodes on expand.
  router.get("/native-franchise/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const rows = db
        .prepare("SELECT * FROM media_requests WHERE type = 'series' AND library_key = ? AND status != 'DISMISSED' ORDER BY COALESCE(season, 0)")
        .all(seed.library_key) as any[];
      if (!rows.length) return res.status(404).json({ error: "No seasons for this franchise" });
      const titleSeason = rows.find((r: any) => r.season !== 0) || rows[0];
      const title = cleanFranchiseTitle(titleSeason.title);
      const seasons = rows.map((s: any) => {
        const baseTitle = cleanFranchiseTitle(s.title || "");
        const covered = coveredEpisodesForRequest(db, s);
        const extras = unnumberedFilesInSeasonFolder(db, baseTitle, s.season ?? 0, libraryKeyYear(s.library_key));
        let fileCount = 0;
        try {
          const folder = seasonFolderForLibraryKey(db, s.library_key, baseTitle, s.season ?? 0);
          if (folder) {
            fileCount = fs.readdirSync(folder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)).length;
          }
        } catch {}
        return {
          season: s.season,
          request_id: s.id,
          status: s.status,
          title: s.title,
          episode_count:
            s.season === 0
              ? nativeSpecialDenominator(db, s.library_key, baseTitle, covered, extras)
              : s.sonarr_id == null
                ? nativeSeasonDenominator(db, s.library_key, s.season ?? 0, covered, extras, s.episode_count)
                : s.episode_count,
          covered_episodes: Array.from(covered).sort((a, b) => a - b),
          extras,
          file_count: fileCount,
        };
      });
      // Inject seasons present on disk when no media_request row exists (the
      // processed structure is authoritative; e.g. episodes loose in the library
      // root got imported as Specials, or a season exists disk-first).
      const franchiseYear = libraryKeyYear(seed.library_key);
      const existingSeasons = new Set(seasons.map((s: any) => s.season));
      const fallbackShowDir = processedShowDirFromFiles(db, rows.map((r: any) => r.id)) ?? showDirByStructure(rows.map((r: any) => r.season ?? 0), title);
      const diskSeasons = diskSeasonFolders(title, franchiseYear, fallbackShowDir);
      for (const [sn, files] of diskSeasons) {
        if (existingSeasons.has(sn)) continue;
        let tmdbCount = 0;
        try {
          const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ?").get(seed.library_key, sn) as any;
          if (tc) tmdbCount = (JSON.parse(tc.payload)?.episodes || []).length || 0;
        } catch {}
        const coveredEps = new Set<number>();
        let extras = 0;
        for (const f of files) {
          const epNums = episodeNumsFromFilename(f);
          if (epNums.length) for (const n of epNums) coveredEps.add(n);
          else extras++;
        }
        seasons.push({
          season: sn,
          request_id: null,
          status: null,
          title,
          episode_count: Math.max(tmdbCount, coveredEps.size + extras),
          covered_episodes: Array.from(coveredEps).sort((a, b) => a - b),
          extras,
          file_count: files.length,
        });
        existingSeasons.add(sn);
      }
      // Specials with no request row: inject from cached TMDB season-0, or
      // actively fetch it when the show has an S00 folder on disk (even empty —
      // Death in Paradise, The Smurfs, Ninjago all keep placeholder S00 grips).
      if (!existingSeasons.has(0)) {
        let tmdbSpecials = 0;
        try {
          const tc = db.prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = 0").get(seed.library_key) as any;
          if (tc) tmdbSpecials = namedSpecialCount(tc.payload);
        } catch {}
        if (tmdbSpecials === 0 && seasonFolderOnDisk(title, 0, franchiseYear, fallbackShowDir)) {
          try {
            const meta = await fetchTMDBSeason(db, seed.library_key, 0, title, {
              language: franchiseLanguage(db, seed.library_key),
              altTitle: fallbackShowDir ? path.basename(fallbackShowDir) : null,
            });
            if (meta) tmdbSpecials = namedSpecialCount(JSON.stringify(meta));
          } catch {}
        }
        if (tmdbSpecials > 0) {
          seasons.push({
            season: 0,
            request_id: null,
            status: null,
            title,
            episode_count: tmdbSpecials,
            covered_episodes: [],
            extras: 0,
            file_count: 0,
          });
          existingSeasons.add(0);
        }
      }
      // Same arr-free season enumeration as the dashboard's native branch, so
      // the two never disagree about how many seasons a show has.
      if (seed.library_key) {
        const showId = cachedShowIdForKey(db, seed.library_key);
        if (showId) {
          let tmdbSeasonList: Array<{ season_number: number; episode_count: number }> = [];
          try {
            tmdbSeasonList = await seasonListForShow(showId, franchiseLanguage(db, seed.library_key));
          } catch {}
          for (const sn of tmdbSeasonList) {
            if (existingSeasons.has(sn.season_number)) continue;
            seasons.push({
              season: sn.season_number,
              request_id: null,
              status: null,
              title,
              episode_count: sn.episode_count || 0,
              covered_episodes: [],
              extras: 0,
              file_count: 0,
            });
            existingSeasons.add(sn.season_number);
          }
        }
      }
      seasons.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0));
      res.json({ library_key: seed.library_key, title: franchiseDisplayTitle(title, seed.library_key), language: franchiseLanguage(db, seed.library_key), seasons });
    } catch (error) {
      console.error("Error fetching native franchise:", error);
      res.status(500).json({ error: "Failed to fetch native franchise" });
    }
  });

  // GET /api/requests/native-franchise/:id/episodes - episode grid for a native
  // (arr-free) franchise season that has no media_request row yet (injected
  // Specials). Mirrors /:id/episodes keyed by library_key + season.
  router.get("/native-franchise/:id/episodes", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const season = parseInt(req.query.season as string, 10);
      const sNum = Number.isFinite(season) && season >= 0 ? season : 0;
      const baseTitle = cleanFranchiseTitle(seed.title || "");
      const covered = coveredEpisodesForRequest(db, { id: -1, title: baseTitle, season: sNum, episode_count: null, library_key: seed.library_key } as any);
      const extras: { name: string }[] = [];
      let seasonFolder: string | null = null;
      try {
        seasonFolder = seasonFolderForLibraryKey(db, seed.library_key, baseTitle, sNum);
        if (seasonFolder) {
          for (const f of fs.readdirSync(seasonFolder)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            if (extractEpisodeFromFilename(f) == null) {
              const row = identifyByPath(db, path.join(seasonFolder, f));
              if (row && row.role === "numbered") continue;
              extras.push({ name: f.replace(/\.[^.]+$/, "") });
            }
          }
        }
      } catch {}
      let meta: SeasonMeta | null = null;
      try {
        meta = await fetchTMDBSeason(db, seed.library_key, sNum, baseTitle, {
          language: franchiseLanguage(db, seed.library_key),
          altTitle: seasonFolder ? path.basename(path.dirname(seasonFolder)) : null,
        });
      } catch (err: any) {
        console.error(`[TMDB] native season episode fetch failed for ${seed.library_key} S${sNum}: ${err.message}`);
      }
      let episodes: any[];
      if (meta) {
        episodes = meta.episodes.map((ep: any) => ({ ...ep, present: covered.has(ep.episode_number) }));
        const metaNums = new Set(meta.episodes.map((e: any) => e.episode_number));
        for (const n of covered) {
          if (!metaNums.has(n)) episodes.push({ episode_number: n, name: "", air_date: null, present: true });
        }
        episodes.sort((a, b) => a.episode_number - b.episode_number);
      } else {
        const max = covered.size ? Math.max(...covered) : 0;
        episodes = [];
        for (let n = 1; n <= max; n++) {
          episodes.push({ episode_number: n, name: "", air_date: null, present: covered.has(n) });
        }
      }
      // Specials grids: drop TMDB's unnamed "Episode N" mirror entries unless
      // the episode is actually present on disk.
      if (sNum === 0) {
        episodes = episodes.filter(
          (ep: any) => ep.present || ((ep.name || "").trim() !== "" && !/^episode\s*\d+$/i.test(ep.name))
        );
      }
      res.json({
        type: "series",
        season: sNum,
        title: baseTitle,
        library_key: seed.library_key,
        episodes,
        extras,
        covered: Array.from(covered).sort((a, b) => a - b),
        metadata: meta
          ? { tmdb_show_id: meta.tmdb_show_id, show_name: meta.show_name, resolvedVia: meta.resolvedVia, source: "tmdb" }
          : null,
      });
    } catch (error: any) {
      console.error("Error fetching native season episodes:", error.message || error);
      res.status(500).json({ error: "Failed to fetch native season episodes" });
    }
  });

  // POST /api/requests/:id/refresh-metadata - force re-fetch season metadata from TMDB
  router.post("/:id/refresh-metadata", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.type !== "series" || !request.library_key) {
        return res.status(400).json({ error: "No library_key to refresh" });
      }
      const season = request.season ?? 0;
      const cleanTitle = cleanFranchiseTitle(request.title || "");
      let seasonFolder: string | null = null;
      try {
        seasonFolder = seasonFolderForLibraryKey(db, request.library_key, cleanTitle, season);
      } catch {}
      const meta = await fetchTMDBSeason(db, request.library_key, season, cleanTitle, {
        language: franchiseLanguage(db, request.library_key),
        force: true,
        altTitle: seasonFolder ? path.basename(path.dirname(seasonFolder)) : null,
      });
      // TMDB having no entry for this season is a normal answer (most shows
      // have no S00), not an outage — and this route runs on every language
      // change for whichever season is expanded, so a 5xx here rolled the whole
      // language switch back in the UI while the pref itself had already saved.
      // Only an unconfigured key is worth reporting as unavailable.
      if (!meta && !isTmdbConfigured()) {
        return res.status(502).json({ error: "TMDB metadata unavailable (no API key or network)" });
      }
      res.json({
        refreshed: true,
        available: !!meta,
        metadata: meta ? { tmdb_show_id: meta.tmdb_show_id, show_name: meta.show_name, resolvedVia: meta.resolvedVia, source: "tmdb" } : null,
      });
    } catch (error) {
      console.error("Error refreshing metadata:", error);
      res.status(500).json({ error: "Failed to refresh metadata" });
    }
  });

  // POST /api/requests/native-franchise/:id/refresh?season=N - force-refetch TMDB
  // metadata for an injected (request-id-less) native season.
  router.post("/native-franchise/:id/refresh", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const season = parseInt(req.query.season as string, 10);
      const sNum = Number.isFinite(season) && season >= 0 ? season : 0;
      const baseTitle = cleanFranchiseTitle(seed.title || "");
      const seedRows = db.prepare("SELECT id, season FROM media_requests WHERE type = 'series' AND library_key = ?").all(seed.library_key) as any[];
      const seedYear = libraryKeyYear(seed.library_key);
      const seedShowDir = processedShowDirFromFiles(db, seedRows.map((r: any) => r.id)) ?? showDirByStructure(seedRows.map((r: any) => r.season ?? 0), baseTitle);
      let seedSeasonFolder: string | null = null;
      try {
        seedSeasonFolder = findSeasonFolder(baseTitle, sNum, seedYear) ?? (seedShowDir && fs.existsSync(path.join(PROCESSED_TV, seedShowDir, `S${String(sNum).padStart(2, "0")}`)) ? path.join(PROCESSED_TV, seedShowDir, `S${String(sNum).padStart(2, "0")}`) : null);
      } catch {}
      const meta = await fetchTMDBSeason(db, seed.library_key, sNum, baseTitle, {
        language: franchiseLanguage(db, seed.library_key),
        force: true,
        altTitle: seedShowDir ? path.basename(seedShowDir) : seedSeasonFolder ? path.basename(path.dirname(seedSeasonFolder)) : null,
      });
      if (!meta && !isTmdbConfigured()) {
        return res.status(502).json({ error: "TMDB metadata unavailable (no API key or network)" });
      }
      res.json({ refreshed: true, season: sNum, available: !!meta });
    } catch (error: any) {
      console.error("Error refreshing native season metadata:", error.message || error);
      res.status(500).json({ error: "Failed to refresh metadata" });
    }
  });

  // POST /api/requests/native-franchise/:id/fix-identity - repair a native
  // franchise's library_key. Keys minted from unparsed release names carry junk
  // slugs and a zero year (e.g. series:tajemnica-sagali-264-al3x:0). Re-resolve
  // the show on TMDB from the cleaned title and rewrite the key to the canonical
  // `series:<tvdbId|imdbId|slug>:<year>`, anchoring on the TVDB id the canonical
  // dir names embed so the key no longer rides a localized title slug (the movie
  // counterpart anchors on the IMDb id for the same reason). Migrates every
  // dependent row (requests, TMDB cache, language pref, and the identity layer's
  // media_files). No-op when already canonical, refuses when another franchise
  // already owns the target key.
  router.post("/native-franchise/:id/fix-identity", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(400).json({ error: "Series request with library_key required" });
      }
      const oldKey = seed.library_key;
      const lang = franchiseLanguage(db, oldKey) || process.env.TMDB_LANGUAGE || "en-US";
      const cleaned = cleanFranchiseTitle(seed.title || "");
      let resolved = await resolveShowIdentity(oldKey, cleaned, lang);
      let usedDiskTitle = false;
      if (!resolved) {
        const rows = db.prepare("SELECT id, season FROM media_requests WHERE library_key = ? AND type = 'series'").all(oldKey) as any[];
        const showDir = processedShowDirFromFiles(db, rows.map((r: any) => r.id)) ?? showDirByStructure(rows.map((r: any) => r.season ?? 0));
        if (showDir) {
          resolved = await resolveShowIdentity(oldKey, path.basename(showDir), lang);
          usedDiskTitle = true;
        }
      }
      if (!resolved) {
        return res.json({ fixed: false, old_key: oldKey, new_key: null, reason: "unresolved on TMDB" });
      }
      const applied = await applySeriesIdentity(db, oldKey, { name: resolved.name, year: resolved.year, tmdbId: resolved.id }, lang);
      if ("error" in applied) {
        return res.status(applied.status).json({ fixed: false, old_key: oldKey, new_key: null, reason: applied.error });
      }
      res.json({
        fixed: true,
        old_key: oldKey,
        new_key: applied.newKey,
        resolved: { id: resolved.id, name: resolved.name, year: resolved.year, via: usedDiskTitle ? `${resolved.via}+disk` : resolved.via },
      });
    } catch (error: any) {
      console.error("Error fixing franchise identity:", error.message || error);
      res.status(500).json({ error: "Failed to fix franchise identity" });
    }
  });

  // GET /api/requests/native-franchise/:id/identity-candidates - shows this
  // franchise could be, for the explicit "Re-attach" control. The series mirror
  // of the movie route: searches every spelling the card could be found by (the
  // readable stored title AND the lossy key slug), merging both, and accepts a
  // free-text `?q=` because TMDB indexes a show under its ORIGINAL name.
  router.get("/native-franchise/:id/identity-candidates", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed) return res.status(404).json({ error: "Request not found" });
      if (seed.type !== "series" || !seed.library_key) {
        return res.status(400).json({ error: "Native series request with library_key required" });
      }
      const lang = franchiseLanguage(db, seed.library_key) || process.env.TMDB_LANGUAGE || "en-US";
      const fromTitle = cleanFranchiseTitle(seed.title || "");
      const fromKey = cleanFranchiseTitle(
        String(seed.library_key).replace(/^series:/, "").replace(/:\d{4}$/, "").replace(/-/g, " "),
      );
      const manual = String(req.query.q || "").trim();
      const queries = Array.from(
        new Set((manual ? [manual] : [fromTitle, fromKey]).map((q) => q.trim()).filter((q) => q.length > 1)),
      );
      const seen = new Set<number>();
      const candidates: any[] = [];
      for (const q of queries) {
        const hits = await searchTMDB(q, "series", lang).catch(() => []);
        for (const hit of hits || []) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          candidates.push(hit);
        }
      }
      res.json({ query: fromTitle || fromKey || "", searched: queries, current_key: seed.library_key, candidates });
    } catch (error: any) {
      console.error("Error listing series identity candidates:", error.message || error);
      res.status(500).json({ error: "Failed to list identity candidates" });
    }
  });

  // POST /api/requests/native-franchise/:id/retitle - the user picked the show.
  // The series mirror of the movie route: rewrites `title` (the mangled input
  // that caused the bad identity) alongside the key, across every season row.
  router.post("/native-franchise/:id/retitle", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const tmdbId = Number(req.body?.tmdbId);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: "tmdbId is required" });
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed) return res.status(404).json({ error: "Request not found" });
      if (seed.type !== "series" || !seed.library_key) {
        return res.status(400).json({ error: "Native series request with library_key required" });
      }
      const oldKey = seed.library_key;
      const lang = franchiseLanguage(db, oldKey) || process.env.TMDB_LANGUAGE || "en-US";
      const info = await fetchTMDBById("series", tmdbId, lang);
      if (!info?.title) return res.status(404).json({ error: `TMDB has no series ${tmdbId}` });
      const applied = await applySeriesIdentity(db, oldKey, { name: info.title, year: info.year, tmdbId }, lang, {
        alsoSetTitle: true,
      });
      if ("error" in applied) {
        return res.status(applied.status).json({ fixed: false, old_key: oldKey, new_key: null, reason: applied.error });
      }
      res.json({ fixed: true, old_key: oldKey, new_key: applied.newKey, title: info.title, resolved: info });
    } catch (error: any) {
      console.error("Error retitling series:", error.message || error);
      res.status(500).json({ error: "Failed to retitle series" });
    }
  });

  // POST /api/requests/:id/fix-identity - the movie counterpart of the native
  // franchise repair above. Movie keys are minted from the same unparsed release
  // names, so they carry junk slugs and zero years too
  // (movie:niekonczaca-sie-opowiesc-ii-264-al3x:0). Re-resolve on TMDB and
  // rewrite to `movie:<slug>:<year>`, migrating every dependent row.
  //
  // Unlike the series repair the slug comes from the RESOLVED TMDB name rather
  // than the stored one: a movie's key is what Fix Names mints the canonical
  // filename and folder from, so keying it off the mangled Polish row title
  // would only relocate the junk.
/** Rewrite a movie's identity across every dependent row, then repopulate the
 *  external-id cache under the new key. Never touches the filesystem. */
/** The middle segment of a movie `library_key`: the IMDb id when one is known,
 *  else the title slug. The id is the deterministic anchor -- `imdbIdOwnerKey`
 *  resolves a file's embedded `[imdbid-tt...]` straight to the key that owns it,
 *  and the folder veto reads it -- so it wins whenever it is available. Returns
 *  null for anything that is not a real IMDb id, which is how a bad value falls
 *  back to the slug instead of minting a nonsense key. */
function movieKeySegment(name: string, imdbId: string | null | undefined): string {
  if (imdbId && /^tt\d{6,}$/i.test(imdbId.trim())) return imdbId.trim().toLowerCase();
  return slugForKeyTitle(name);
}

async function applyMovieIdentity(
  db: Database,
  oldKey: string,
  resolved: { name: string; year: number | null; tmdbId?: number },
  lang: string,
  opts?: { alsoSetTitle?: boolean },
): Promise<{ newKey: string } | { error: string; status: number }> {
  const slug = slugForKeyTitle(resolved.name);
  if (!slug || slug.length < 3) {
    return { error: `Could not build a key from "${resolved.name}"`, status: 400 };
  }
  // Fresh resolution only -- never the old key's cached id, which belongs to
  // whatever film that key used to name, which is exactly what a repair disputes.
  let imdbId: string | null = null;
  if (resolved.tmdbId) {
    const ids = await fetchExternalIds("movie", resolved.tmdbId, lang).catch(() => null);
    if (ids?.imdbId) imdbId = ids.imdbId;
  }
  // No id from TMDB (a film it has none for, or a lookup that failed) falls back to
  // the slug, which still round-trips: requestImdbId() reads the cache this function
  // repopulates below, so a slug-keyed request is not left without an id.
  const newKey = `movie:${movieKeySegment(resolved.name, imdbId)}:${resolved.year ?? 0}`;
  // Re-attaching to the film the key ALREADY names is not a no-op: the stored
  // title is a separate column and is frequently still mangled ("Hobbit" beside
  // movie:the-hobbit-an-unexpected-journey:2012). That title is what card
  // matching reads, so leaving it behind would preserve the exact misattribution
  // the repair was for.
  if (newKey === oldKey && !opts?.alsoSetTitle) return { error: "already canonical", status: 200 };
  // A clash only counts when ANOTHER film holds the key. When newKey === oldKey the
  // request's own row is the sole holder, and re-attaching to the film it already
  // names is precisely the legitimate case (the key was repaired while the stored
  // title stayed mangled) — counting itself there made every such repair 409.
  const clash =
    (db
      .prepare("SELECT COUNT(*) c FROM media_requests WHERE type = 'movie' AND library_key = ? AND library_key != ?")
      .get(newKey, oldKey) as any)?.c || 0;
  if (clash > 0) {
    // Two DIFFERENT films claiming one key is the misattribution this whole
    // feature exists to prevent, so never merge them silently.
    return { error: `Key ${newKey} is already in use by another movie — not overwriting`, status: 409 };
  }
  db.transaction(() => {
    if (opts?.alsoSetTitle) {
      db.prepare("UPDATE media_requests SET title = ?, library_key = ? WHERE library_key = ? AND type = 'movie'").run(
        resolved.name,
        newKey,
        oldKey,
      );
    } else {
      db.prepare("UPDATE media_requests SET library_key = ? WHERE library_key = ? AND type = 'movie'").run(newKey, oldKey);
    }
    db.prepare("UPDATE tmdb_season_cache SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    db.prepare("UPDATE tmdb_franchise_prefs SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    // The identity layer must move WITH the key. media_files is keyed by
    // (dev, inode) and every read is inode-first, so a row left on the old key
    // keeps claiming the file for a library_key no request owns any more: after
    // a re-attach the file vanished from its own card ("Nothing to rename in this
    // layer") while still sitting in /Processed, because the row resolved to the
    // dead key. It also blocks the rename itself - a registered row is an
    // absolute veto in Fix Names. Re-attaching is a statement that these inodes
    // belong to the new film, so the attribution follows.
    db.prepare("UPDATE media_files SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    // The stale row must NOT follow the key across: it holds the pre-fix
    // resolved title, so the next preview would keep printing it. Drop it and
    // let the repopulate below write the correct one instead.
    db.prepare("DELETE FROM tmdb_external_ids WHERE library_key = ?").run(oldKey);
  })();
  // Re-resolve under the NEW key so the cache carries the post-fix title AND the
  // IMDb id. Seeding it is not optional: requestImdbId reads this table first,
  // and a slug-keyed row for a localized movie ("Niekonczaca sie opowiesc III"
  // -> movie:the-neverending-story-iii:1994) can find no id in its key or its
  // stored title, so without this the request silently loses the id that the
  // folder veto and the canonical name both depend on.
  await resolveExternalIds(db, newKey, "movie", resolved.name, lang, { ignoreCache: true }).catch(() => null);
  return { newKey };
}

/** The middle segment of a series `library_key`: the TVDB id when known (the
 *  canonical `[tvdbid-####]` convention the dir names embed), then the IMDb id,
 *  else the title slug. The series mirror of `movieKeySegment`, but a series
 *  anchors on TVDB rather than IMDb. A slug is a LOSSY artifact of a title, so
 *  it is the last resort and is built from the RESOLVED name -- never the stored
 *  row title, which is routinely localized ("Kacze opowiesci" used to mint a
 *  Polish slug). Returns null for anything unusable, so the caller can refuse. */
function seriesKeySegment(name: string, tvdbId: string | null | undefined, imdbId: string | null | undefined): string | null {
  const tv = tvdbId != null ? String(tvdbId).trim() : "";
  if (/^\d+$/.test(tv)) return tv;
  const im = imdbId != null ? imdbId.trim() : "";
  if (/^tt\d{6,}$/i.test(im)) return im.toLowerCase();
  const slug = slugForKeyTitle(name);
  return slug && slug.length >= 3 ? slug : null;
}

/** Rewrite a series franchise's identity across every dependent row, then
 *  repopulate the external-id cache under the new key. Never touches the
 *  filesystem. Mirrors `applyMovieIdentity`, with two series-specific pieces:
 *  the TVDB-first key segment, and the `media_files` migration (a series repair
 *  that skipped it orphaned every registered inode until a read re-registered
 *  it). `alsoSetTitle` is the Re-attach path. */
async function applySeriesIdentity(
  db: Database,
  oldKey: string,
  resolved: { name: string; year: number | null; tmdbId?: number },
  lang: string,
  opts?: { alsoSetTitle?: boolean },
): Promise<{ newKey: string } | { error: string; status: number }> {
  let tvdbId: string | null = null;
  let imdbId: string | null = null;
  if (resolved.tmdbId) {
    const ids = await fetchExternalIds("series", resolved.tmdbId, lang).catch(() => null);
    if (ids) {
      tvdbId = ids.tvdbId;
      imdbId = ids.imdbId;
    }
  }
  const seg = seriesKeySegment(resolved.name, tvdbId, imdbId);
  if (!seg) return { error: `Could not build a key from "${resolved.name}"`, status: 400 };
  const newKey = `series:${seg}:${resolved.year ?? 0}`;
  // Re-attaching to the show the key ALREADY names is not a no-op when the
  // stored title differs (the mangled title is what card matching reads), and
  // because the id segment wins, an already id-anchored key is a no-op here --
  // that is what stops a repair from DOWNGRADING a TVDB key to a slug.
  if (newKey === oldKey && !opts?.alsoSetTitle) return { error: "already canonical", status: 200 };
  // A clash only counts when ANOTHER franchise holds the key; when newKey ===
  // oldKey this row's own seasons are the sole holders.
  const clash =
    (db
      .prepare("SELECT COUNT(*) c FROM media_requests WHERE type = 'series' AND library_key = ? AND library_key != ?")
      .get(newKey, oldKey) as any)?.c || 0;
  if (clash > 0) {
    return { error: `Key ${newKey} is already in use by another franchise — not overwriting`, status: 409 };
  }
  db.transaction(() => {
    if (opts?.alsoSetTitle) {
      db.prepare("UPDATE media_requests SET title = ?, library_key = ? WHERE library_key = ? AND type = 'series'").run(
        resolved.name,
        newKey,
        oldKey,
      );
    } else {
      db.prepare("UPDATE media_requests SET library_key = ? WHERE library_key = ? AND type = 'series'").run(newKey, oldKey);
    }
    db.prepare("UPDATE tmdb_season_cache SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    // An episode ORDER was picked from the show this key named at the time. A
    // re-attach can point the key at a DIFFERENT show, and keeping the group
    // would read that show's "Season 1" under our episode numbers from then
    // on — so the pref is dropped only when the show actually changed, and the
    // season cache goes with it: every payload in it was fetched under the
    // order that just died, and episodeTitleFromCache never re-checks the pref.
    const pref = db
      .prepare("SELECT episode_group_show_id FROM tmdb_franchise_prefs WHERE library_key = ?")
      .get(oldKey) as any;
    // resolved.tmdbId can be missing (a title-only resolution) — then nothing
    // can prove a mismatch, and fetchTMDBSeason's own guard clears it on the
    // next fetch instead of dropping a possibly-valid order here.
    if (pref?.episode_group_show_id && resolved.tmdbId && pref.episode_group_show_id !== resolved.tmdbId) {
      db.prepare("DELETE FROM tmdb_season_cache WHERE library_key = ?").run(newKey);
      db.prepare("UPDATE tmdb_franchise_prefs SET episode_group_id = NULL, episode_group_show_id = NULL WHERE library_key = ?").run(newKey);
    }
    db.prepare("UPDATE tmdb_franchise_prefs SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    // The identity layer must move WITH the key, or a registered inode keeps
    // claiming a franchise no request owns any more (startup then clears it).
    db.prepare("UPDATE media_files SET library_key = ? WHERE library_key = ?").run(newKey, oldKey);
    // The stale external-id row holds the pre-fix resolved title, so drop it and
    // let the repopulate below write the correct one under the new key.
    db.prepare("DELETE FROM tmdb_external_ids WHERE library_key = ?").run(oldKey);
  })();
  await resolveExternalIds(db, newKey, "series", resolved.name, lang, { ignoreCache: true }).catch(() => null);
  return { newKey };
}

router.post("/:id/fix-identity", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed) return res.status(404).json({ error: "Request not found" });
      if (seed.type !== "movie" || !seed.library_key) {
        return res.status(400).json({ error: "Native movie request with library_key required" });
      }
      const oldKey = seed.library_key;
      const lang = franchiseLanguage(db, oldKey) || process.env.TMDB_LANGUAGE || "en-US";
      const cleaned = cleanFranchiseTitle(seed.title || "");
      let resolved = await resolveMovieIdentity(oldKey, cleaned, lang);
      // Stored movie titles are routinely localized or mangled, so a search can
      // miss what the on-disk folder names correctly - retry with that, the same
      // way the series repair retries with the show folder.
      let diskDir: string | null = null;
      if (!resolved) {
        const rows = db.prepare("SELECT id FROM media_requests WHERE library_key = ? AND type = 'movie'").all(oldKey) as any[];
        diskDir = processedMovieDirFromFiles(db, rows.map((r: any) => r.id));
        if (diskDir) resolved = await resolveMovieIdentity(oldKey, path.basename(diskDir), lang);
      }
      // Whatever we search under, these are the films a human could have meant.
      const query = cleaned || seed.title || "";
      const candidates = query ? await searchTMDB(query, "movie", lang).catch(() => []) : [];
      const plausible = candidates.filter((c) => plausibleMovieCandidate(c.title, query));

      // A year the request states about itself — "(1994)" in the title, the
      // ":2012" tail of the key, or a year in the on-disk folder name.
      const ownYear = requestYear(seed) || (diskDir ? nameYear(diskDir) : null);

      if (!resolved) {        return res.json(
          plausible.length
            ? { fixed: false, old_key: oldKey, ambiguous: true, candidates: plausible, reason: "pick the right film" }
            : { fixed: false, old_key: oldKey, new_key: null, reason: "unresolved on TMDB" },
        );
      }
      // Never apply a resolution that contradicts a year the request already
      // states: that is not a resolution, it is a guess, and guessing here binds
      // a card to the wrong film — which outranks every other signal later and
      // is far harder to undo than an unrepaired key. Nor will it pick between
      // several matching films when the request states no year to separate them
      // ("Hobbit" is three films, and TMDB's first hit is arbitrary).
      const decision = decideMovieIdentity({
        resolvedYear: resolved?.year ?? null,
        ownYear,
        plausibleTitles: plausible.map((c) => c.title),
      });
      if (!decision.apply) {
        return res.json({
          fixed: false,
          old_key: oldKey,
          ambiguous: true,
          candidates: plausible.length ? plausible : candidates,
          reason: decision.reason,
        });
      }
      const applied = await applyMovieIdentity(db, oldKey, { name: resolved.name, year: resolved.year, tmdbId: resolved.id }, lang);
      if ("error" in applied) {
        return res.status(applied.status).json({ fixed: false, old_key: oldKey, new_key: null, reason: applied.error });
      }
      res.json({
        fixed: true,
        old_key: oldKey,
        new_key: applied.newKey,
        resolved: { id: resolved.id, name: resolved.name, year: resolved.year, via: diskDir ? `${resolved.via}+disk` : resolved.via },
      });
    } catch (error: any) {
      console.error("Error fixing movie identity:", error.message || error);
      res.status(500).json({ error: "Failed to fix movie identity" });
    }
  });

  // POST /api/requests/:id/retitle - the user picked the film. This is the only
  // path that rewrites `title`, because a mangled title is the input that caused
  // the bad identity in the first place; repairing only the key would leave the
  // card matching its sibling's files all over again.
  // GET /api/requests/:id/identity-candidates - films this card could be, for
  // the explicit "Re-attach" control. Separate from fix-identity's shortlist
  // because that one only appears when the resolver REFUSES to act; a card whose
  // key was already repaired while its stored title stayed mangled ("Hobbit"
  // -> movie:the-hobbit-an-unexpected-journey:2012) reports "already canonical"
  // and would otherwise have no way to correct the title it still matches on.
  router.get("/:id/identity-candidates", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed) return res.status(404).json({ error: "Request not found" });
      if (seed.type !== "movie") return res.status(400).json({ error: "Native movie request required" });
      const lang = franchiseLanguage(db, seed.library_key) || process.env.TMDB_LANGUAGE || "en-US";
      // Search under EVERY spelling this card could be found by, rather than
      // picking one. The stored title is the readable one; the key slug is a
      // LOSSY artifact of it ("służbie" -> "s u bie", diacritics folded and
      // separators injected), so it can only ever be a fallback for a title that
      // is empty or mangled -- preferring it because it is LONGER sent the search
      // for "Asterix i Obelix W służbie Jej Królewskiej Mości" out as
      // "asterix i obelix w s u bie jej kr lewskiej mo ci" and found nothing.
      // Merging both (deduped by TMDB id) means neither can hide the film from
      // the one spelling that does resolve it.
      const fromTitle = cleanFranchiseTitle(seed.title || "");
      const fromKey = seed.library_key
        ? cleanFranchiseTitle(String(seed.library_key).replace(/^movie:/, "").replace(/:\d{4}$/, "").replace(/-/g, " "))
        : "";
      // A term the user typed wins outright. TMDB indexes a film under its
      // ORIGINAL name, so a localized stored title can be unsearchable no
      // matter how many spellings of it we try: "Asterix i Obelix W sluzbie
      // Jej Krolewskiej Mosci" returns nothing for the film TMDB calls
      // "Asterix & Obelix: Mission Britain". Only someone who recognises the
      // film can supply the term TMDB knows it by, so give them a way to say it.
      const manual = String(req.query.q || "").trim();
      const queries = Array.from(
        new Set((manual ? [manual] : [fromTitle, fromKey]).map((q) => q.trim()).filter((q) => q.length > 1)),
      );
      const seen = new Set<number>();
      const candidates: any[] = [];
      for (const q of queries) {
        const hits = await searchTMDB(q, "movie", lang).catch(() => []);
        for (const hit of hits || []) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          candidates.push(hit);
        }
      }
      // The title stays the reported query: it is what the user recognises, and
      // it is the spelling the canonical name is built from once they pick.
      res.json({ query: fromTitle || fromKey || "", searched: queries, current_key: seed.library_key, candidates });
    } catch (error: any) {
      console.error("Error listing identity candidates:", error.message || error);
      res.status(500).json({ error: "Failed to list identity candidates" });
    }
  });

  router.post("/:id/retitle", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const tmdbId = Number(req.body?.tmdbId);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: "tmdbId is required" });
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!seed) return res.status(404).json({ error: "Request not found" });
      if (seed.type !== "movie" || !seed.library_key) {
        return res.status(400).json({ error: "Native movie request with library_key required" });
      }
      const oldKey = seed.library_key;
      const lang = franchiseLanguage(db, oldKey) || process.env.TMDB_LANGUAGE || "en-US";
      const info = await fetchTMDBById("movie", tmdbId, lang);
      if (!info?.title) return res.status(404).json({ error: `TMDB has no movie ${tmdbId}` });
      const applied = await applyMovieIdentity(db, oldKey, { name: info.title, year: info.year, tmdbId }, lang, {
        alsoSetTitle: true,
      });
      if ("error" in applied) {
        return res.status(applied.status).json({ fixed: false, old_key: oldKey, new_key: null, reason: applied.error });
      }
      res.json({ fixed: true, old_key: oldKey, new_key: applied.newKey, title: info.title, resolved: info });
    } catch (error: any) {
      console.error("Error retitling movie:", error.message || error);
      res.status(500).json({ error: "Failed to retitle movie" });
    }
  });

  // POST /api/requests/:id/set-language - set/clear per-franchise TMDB language.
  router.post("/:id/set-language", (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const request = db.prepare("SELECT id, library_key FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (!request.library_key) return res.status(400).json({ error: "No library_key (sonarr-linked request)" });
      const language = typeof req.body?.language === "string" && req.body.language.trim() ? req.body.language.trim() : null;
      // Read-modify-write: INSERT OR REPLACE used to rebuild the row from the
      // two columns it knew about, wiping an episode ORDER stored beside the
      // language, and clearing the language deleted the row it lived on.
      const row = db.prepare("SELECT language, episode_group_id FROM tmdb_franchise_prefs WHERE library_key = ?").get(request.library_key) as any;
      if (language) {
        if (row) db.prepare("UPDATE tmdb_franchise_prefs SET language = ? WHERE library_key = ?").run(language, request.library_key);
        else db.prepare("INSERT INTO tmdb_franchise_prefs (library_key, language, episode_group_id, episode_group_show_id) VALUES (?, ?, NULL, NULL)").run(request.library_key, language);
      } else if (row) {
        if (row.episode_group_id) db.prepare("UPDATE tmdb_franchise_prefs SET language = '' WHERE library_key = ?").run(request.library_key);
        else db.prepare("DELETE FROM tmdb_franchise_prefs WHERE library_key = ?").run(request.library_key);
      }
      // tmdb_external_ids caches the RESOLVED TITLE per key, so switching the
      // language would keep naming everything in the old one (movies have no
      // refresh endpoint to clear it). Drop the row and let the next resolution
      // re-fetch in the newly selected language; series re-resolve from their
      // tmdb_season_cache show id, so this stays cheap and never re-searches.
      try {
        db.prepare("DELETE FROM tmdb_external_ids WHERE library_key = ?").run(request.library_key);
      } catch {}
      res.json({ ok: true, language });
    } catch (error) {
      console.error("Error setting franchise language:", error);
      res.status(500).json({ error: "Failed to set language" });
    }
  });

  // GET /api/requests/:id/episode-orders - the episode ORDERS (TMDB episode
  // groups) a show has, plus the one in force. Series-only: a movie has no
  // seasons to renumber. `current` is only reported when it belongs to the
  // show the key resolves to NOW — a pref picked before a re-attach is shown
  // as the default rather than as a stale selection a fetch would drop anyway.
  router.get("/:id/episode-orders", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const request = db.prepare("SELECT id, library_key, title, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.type !== "series" || !request.library_key) return res.status(400).json({ error: "Episode orders are a series setting" });
      if (!isTmdbConfigured()) return res.json({ current: null, groups: [], show_id: null });
      const language = franchiseLanguage(db, request.library_key);
      const { show_id, groups } = await fetchEpisodeGroups(
        db,
        request.library_key,
        cleanFranchiseTitle(request.title || ""),
        language,
      );
      const pref = franchiseEpisodeOrder(db, request.library_key);
      const current = pref && show_id && pref.show_id === show_id ? pref.id : null;
      // Every order is offered, unfiltered. The structural "complete orders
      // only" filter was shipped and reverted: "official" is not encoded in
      // TMDB's type vocab (GoT's "Aired Order" and Stranger Things' "Release
      // Volumes" are both type 1; the order Phineas and Ferb releases actually
      // follow is type 4 "Disney+"), and a wrong SELECTION self-corrects the
      // moment the user picks another option, while a wrong FILTER hides the
      // correct order entirely — which is exactly what happened. The select
      // only renders when groups exist, so an empty list costs nothing.
      // POST still validates against this same full list.
      res.json({ current, groups, show_id });
    } catch (error) {
      console.error("Error listing episode orders:", error);
      res.status(500).json({ error: "Failed to list episode orders" });
    }
  });

  // POST /api/requests/:id/episode-order - set (groupId) or clear (null) the
  // franchise's episode order. The group id is re-checked against THIS show's
  // own group list — a hand-crafted id could point at another show, whose
  // "Season 1" would then be read under our episode numbers — and every
  // cached season row is dropped on a change, because those numbers belong to
  // the order that just left.
  router.post("/:id/episode-order", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const request = db.prepare("SELECT id, library_key, title, type FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (request.type !== "series" || !request.library_key) return res.status(400).json({ error: "Episode orders are a series setting" });
      const raw = req.body?.groupId;
      const groupId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (groupId && !/^[0-9a-f]{24}$/.test(groupId)) return res.status(400).json({ error: "Malformed episode group id" });
      let showId: number | null = null;
      if (groupId) {
        if (!isTmdbConfigured()) return res.status(400).json({ error: "TMDB is not configured" });
        const found = await fetchEpisodeGroups(
          db,
          request.library_key,
          cleanFranchiseTitle(request.title || ""),
          franchiseLanguage(db, request.library_key),
        );
        if (!found.show_id) return res.status(400).json({ error: "Could not resolve this show on TMDB" });
        if (!found.groups.some((g) => g.id === groupId)) return res.status(400).json({ error: "Not an episode group of this show" });
        showId = found.show_id;
      }
      const row = db.prepare("SELECT language, episode_group_id FROM tmdb_franchise_prefs WHERE library_key = ?").get(request.library_key) as any;
      const prev: string | null = row?.episode_group_id || null;
      if (groupId) {
        if (row) {
          db.prepare("UPDATE tmdb_franchise_prefs SET episode_group_id = ?, episode_group_show_id = ? WHERE library_key = ?").run(groupId, showId, request.library_key);
        } else {
          db.prepare("INSERT INTO tmdb_franchise_prefs (library_key, language, episode_group_id, episode_group_show_id) VALUES (?, '', ?, ?)").run(request.library_key, groupId, showId);
        }
      } else if (row) {
        // Clearing the order: keep the row when a language lives on it.
        if (row.language) db.prepare("UPDATE tmdb_franchise_prefs SET episode_group_id = NULL, episode_group_show_id = NULL WHERE library_key = ?").run(request.library_key);
        else db.prepare("DELETE FROM tmdb_franchise_prefs WHERE library_key = ?").run(request.library_key);
      }
      let dropped = 0;
      if (groupId !== prev) {
        dropped = db.prepare("DELETE FROM tmdb_season_cache WHERE library_key = ?").run(request.library_key).changes;
        // Warm the cache under the new order, so the very next Fix Names
        // preview — which reads episodeTitleFromCache and never the network —
        // already sees THIS order's titles instead of falling back to whatever
        // the on-disk name says. Best-effort: a miss is retried by the grids.
        const seasons = db
          .prepare("SELECT DISTINCT season FROM media_requests WHERE library_key = ? AND type = 'series'")
          .all(request.library_key) as any[];
        const wanted = [...new Set([0, ...seasons.map((s) => Number(s.season) || 0)])];
        const lang = franchiseLanguage(db, request.library_key);
        for (const s of wanted) {
          try {
            await fetchTMDBSeason(db, request.library_key, s, cleanFranchiseTitle(request.title || ""), { language: lang });
          } catch (err: any) {
            console.warn(`[episode-order] could not warm season ${s} of ${request.library_key}: ${err?.message}`);
          }
        }
      }
      res.json({ ok: true, episode_order: groupId, cache_rows_dropped: dropped });
    } catch (error) {
      console.error("Error setting episode order:", error);
      res.status(500).json({ error: "Failed to set episode order" });
    }
  });

  // POST /api/requests/:id/destroy/:releaseId - Per-torrent destroy: export torrent+trackers, delete from qbit, clean DB/processed
  router.post("/:id/destroy/:releaseId", async (req: Request, res: Response) => {
    try {
      const { id, releaseId } = req.params;
      const { deleteFiles } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const rel = db.prepare("SELECT * FROM release_candidates WHERE id = ? AND request_id = ?").get(releaseId, id) as any;
      if (!rel) return res.status(404).json({ error: "Release not found" });

      let exported = false;

      // Export .torrent + trackers
      if (rel.torrent_hash) {
        const hash = rel.torrent_hash;
        const dir = path.join(TRACKERS_DIR, hash);
        fs.mkdirSync(dir, { recursive: true });

        const torrentBuf = await qbittorrent.exportTorrent(hash);
        if (torrentBuf) {
          fs.writeFileSync(path.join(dir, `${rel.title || hash}.torrent`), torrentBuf);
        }

        const trackers = await qbittorrent.getTrackers(hash);
        fs.writeFileSync(path.join(dir, "trackers.json"), JSON.stringify({
          title: rel.title,
          hash,
          release_group: rel.release_group,
          size_mb: rel.size_mb,
          trackers: trackers.map((t) => t.url),
          exported_at: new Date().toISOString(),
        }, null, 2));

        exported = true;
        console.log(`[Destroy] Exported torrent+trackers for ${rel.title} → ${dir}`);

        // If keeping files, move content to processed before removing from qBit
        if (!deleteFiles && rel.torrent_hash) {
          const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
          const srcPath = torrent?.content_path ? fromQBittorrentPath(torrent.content_path) : "";
          if (srcPath && fs.existsSync(srcPath)) {
            const type = request.type === "series" ? "series" : "movie";
            const destDir = getProcessedDir(type);
            fs.mkdirSync(destDir, { recursive: true });
            const dest = path.join(destDir, path.basename(srcPath));
            const stat = fs.statSync(srcPath);
            fs.renameSync(srcPath, dest);
            console.log(`[Destroy] Moved kept files ${srcPath} → ${dest}`);
            registerVideoTree(db, dest, {
              library_key: request.library_key || "",
              title: request.title || "",
              season: request.season ?? 0,
            });
            const names: string[] = stat.isDirectory()
              ? fs.readdirSync(dest)
              : [path.basename(dest)];
            try {
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE release_id = ?")
                .run(JSON.stringify(names), releaseId);
            } catch {}
          }
        }

        // Delete from qBittorrent
        try { await qbittorrent.deleteTorrent(hash, !!deleteFiles); } catch {}
      }

      // Delete this release from DB
      db.prepare("DELETE FROM approval_history WHERE release_id = ?").run(releaseId);
      db.prepare("DELETE FROM release_candidates WHERE id = ?").run(releaseId);

      console.log(`[Destroy] Deleted release #${releaseId} (${rel.title}) from request #${id} (exported=${exported}, deleteFiles=${!!deleteFiles})`);
      res.json({ success: true, exported, title: rel.title });
    } catch (error: any) {
      console.error("Error destroying release:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id - Delete a single request and its releases
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deleteFiles = req.query.deleteFiles === "true";
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.json({ success: true });

      // Delete processed files
      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const approvals = db.prepare(
        "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
      ).all(id) as any[];
      for (const ah of approvals) {
        try {
          const names = JSON.parse(ah.processed_files);
          for (const name of names) {
            const fp = path.join(processedDir, name);
            if (fs.existsSync(fp)) {
              const st = fs.statSync(fp);
              if (st.isDirectory()) fs.rmSync(fp, { recursive: true, force: true });
              else fs.unlinkSync(fp);
            }
          }
        } catch {}
      }

      // Delete workspaces
      const wsDirs = listWorkspaces(request.id, request.title);
      for (const ws of wsDirs) {
        try { deleteWorkspace(ws.path); } catch {}
      }

      const sUrl = process.env.SONARR_URL || "";
      const sKey = process.env.SONARR_API_KEY || "";
      const rUrl = process.env.RADARR_URL || "";
      const rKey = process.env.RADARR_API_KEY || "";
      let destroyArrFailures = 0;
      // Delete from Sonarr/Radarr (best-effort — local state is removed regardless)
      if (request.sonarr_id && sUrl && sKey) {
        try {
          const r = await fetch(`${sUrl}/api/v3/series/${request.sonarr_id}?deleteFiles=${deleteFiles}`, { method: "DELETE", headers: { "X-Api-Key": sKey } });
          if (!r.ok) {
            console.warn(`[Delete] Sonarr DELETE series ${request.sonarr_id} failed: HTTP ${r.status}`);
            destroyArrFailures++;
          }
        } catch (e: any) {
          console.warn(`[Delete] Sonarr DELETE series ${request.sonarr_id} failed: ${e.message}`);
          destroyArrFailures++;
        }
      } else if (request.sonarr_id) {
        destroyArrFailures++;
      }
      if (request.radarr_id && rUrl && rKey) {
        try {
          const r = await fetch(`${rUrl}/api/v3/movie/${request.radarr_id}?deleteFiles=${deleteFiles}`, { method: "DELETE", headers: { "X-Api-Key": rKey } });
          if (!r.ok) {
            console.warn(`[Delete] Radarr DELETE movie ${request.radarr_id} failed: HTTP ${r.status}`);
            destroyArrFailures++;
          }
        } catch (e: any) {
          console.warn(`[Delete] Radarr DELETE movie ${request.radarr_id} failed: ${e.message}`);
          destroyArrFailures++;
        }
      } else if (request.radarr_id) {
        destroyArrFailures++;
      }

      // Delete from Seerr (best-effort — a Seerr request left alive re-creates
      // this row on the next sync poll). Only linked rows propagate; anything
      // without a seerr_request_id is purely local.
      let seerrDelete = null;
      if (request.seerr_request_id) {
        seerrDelete = await seerrRemoveRequest(Number(request.seerr_request_id));
        if (seerrDelete.ok) {
          console.log(`[Delete] Removed Seerr request ${request.seerr_request_id} (${seerrDelete.method})`);
        } else {
          console.warn(`[Delete] Seerr request ${request.seerr_request_id} NOT removed (${seerrDelete.method}: ${seerrDelete.error || seerrDelete.body || `HTTP ${seerrDelete.status}`}) — will re-sync`);
        }
      }

      db.prepare("DELETE FROM release_candidates WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM approval_history WHERE request_id = ?").run(id);
      db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
      console.log(`[Delete] Deleted request #${id}: ${request.title} (deleteFiles=${deleteFiles}, arrDeleteFailures=${destroyArrFailures})`);
      res.json({ success: true, arrDeleteFailures: destroyArrFailures, seerrDelete });
    } catch (error) {
      console.error("Error deleting request:", error);
      res.status(500).json({ error: "Failed to delete request" });
    }
  });

  // GET /api/requests/:id/releases - Get releases for a request
  router.get("/:id/releases", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseStmt = db.prepare("SELECT * FROM release_candidates WHERE request_id = ? ORDER BY radarr_rank ASC");
      const releases = parseReleases(releaseStmt.all(id));
      res.json(releases);
    } catch (error) {
      console.error("Error fetching releases:", error);
      res.status(500).json({ error: "Failed to fetch releases" });
    }
  });

  // GET /api/requests/:id/torrent-status - Get live torrent status from qBittorrent
  // Optional query: ?hash=xxx to get status for a specific approved release's torrent
  router.get("/:id/torrent-status", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

      const release = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?" +
        (req.query.release_id ? " AND rc.id = ?" : "")
      ).get(...(req.query.release_id ? [id, req.query.release_id] : [id])) as any;

      if (!release || !release.torrent_hash) {
        return res.json({ found: false });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) {
        return res.json({ found: false, hash: release.torrent_hash });
      }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);

      let destPath = "";
      let inLibrary = false;
      const { inodes: contentInodes, names: contentNames, sizes: contentSizes } = getContentVideoInodes(contentPath);

      // Candidate library folders for this request. A request may carry BOTH an
      // arr id and a native library_key (or a dead arr id), so try every branch
      // that resolves and merge the results instead of trusting the first.
      const libraryFolders = new Set<string>();
      try {
        if (request?.radarr_id) {
          const movie = await radarr.getMovie(request.radarr_id);
          const mf = movie.path || movie.movieFile?.folderPath || movie.folderPath || "";
          if (mf && fs.existsSync(mf)) libraryFolders.add(mf);
        }
      } catch {}
      try {
        if (request?.sonarr_id) {
          const series = await sonarr.getSeries(request.sonarr_id);
          const sf = series.path || path.join(MEDIA_TV, series.title);
          const seasonNum = request.season || 1;
          const sfold = path.join(sf, `S${String(seasonNum).padStart(2, "0")}`);
          if (fs.existsSync(sfold)) libraryFolders.add(sfold);
        }
      } catch {}
      try {
        if (request?.library_key && request.type === "series") {
          const lf = resolveLibraryFolder(request);
          if (lf && fs.existsSync(lf)) libraryFolders.add(lf);
        }
      } catch {}
      try {
        if (request?.library_key && request.type === "movie") {
          for (const folder of nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)) {
            if (fs.existsSync(folder)) libraryFolders.add(folder);
          }
        }
      } catch {}

      outer: for (const folder of libraryFolders) {
        try {
          for (const f of fs.readdirSync(folder)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            const fPath = path.join(folder, f);
            try {
              const st = fs.statSync(fPath);
              const inodeHit = contentInodes.size > 0 && contentInodes.has(st.ino);
              const nameHit = contentNames.has(f);
              const sizeHit = contentSizes.size > 0 && st.size > 0 && contentSizes.has(st.size);
              if (inodeHit || nameHit || sizeHit) {
                destPath = fPath;
                inLibrary = true;
                break outer;
              }
            } catch {}
          }
        } catch {}
        if (!destPath) destPath = folder;
      }

      // Is this torrent's content already captured under /Processed (hardlinked
      // there via a prior move/adoption/import)? If so the Move controls are moot.
      let inProcessed = false;
      let processedPath = "";
      try {
        const baseProcTitle = (request?.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
        const procDir = request?.type === "series"
          ? findSeasonFolder(baseProcTitle, request?.season || 1, libraryKeyYear(request?.library_key))
          : PROCESSED_MOVIES;
        if (procDir && fs.existsSync(procDir)) {
          for (const en of fs.readdirSync(procDir, { withFileTypes: true })) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(en.name)) continue;
            const full = path.join(procDir, en.name);
            try {
              const st = fs.statSync(full);
              const inodeHit = contentInodes.size > 0 && contentInodes.has(st.ino);
              const nameHit = contentNames.has(en.name);
              const sizeHit = contentSizes.size > 0 && st.size > 0 && contentSizes.has(st.size);
              if (inodeHit || nameHit || sizeHit) {
                inProcessed = true;
                processedPath = full;
                break;
              }
            } catch {}
          }
        }
      } catch {}

      const _debug = {
        releaseId: release.release_id,
        releaseTitle: release.title,
        releaseHash: release.torrent_hash,
        contentPath,
        contentPathExists: fs.existsSync(contentPath),
        contentVideoInodes: contentInodes.size,
        contentNames: [...contentNames],
        contentSizes: [...contentSizes],
        libraryFolders: [...libraryFolders],
        inLibrary,
        inProcessed,
      };
      console.log("[TorrentStatus-debug]", JSON.stringify(_debug));

      res.json({
        found: true,
        hash: torrent.hash,
        name: torrent.name,
        state: torrent.state,
        progress: Math.round(torrent.progress * 100),
        dlspeed: torrent.dlspeed,
        upspeed: torrent.upspeed,
        uploaded: torrent.uploaded,
        seeding_time: torrent.seeding_time,
        ratio: Math.round(torrent.ratio * 100) / 100,
        eta: torrent.eta,
        save_path: fromQBittorrentPath(torrent.save_path),
        content_path: contentPath,
        dest_path: destPath,
        library_path: destPath,
        in_library: inLibrary,
        in_processed: inProcessed,
        processed_path: processedPath,
        size: torrent.size,
        num_seeds: torrent.num_seeds,
        num_leechs: torrent.num_leechs,
        added_on: torrent.added_on,
        completion_on: torrent.completion_on,
        _debug,
      });
    } catch (error) {
      console.error("Error fetching torrent status:", error);
      res.status(500).json({ error: "Failed to fetch torrent status" });
    }
  });

  // GET /api/requests/:id/torrent-statuses - Get live torrent status for ALL approved releases
  router.get("/:id/torrent-statuses", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

      const releases = db.prepare(
        "SELECT rc.torrent_hash, rc.save_path, rc.title, rc.id as release_id, rc.size_mb FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
      ).all(id) as any[];

      // Candidate library folders for this request. A request may carry an arr
      // id, a native library_key, or both (arr services can be down) — try every
      // identity branch and merge instead of trusting the first.
      const libraryFolders = new Set<string>();
      try {
        if (request?.radarr_id) {
          const movie = await radarr.getMovie(request.radarr_id);
          const mf = movie.path || movie.movieFile?.folderPath || movie.folderPath || "";
          if (mf && fs.existsSync(mf)) libraryFolders.add(mf);
        }
      } catch {}
      try {
        if (request?.sonarr_id) {
          const series = await sonarr.getSeries(request.sonarr_id);
          const sf = series.path || path.join(MEDIA_TV, series.title);
          const sfold = path.join(sf, `S${String(request.season || 1).padStart(2, "0")}`);
          if (fs.existsSync(sfold)) libraryFolders.add(sfold);
        }
      } catch {}
      try {
        if (request?.library_key && request.type === "series") {
          const lf = resolveLibraryFolder(request);
          if (lf && fs.existsSync(lf)) libraryFolders.add(lf);
        }
      } catch {}
      try {
        if (request?.library_key && request.type === "movie") {
          for (const folder of nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)) {
            if (fs.existsSync(folder)) libraryFolders.add(folder);
          }
        }
      } catch {}

      const baseProcTitle = (request?.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
      const processedDirForReq = request?.type === "series"
        ? findSeasonFolder(baseProcTitle, request?.season || 1, libraryKeyYear(request?.library_key))
        : PROCESSED_MOVIES;

      const results: any[] = [];

      for (const release of releases) {
        if (!release.torrent_hash) {
          results.push({ release_id: release.release_id, title: release.title, found: false });
          continue;
        }

        const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
        if (!torrent) {
          // Stale hash — torrent was deleted from qBittorrent but hash wasn't cleared
          db.prepare("UPDATE release_candidates SET torrent_hash = '', save_path = '' WHERE id = ?").run(release.release_id);
          results.push({ release_id: release.release_id, title: release.title, found: false });
          continue;
        }

        let contentPath = torrent.content_path;
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);

        const { inodes: contentInodes, names: contentNames, sizes: contentSizes } = getContentVideoInodes(contentPath);

        let destPath = "";
        let inLibrary = false;
        for (const folder of libraryFolders) {
          try {
            for (const f of fs.readdirSync(folder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              const fPath = path.join(folder, f);
              try {
                const st = fs.statSync(fPath);
                if ((contentInodes.size > 0 && contentInodes.has(st.ino))
                  || contentNames.has(f)
                  || (contentSizes.size > 0 && st.size > 0 && contentSizes.has(st.size))) {
                  destPath = fPath;
                  inLibrary = true;
                  break;
                }
              } catch {}
            }
          } catch {}
          if (inLibrary && destPath) break;
          if (!destPath) destPath = folder;
        }

        let inProcessed = false;
        let processedPath = "";
        if (processedDirForReq && fs.existsSync(processedDirForReq)) {
          try {
            for (const en of fs.readdirSync(processedDirForReq)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(en)) continue;
              const full = path.join(processedDirForReq, en);
              try {
                const st = fs.statSync(full);
                if ((contentInodes.size > 0 && contentInodes.has(st.ino))
                  || contentNames.has(en)
                  || (contentSizes.size > 0 && st.size > 0 && contentSizes.has(st.size))) {
                  inProcessed = true;
                  processedPath = full;
                  break;
                }
              } catch {}
            }
          } catch {}
        }

        const _debug = {
          releaseId: release.release_id,
          releaseTitle: release.title,
          contentPath,
          contentPathExists: fs.existsSync(contentPath),
          contentVideoInodes: contentInodes.size,
          contentNames: [...contentNames],
          contentSizes: [...contentSizes],
          libraryFolders: [...libraryFolders],
          inLibrary,
          inProcessed,
        };

        results.push({
          release_id: release.release_id,
          title: release.title,
          found: true,
          hash: torrent.hash,
          name: torrent.name,
          state: torrent.state,
          progress: Math.round(torrent.progress * 100),
          dlspeed: torrent.dlspeed,
          upspeed: torrent.upspeed,
          uploaded: torrent.uploaded,
          seeding_time: torrent.seeding_time,
          ratio: Math.round(torrent.ratio * 100) / 100,
          eta: torrent.eta,
          save_path: fromQBittorrentPath(torrent.save_path),
          content_path: contentPath,
          dest_path: destPath,
          library_path: destPath,
          in_library: inLibrary,
          in_processed: inProcessed,
          processed_path: processedPath,
          size: torrent.size,
          num_seeds: torrent.num_seeds,
          num_leechs: torrent.num_leechs,
          added_on: torrent.added_on,
          completion_on: torrent.completion_on,
          _debug,
        });
      }

      res.json(results);
    } catch (error) {
      console.error("Error fetching torrent statuses:", error);
      res.status(500).json({ error: "Failed to fetch torrent statuses" });
    }
  });

  // GET /api/requests/:id/content-info - Scan content path for video files
  router.get("/:id/content-info", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.json({ type: "none", videoFiles: [], hasBdmv: false, needsProcessing: false });
      }

      const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv"]);
      const videoFiles: { name: string; size: number; path: string }[] = [];
      let hasBdmv = false;

      function scanDir(dir: string, depth: number = 0) {
        if (depth > 3) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "BDMV") {
              const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
              if (subEntries.some((e: any) => e.isDirectory() && e.name === "STREAM")) hasBdmv = true;
            }
            if (entry.name !== "CERTIFICATE" && entry.name !== "BDMV") scanDir(fullPath, depth + 1);
          } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTS.has(ext)) {
              const stat = fs.statSync(fullPath);
              videoFiles.push({ name: entry.name, size: stat.size, path: fullPath });
            }
          }
        }
      }

      const stat = fs.statSync(contentPath);
      if (stat.isDirectory()) {
        scanDir(contentPath);
      } else {
        const ext = path.extname(contentPath).toLowerCase();
        if (VIDEO_EXTS.has(ext)) {
          videoFiles.push({ name: path.basename(contentPath), size: stat.size, path: contentPath });
        }
      }

      let type: "video" | "bluray" | "multi" | "none";
      if (hasBdmv) type = "bluray";
      else if (videoFiles.length === 1) type = "video";
      else if (videoFiles.length > 1) type = "multi";
      else type = "none";

      res.json({
        type,
        videoFiles: videoFiles.map((f) => ({ name: f.name, size: f.size })),
        hasBdmv,
        needsProcessing: hasBdmv || videoFiles.length > 1,
      });
    } catch (error: any) {
      console.error("Error scanning content info:", error);
      res.status(500).json({ error: `Failed to scan content: ${error.message}` });
    }
  });

  // POST /api/requests/:id/reject - Reject a request
  router.post("/:id/reject", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updateStmt = db.prepare("UPDATE media_requests SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      updateStmt.run(id);
      res.json({ success: true, message: "Request rejected" });
    } catch (error) {
      console.error("Error rejecting request:", error);
      res.status(500).json({ error: "Failed to reject request" });
    }
  });

  // POST /api/requests/:id/dismiss?releaseId=X - Permanently delete request (or single release)
  router.post("/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (!releaseId && ["DOWNLOADING", "SEEDING", "COMPLETED"].includes(request.status)) {
        return res.status(400).json({ error: "Cannot dismiss request with active downloads. Remove files first." });
      }

      let seerrDelete: any = null;

      if (releaseId) {
        // Delete a single approved release's torrent
        const release = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?"
        ).get(releaseId) as any;

        if (release?.torrent_hash) {
          try {
            await qbittorrent.deleteTorrent(release.torrent_hash, false);
            console.log(`[Dismiss] Removed torrent ${release.torrent_hash}`);
          } catch (err: any) {
            console.error(`[Dismiss] Failed to delete torrent:`, err.message);
          }
        }

        // Remove the approval_history for this release
        db.prepare("DELETE FROM approval_history WHERE release_id = ? AND request_id = ?").run(releaseId, id);

        // If no more approved releases with torrents, set status back to NEW (don't auto-delete)
        const remaining = db.prepare(
          "SELECT rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? AND rc.torrent_hash != ''"
        ).get(id) as any;
        if (!remaining) {
          db.prepare("UPDATE media_requests SET status = 'NEW', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
          console.log(`[Dismiss] Removed release from request #${id}, no active torrents left — set to NEW`);
        }
      } else {
        // Delete entire request: delete all torrents, unmonitor, then remove from DB

        const releases = db.prepare(
          "SELECT rc.id, rc.torrent_hash FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(id) as any[];
        for (const release of releases) {
          if (release.torrent_hash) {
            try {
              await qbittorrent.deleteTorrent(release.torrent_hash, false);
            } catch {}
          }
        }

        // Unmonitor from Radarr
        if (request?.radarr_id) {
          try {
            await radarr.unmonitorMovie(request.radarr_id);
            console.log(`[Dismiss] Unmonitored movie in Radarr: ${request.title}`);
          } catch (err: any) {
            console.error(`[Dismiss] Failed to update Radarr for ${request.title}:`, err.message);
          }
        }

        // Unmonitor from Sonarr
        if (request?.sonarr_id) {
          try {
            if (request.season != null) {
              await sonarr.unmonitorSeason(request.sonarr_id, request.season);
              console.log(`[Dismiss] Unmonitored season ${request.season} in Sonarr: ${request.title}`);
            } else {
              await sonarr.unmonitorSeries(request.sonarr_id);
              console.log(`[Dismiss] Unmonitored series in Sonarr: ${request.title}`);
            }
          } catch (err: any) {
            console.error(`[Dismiss] Failed to update Sonarr for ${request.title}:`, err.message);
          }
        }

        // Permanently delete from DB (CASCADE removes release_candidates, approval_history)
        db.prepare("DELETE FROM media_requests WHERE id = ?").run(id);
        console.log(`[Dismiss] Deleted request #${id}: ${request?.title}`);

        // Remove from Seerr too — a surviving Seerr request makes the next sync
        // poll re-create this row within a minute.
        if (request?.seerr_request_id) {
          seerrDelete = await seerrRemoveRequest(Number(request.seerr_request_id));
          if (seerrDelete.ok) {
            console.log(`[Dismiss] Removed Seerr request ${request.seerr_request_id} (${seerrDelete.method})`);
          } else {
            console.warn(`[Dismiss] Seerr request ${request.seerr_request_id} NOT removed (${seerrDelete.method}: ${seerrDelete.error || seerrDelete.body || `HTTP ${seerrDelete.status}`}) — will re-sync`);
          }
        }
      }

      res.json({ success: true, seerrDelete });
    } catch (error) {
      console.error("Error dismissing request:", error);
      res.status(500).json({ error: "Failed to dismiss request" });
    }
  });

  // POST /api/requests/:id/remove-from-library - Delete hardlinked/copied file from library
  router.post("/:id/remove-from-library", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { fileName } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      // If fileName is provided, find the processed file and match by inode to library
      if (fileName) {
const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const processedFile = path.join(processedDir, fileName);

        if (!fs.existsSync(processedFile)) {
          return res.status(404).json({ error: "Processed file not found" });
        }

        const processedIno = fs.statSync(processedFile).ino;

        // Find library folder — arr id wins when present, but native (arr-free)
        // requests resolve by library_key/title against the library roots.
        let libraryDir = "";
        if (request.sonarr_id) {
          try {
            const series = await sonarr.getSeries(request.sonarr_id);
            const seasonNum = request.season || 1;
            const seriesFolder = series.path || path.join(MEDIA_TV, series.title);
            libraryDir = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
          } catch {}
        } else if (request.radarr_id) {
          try {
            const movie = await radarr.getMovie(request.radarr_id);
            libraryDir = movie.path || movie.folderPath;
          } catch {}
        }
        if (!libraryDir) {
          try {
            libraryDir = request.type === "series"
              ? (resolveLibraryFolder(request) || "")
              : (nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)[0] || "");
          } catch {}
        }

        if (!libraryDir || !fs.existsSync(libraryDir)) {
          return res.status(500).json({ error: "Could not determine library path" });
        }

        // Match by inode, filename, or file size (copies don't share inodes)
        let destPath = "";
        const processedSize = fs.statSync(processedFile).size;
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          const fPath = path.join(libraryDir, f);
          try {
            const st = fs.statSync(fPath);
            if (st.ino === processedIno && st.ino > 0) { destPath = fPath; break; }
          } catch {}
        }
        if (!destPath) {
          const candidate = path.join(libraryDir, fileName);
          if (fs.existsSync(candidate)) destPath = candidate;
        }
        if (!destPath && processedSize > 0) {
          for (const f of fs.readdirSync(libraryDir)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            const fPath = path.join(libraryDir, f);
            try {
              const st = fs.statSync(fPath);
              if (st.size === processedSize) { destPath = fPath; break; }
            } catch {}
          }
        }

        if (!destPath) {
          return res.json({ success: true, message: "File not in library", path: "" });
        }

        fs.rmSync(destPath, { recursive: false, force: true });
        console.log(`[RemoveFromLibrary] Deleted ${destPath}`);
        return res.json({ success: true, message: "Removed from library", path: destPath });
      }

      // Legacy path: remove torrent content from library (no fileName)
      const release = db.prepare(
        "SELECT rc.torrent_hash FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release?.torrent_hash) { console.log(`[RemoveFromLib] No torrent hash for request ${id}`); return res.status(400).json({ error: "No torrent tracked" }); }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) { console.log(`[RemoveFromLib] Torrent ${release.torrent_hash.slice(0,8)} not found in qBittorrent`); return res.status(404).json({ error: "Torrent not found in qBittorrent" }); }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      console.log(`[RemoveFromLib] contentPath=${contentPath} exists=${fs.existsSync(contentPath)} torrentSize=${torrent.size}`);

      let libraryDir = "";

      if (request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seriesFolder = series.path || path.join(MEDIA_TV, series.title);
          libraryDir = path.join(seriesFolder, `S${String(seasonNum).padStart(2, "0")}`);
        } catch {}
      } else if (request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          libraryDir = movie.path || movie.folderPath;
        } catch {}
      }
      if (!libraryDir) {
        try {
          libraryDir = request.type === "series"
            ? (resolveLibraryFolder(request) || "")
            : (nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)[0] || "");
        } catch {}
      }
      console.log(`[RemoveFromLib] libraryDir=${libraryDir} exists=${libraryDir ? fs.existsSync(libraryDir) : false}`);

      if (!libraryDir || !fs.existsSync(libraryDir)) {
        return res.status(500).json({ error: "Could not determine library path" });
      }

      // Match by inode, filename, or file size (copies don't share inodes)
      let destPath = "";
      const { inodes: contentInodes, names: contentNames } = getContentVideoInodes(contentPath);
      console.log(`[RemoveFromLib] contentInodes=${[...contentInodes].join(",")}`);
      for (const f of fs.readdirSync(libraryDir)) {
        if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
        const fPath = path.join(libraryDir, f);
        try {
          const st = fs.statSync(fPath);
          if (contentInodes.size > 0 && contentInodes.has(st.ino)) { destPath = fPath; break; }
        } catch {}
      }
      if (!destPath) {
        const match = fs.readdirSync(libraryDir).find((f: string) => contentNames.has(f));
        if (match) destPath = path.join(libraryDir, match);
      }
      if (!destPath && torrent.size > 0) {
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          const fPath = path.join(libraryDir, f);
          try {
            const st = fs.statSync(fPath);
            if (st.size === torrent.size) { destPath = fPath; break; }
          } catch {}
        }
      }

      // Fallback: scan processed dir for files matching request title, use their sizes
      if (!destPath) {
        const procDirs = [
          path.join(PROCESSED_MOVIES),
          path.join(PROCESSED_TV),
        ];
        for (const procDir of procDirs) {
          if (!fs.existsSync(procDir)) continue;
          for (const f of fs.readdirSync(procDir)) {
            if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
            // Never resolve a library twin by size from another film's file just
            // because the titles overlap (Mufasa vs The Lion King).
            if (nameContradictsRequest(db, request, f)) continue;
            if (!titlesMatch(request.title, f)) continue;
            const fPath = path.join(procDir, f);
            try {
              const procSize = fs.statSync(fPath).size;
              if (procSize > 0) {
                for (const lf of fs.readdirSync(libraryDir)) {
                  if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(lf)) continue;
                  const lfPath = path.join(libraryDir, lf);
                  try {
                    if (fs.statSync(lfPath).size === procSize) { destPath = lfPath; break; }
                  } catch {}
                }
              }
              if (destPath) break;
            } catch {}
          }
          if (destPath) break;
        }
      }

      // Last resort: any video file in the library dir (user wants it gone from library)
      if (!destPath) {
        for (const f of fs.readdirSync(libraryDir)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
          destPath = path.join(libraryDir, f);
          break;
        }
      }

      if (!destPath) {
        console.log(`[RemoveFromLib] No match in ${libraryDir} (contentInodes=${contentInodes.size}, torrentSize=${torrent.size})`);
        const libFiles = fs.readdirSync(libraryDir).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)).map((f: string) => {
          try { const s = fs.statSync(path.join(libraryDir, f)); return `${f} size=${s.size} ino=${s.ino}`; } catch { return f; }
        });
        console.log(`[RemoveFromLib] Library files: ${libFiles.join(", ") || "(empty)"}`);
        return res.json({ success: true, message: "File not in library", path: "" });
      }

      fs.rmSync(destPath, { recursive: false, force: true });
      console.log(`[RemoveFromLib] Deleted ${destPath}`);
      res.json({ success: true, message: "Removed from library", path: destPath });
    } catch (error: any) {
      console.error("Error removing from library:", error);
      res.status(500).json({ error: `Failed to remove: ${error.message}` });
    }
  });

  // POST /api/requests/:id/move-to-processed - Hardlink files from download folder to processed staging
  router.post("/:id/move-to-processed", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { releaseId } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      const type = request.type === "series" ? "series" : "movie";

      // P1 canonical naming for NEW processed files: single-file torrents get
      // the naming-template name; folder torrents keep their structure intact.
      let canonicalName: string | null = null;
      try {
        const contentStat = fs.statSync(contentPath);
        if (request.library_key && contentStat.isFile()) {
          const probe = await probeVideoFile(contentPath);
          canonicalName = await canonicalFileBase(db, request, path.basename(contentPath), type === "movie" ? PROCESSED_MOVIES : PROCESSED_TV, probe);
        }
      } catch {}

      const result = moveToProcessedSync(contentPath, type, canonicalName || undefined);
      if (!result.success) return res.status(500).json({ error: result.error });

      // Register identity for the processed inodes (same inode as the download
      // copy — hardlinked — so this single row also identifies the download twin).
      if (result.destination) {
        const registered = registerVideoTree(db, result.destination, {
          library_key: request.library_key || "",
          title: request.title || "",
          season: request.season ?? 0,
        });
        console.log(`[Identity] move-to-processed registered ${registered} file(s) under ${result.destination}`);
      }

      // Link the processed files in the DB so the processed panel shows them
      const processedDir = getProcessedDir(type);
      const linkedFiles: string[] = [];
      const srcStat = fs.existsSync(contentPath) ? fs.statSync(contentPath) : null;

      // First: clean dangling processed_files entries for this request (files no longer on disk)
      const allCleanRows = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(request.id) as any[];
      for (const cr of allCleanRows) {
        try {
          const arr = JSON.parse(cr.processed_files);
          const filtered = arr.filter((f: string) => fs.existsSync(path.join(processedDir, f)));
          if (filtered.length !== arr.length) {
            db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(filtered), cr.id);
            console.log(`[MoveToProcessed] Cleaned dangling: AH id=${cr.id} ${arr.length}->${filtered.length}`);
          }
        } catch {}
      }

      // Collect inodes of ALL remaining existing processed files for this request
      const existingInodes = new Set<number>();
      const allAhRows = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(request.id) as any[];
      console.log(`[MoveToProcessed] After cleanup: ${allAhRows.length} AH rows:`);
      for (const ahRow of allAhRows) {
        try {
          const arr = JSON.parse(ahRow.processed_files);
          console.log(`[MoveToProcessed]   AH id=${ahRow.id} files=${arr.join(", ")}`);
          for (const f of arr) {
            try { const st = fs.statSync(path.join(processedDir, f)); if (st.ino > 0) existingInodes.add(st.ino); } catch {}
          }
        } catch {}
      }
      console.log(`[MoveToProcessed] existingInodes=${[...existingInodes].join(",")}`);

      if (srcStat?.isDirectory()) {
        const prefix = type === "series" ? path.basename(contentPath) : "";
        for (const entry of fs.readdirSync(contentPath)) {
          if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
          const destPath = path.join(processedDir, prefix, entry);
          if (fs.existsSync(destPath)) {
            // Skip if same inode as existing processed file (hardlink duplicate)
            try {
              const st = fs.statSync(destPath);
              if (st.ino > 0 && existingInodes.has(st.ino)) { console.log(`[MoveToProcessed] SKIP ${entry}: inode ${st.ino} already tracked`); continue; }
            } catch {}
            linkedFiles.push(prefix ? path.join(prefix, entry) : entry);
          }
        }
      } else if (srcStat) {
        const base = canonicalName ? path.basename(result.destination || "") || path.basename(contentPath) : path.basename(contentPath);
        const destPath = path.join(processedDir, base);
        if (fs.existsSync(destPath)) {
          try {
            const st = fs.statSync(destPath);
            if (!(st.ino > 0 && existingInodes.has(st.ino))) linkedFiles.push(base);
          } catch { linkedFiles.push(base); }
        }
      }
      if (linkedFiles.length > 0) {
        console.log(`[MoveToProcessed] ${contentPath} → ${result.destination} (${linkedFiles.length} files linked, not added to DB — tracked via torrent association)`);
      } else {
        console.log(`[MoveToProcessed] All files already linked via inode, nothing to add`);
      }

      res.json({ success: true, source: contentPath, destination: result.destination, files: linkedFiles });
    } catch (error: any) {
      console.error("Error moving to processed:", error);
      res.status(500).json({ error: `Failed to move to processed: ${error.message}` });
    }
  });

  // GET /api/requests/:id/move-status - Detect existing hardlinks in processed/workspace
  router.get("/:id/move-status", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const releases = db.prepare(
        "SELECT rc.id, rc.torrent_hash FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).all(id) as any[];

      const results: Record<number, { source?: string; destination?: string; inWorkspace?: boolean; workspaceIndex?: number; processedOutputs?: string[] } | null> = {};
      const type = request.type === "series" ? "series" : "movie";
      const processedDir = type === "movie" ? (PROCESSED_MOVIES) : (PROCESSED_TV);
      const workspaceBase = PROCESSING_WORKSPACE;

      for (const rel of releases) {
        if (!rel.torrent_hash) { results[rel.id] = null; continue; }
        const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
        if (!torrent) { results[rel.id] = null; continue; }

        let contentPath = torrent.content_path;
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
        if (!fs.existsSync(contentPath)) { results[rel.id] = null; continue; }

        const basename = path.basename(contentPath);
        const contentStat2 = fs.statSync(contentPath);
        const isDir = contentStat2.isDirectory();

        // Collect all video filenames inside contentPath (for dirs) or just the file itself
        const contentFileNames: string[] = [];
        if (isDir) {
          for (const e of fs.readdirSync(contentPath)) {
            if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e)) contentFileNames.push(e);
          }
        } else {
          contentFileNames.push(basename);
        }

        // Check if any of the video files is already hardlinked in processed dir
        let foundProcessed = false;
        for (const cfn of contentFileNames) {
          const pp = path.join(processedDir, cfn);
          if (fs.existsSync(pp)) {
            try {
              const cfStat = fs.statSync(path.join(contentPath, isDir ? cfn : ""));
              const ppStat = fs.statSync(pp);
              if (cfStat.ino === ppStat.ino && cfStat.dev === ppStat.dev) {
                results[rel.id] = { source: contentPath, destination: pp };
                foundProcessed = true;
                break;
              }
            } catch {}
          }
        }
        if (foundProcessed) continue;

        const processedPath = path.join(processedDir, basename);

      const wsDirs = listWorkspaces(request.id, request.title);
        let foundInWorkspace = false;
        for (const ws of wsDirs) {
          const wsInput = path.join(ws.path, "inputs", basename);
          if (fs.existsSync(wsInput)) {
            try {
              const contentStat = fs.statSync(contentPath);
              const wsInputStat = fs.statSync(wsInput);
              if (contentStat.isDirectory() || (contentStat.ino === wsInputStat.ino && contentStat.dev === wsInputStat.dev)) {
                results[rel.id] = { source: contentPath, destination: wsInput, inWorkspace: true, workspaceIndex: ws.index };
                foundInWorkspace = true;
                break;
              }
            } catch {}
          }
        }

        if (!foundInWorkspace && !results[rel.id]) {
          const processedOutputs: string[] = [];
          for (const ws of wsDirs) {
            if (ws.metadata?.outputPaths) {
              for (const op of ws.metadata.outputPaths) {
                if (fs.existsSync(op) && path.basename(op) === basename) processedOutputs.push(op);
              }
            }
          }
          if (processedOutputs.length > 0) {
            results[rel.id] = { source: contentPath, destination: processedOutputs[0], processedOutputs };
          } else if (fs.existsSync(processedPath)) {
            results[rel.id] = { source: contentPath, destination: processedPath, processedOutputs: [processedPath] };
          } else {
            results[rel.id] = null;
          }
        }
      }

      res.json({ moves: results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Rename submitted paths to their recomputed canonical names for `request` —
   *  shared by the request-scoped and native-season Fix Names endpoints. */
  async function applyFixNamePaths(request: any, paths: string[]): Promise<any[]> {
    // Apply normally rides on the preview the UI just made, but it can be called
    // cold. Warm the season cache here too so a proposal can never be un-appliable
    // because the title/air date went missing between the two.
    await warmSeasonCache(db, request);
    const results: any[] = [];
    const filePaths: string[] = [];
    const staged: (StagedFixName | null)[] = [];
    const dirEntries: { path: string; kind: "show" | "season" | "movie" }[] = [];
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) dirEntries.push({ path: p, kind: dirKindForPath(p) });
        else filePaths.push(p);
      } catch {
        results.push({ path: p, ok: false, error: "Path not found" });
      }
    }
    // Refuse the WHOLE batch before the first rename when a target directory is not
    // writable. Permission is a property of the directory, not of one file, so a mixed
    // batch would land every name the app CAN write and silently skip the rest — the two
    // trees drift and the user has to re-run to learn which half moved.
    const unwritable = unwritableFixNameDirs(paths);
    if (unwritable.length) {
      const msg = "Directory not writable by the app — nothing was renamed; fix ownership first";
      console.error(`[FixNames] refused batch (${unwritable.length} unwritable director${unwritable.length === 1 ? "y" : "ies"}): ${unwritable.join(" | ")}`);
      return paths.map((p) => ({ path: p, ok: false, error: `${msg}: ${path.dirname(p)}` }));
    }
    // Files rename first (their folders are still at today's paths); directory
    // renames run last, deepest-first, so a season rename never invalidates its
    // show dir's submitted path.
    //
    // Every proposal is snapshotted from ONE buildFixNameGroups run BEFORE the
    // first rename. Recomputing per file looked equivalent but had two holes:
    // it cannot see the same-inode sibling that fills a name's gaps, and after
    // the first rename the sibling has moved, so the rest of the batch would
    // land on different names than the preview showed. Snapshot also makes
    // preview and apply literally the same computation.
    const previewed = new Map<string, string | null>();
    try {
      const { groups } = await buildFixNameGroups(db, request);
      for (const g of groups) {
        for (const row of [g.processed, g.library]) {
          if (row) previewed.set(row.path, row.proposedName ?? null);
        }
      }
    } catch (err: any) {
      console.log(`[FixNames] proposal snapshot failed, falling back to per-file naming: ${err.message}`);
    }
    for (const p of filePaths) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) { results.push({ path: p, ok: false, error: "Not a file" }); continue; }
        if (!isFixNameTarget(p)) { results.push({ path: p, ok: false, error: "Path is outside the managed trees" }); continue; }
        // Both branches yield the FULL new name, extension included:
        // applyFixNameRename only appends one when it is missing.
        let newName: string | null;
        if (previewed.has(p)) {
          newName = previewed.get(p) ?? null;
        } else {
          // Not part of this request's groups (a file matched through some other
          // route) — name it standalone rather than refusing the user's pick.
          const probe = await probeVideoFile(p);
          const pb = await proposeCanonicalName(db, request, path.basename(p), probe);
          newName = pb.name ? `${pb.name}${path.extname(p)}` : null;
        }
        if (!newName) { results.push({ path: p, ok: false, error: "Nothing to rename" }); continue; }
        staged.push(stageFixName(p, st, newName, results));
      } catch (err: any) {
        results.push({ path: p, ok: false, error: err.message });
      }
    }
    // Parked files first, then landed. Every name a rename wants is currently held
    // by another file in the same folder whenever the batch renumbers a season, so
    // the tree holds nothing but parked files (and anything the user left alone) by
    // the time the destinations are computed — which is what makes the outcome
    // independent of the order rows arrived in.
    for (const s of staged) {
      if (!s) continue;
      try {
        const { dest } = planFixNameDest(s.stagedPath, s.newName, s.st.ino);
        const landed = landFixNameRename(s.stagedPath, dest, s.st);
        if (!landed.ok) {
          // Put it back under its real name rather than leaving a dotfile behind.
          const back = landFixNameRename(s.stagedPath, s.origPath, s.st);
          results.push({ path: s.origPath, ok: false, error: back.ok ? landed.error : `${landed.error} (rollback failed: ${back.error})` });
          continue;
        }
        recordFixNameRename(db, request, s.origBase, dest, s.st);
        console.log(`[FixNames] renamed ${s.origPath} -> ${dest}`);
        results.push({ path: s.origPath, ok: true, old: s.origBase, new: path.basename(dest) });
      } catch (err: any) {
        results.push({ path: s.origPath, ok: false, error: err.message });
      }
    }
    dirEntries.sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length);
    for (const d of dirEntries) {
      results.push({ path: d.path, ...(await applyDirRename(db, request, d.path, d.kind)) });
    }
    // Always end the batch with one journal line stating what happened. Successes log
    // per rename, so a batch where EVERYTHING failed produced a journal with no output at
    // all — indistinguishable from "did nothing" — while the per-row errors only ever
    // existed in an HTTP response body nobody reads. Failures are grouped by reason with
    // the quoted paths erased, so one EACCES is one line instead of one line per file.
    const failed = results.filter((r) => !r.ok) as any[];
    const renamed = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    if (failed.length) {
      const byReason = new Map<string, { count: number; sample: string }>();
      for (const f of failed) {
        const raw = String(f.error || "Unknown error");
        // Cut at the FIRST quote rather than matching `'…' -> '…'`: an apostrophe inside
        // a release name ("Magica's Magic Mirror") makes that pattern anchor on it and
        // leave the per-file prefix in the reason, so one shared EACCES would print as
        // one journal line per affected file — the exact repetition being collapsed.
        const key = raw.includes("'") ? `${raw.slice(0, raw.indexOf("'"))}<paths>` : raw;
        const cur = byReason.get(key);
        if (cur) cur.count++;
        else byReason.set(key, { count: 1, sample: f.path });
      }
      const detail = [...byReason.entries()].map(([reason, v]) => `${v.count}x ${reason} (e.g. ${v.sample})`).join(" | ");
      console.error(`[FixNames] ${renamed} renamed, ${skipped} already canonical, ${failed.length} FAILED — ${detail}`);
    } else {
      console.log(`[FixNames] ${renamed} renamed, ${skipped} already canonical, 0 failed`);
    }
    return results;
  }

  /** A synthetic request row for a native season that has no media_requests row
   *  yet, so season-scoped tools (Fix Names) can operate on a disk-first season. */
  function nativeSeasonRequest(seed: any, season: number): any {
    return { id: -1, type: "series", title: cleanFranchiseTitle(seed.title || ""), library_key: seed.library_key, season, episode_count: null };
  }

  // POST /api/requests/:id/fix-names/preview - P2 proposal rows (processed files
  // + library twins) with canonical old→new names for the Fix Names modal.
  router.post("/:id/fix-names/preview", async (req: Request, res: Response) => {
    try {
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(req.params.id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (!request.library_key) {
        return res.status(400).json({ error: "Sonarr/Radarr owns file names for arr-linked requests" });
      }
      const data = await buildFixNameGroups(db, request);
      res.json({ groups: data.groups, dirs: data.dirs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/fix-names/apply - Rename the selected files to their
  // (re)computed canonical names. Names are recomputed server-side, never taken
  // from the client verbatim; renames are inode-verified and collision-safe.
  router.post("/:id/fix-names/apply", async (req: Request, res: Response) => {
    try {
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(req.params.id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      if (!request.library_key) {
        return res.status(400).json({ error: "Sonarr/Radarr owns file names for arr-linked requests" });
      }
      const paths: string[] = Array.isArray(req.body?.paths) ? req.body.paths.filter((p: unknown) => typeof p === "string") : [];
      if (paths.length === 0) return res.status(400).json({ error: "No file paths provided" });
      const results = await applyFixNamePaths(request, paths);
      res.json({ results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/native-franchise/:id/fix-names/preview - Fix Names for a
  // native season that has no media_requests row yet (a disk-first season).
  router.post("/native-franchise/:id/fix-names/preview", async (req: Request, res: Response) => {
    try {
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(Number(req.params.id)) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const raw = Math.trunc(Number(req.body?.season));
      const sNum = Number.isFinite(raw) && raw >= 0 ? raw : 0;
      const data = await buildFixNameGroups(db, nativeSeasonRequest(seed, sNum));
      res.json({ groups: data.groups, dirs: data.dirs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/native-franchise/:id/fix-names/apply - apply for the same
  // disk-first season. Names are recomputed server-side, never taken verbatim.
  router.post("/native-franchise/:id/fix-names/apply", async (req: Request, res: Response) => {
    try {
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(Number(req.params.id)) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const raw = Math.trunc(Number(req.body?.season));
      const sNum = Number.isFinite(raw) && raw >= 0 ? raw : 0;
      const paths: string[] = Array.isArray(req.body?.paths) ? req.body.paths.filter((p: unknown) => typeof p === "string") : [];
      if (paths.length === 0) return res.status(400).json({ error: "No file paths provided" });
      const results = await applyFixNamePaths(nativeSeasonRequest(seed, sNum), paths);
      res.json({ results });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** Attach a disk-first season's processed files to a request's approval_history
   *  (release_id IS NULL), using the reconcile's processed_files convention
   *  (show/Sxx/name). Best-effort — never throws. */
  function attachSeasonProcessed(requestId: number, libraryKey: string, baseTitle: string, season: number): void {
    try {
      const folder = seasonFolderForLibraryKey(db, libraryKey, baseTitle, season);
      if (!folder || !fs.existsSync(folder)) return;
      const rels: string[] = [];
      for (const f of fs.readdirSync(folder)) {
        if (!VIDEO_FILE_RE.test(f)) continue;
        rels.push(path.relative(PROCESSED_TV, path.join(folder, f)));
      }
      if (!rels.length) return;
      const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(requestId) as any;
      if (ah) {
        const existing: string[] = JSON.parse(ah.processed_files || "[]");
        let changed = false;
        for (const p of rels) if (!existing.includes(p)) { existing.push(p); changed = true; }
        if (changed) db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
      } else {
        db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(requestId, JSON.stringify(rels));
      }
    } catch {}
  }

  // POST /api/requests/native-franchise/:id/ensure-season - find or create the
  // media_requests row for a disk-first native season so its tools (Open
  // Releases) have a request to open. Mirrors the library reconcile: a dormant
  // COMPLETED row keyed by library_key+season, with its processed files attached.
  router.post("/native-franchise/:id/ensure-season", (req: Request, res: Response) => {
    try {
      const seed = db.prepare("SELECT id, title, library_key, type FROM media_requests WHERE id = ?").get(Number(req.params.id)) as any;
      if (!seed || seed.type !== "series" || !seed.library_key) {
        return res.status(404).json({ error: "Series request with library_key not found" });
      }
      const raw = Math.trunc(Number(req.body?.season));
      const sNum = Number.isFinite(raw) && raw >= 0 ? raw : 0;
      let row = db.prepare("SELECT id, status FROM media_requests WHERE type = 'series' AND library_key = ? AND season = ?").get(seed.library_key, sNum) as any;
      if (!row) {
        const title = cleanFranchiseTitle(seed.title || "");
        const created = db.prepare("INSERT INTO media_requests (title, type, season, status, requested_by, episode_count, library_key) VALUES (?, 'series', ?, 'COMPLETED', '[]', NULL, ?)").run(title, sNum, seed.library_key);
        row = { id: Number(created.lastInsertRowid) };
        attachSeasonProcessed(row.id, seed.library_key, title, sNum);
      } else if (row.status === "DISMISSED" || row.status == null) {
        // A dormant row the franchise list filters out — the user is opening it
        // because content is on disk, so promote it rather than create a twin.
        db.prepare("UPDATE media_requests SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
      }
      res.json({ request_id: row.id });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/requests/:id/processed - List processed files for this specific request
  router.get("/:id/processed", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);

      if (!fs.existsSync(processedDir)) return res.json({ files: [] });

      // Self-heal stale processed_files entries (manual mv/rename) before they
      // seed matchedNames — otherwise the panel silently drops renamed files.
      healProcessedFilesForRequest(db, request);
      backfillRequestIdentity(db, request);

      // Get approved releases for this request to match by content basename
      const releases = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).all(id) as any[];

      const matchedNames = new Set<string>();
      for (const rel of releases) {
        if (!rel.torrent_hash) continue;
        try {
          const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
          if (torrent) {
            const cp = fromQBittorrentPath(torrent.content_path);
            if (fs.existsSync(cp)) {
              const st = fs.statSync(cp);
              if (st.isDirectory()) {
                for (const e of fs.readdirSync(cp)) {
                  if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e)) matchedNames.add(e);
                }
              } else {
                matchedNames.add(path.basename(cp));
              }
            }
          }
        } catch {}
      }

      const wsDirs = listWorkspaces(request.id, request.title);
      for (const ws of wsDirs) {
        if (ws.metadata?.outputPaths) {
          for (const op of ws.metadata.outputPaths) {
            if (fs.existsSync(op)) matchedNames.add(path.basename(op));
          }
        }
      }

      const approvals = db.prepare(
        "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
      ).all(id) as any[];
      for (const ah of approvals) {
        try {
          const names = JSON.parse(ah.processed_files);
          for (const n of names) matchedNames.add(n);
        } catch {}
      }

      // Register the inodes this request already claims, BEFORE the library scan
      // below. The two lookups would otherwise deadlock exactly as they do in Fix
      // Names: a processed twin and its library copy are the same inode, and the
      // identity fallback is the only signal that can reach a folder whose name
      // states neither the card title nor an id ("Asterix i Obelix W sluzbie Jej
      // Krolewskiej Mosci (2012)"). Without this, "is it already in the library?"
      // is answered from an empty library scan, so the panel offers "To Library"
      // for a file that is sitting in the library right now. Runs after
      // matchedNames is complete, keyed by approval_history (an explicit
      // association) - never a fuzzy title guess.
      if (request.library_key) {
        const procDir = getProcessedDir(request.type === "series" ? "series" : "movie");
        for (const n of matchedNames) {
          const full = path.join(procDir, n);
          if (!fs.existsSync(full)) continue;
          try {
            if (!fs.statSync(full).isFile()) continue;
            registerVideoTree(db, full, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
          } catch {}
        }
      }

      // Fallback: scan the season-specific folder when no explicit associations
      if (matchedNames.size === 0 && request.sonarr_id != null && request.type === 'series') {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const fTitle = series.title;
          const seasonFolder = path.join(processedDir, fTitle, `S${String(request.season).padStart(2, "0")}`);
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                matchedNames.add(f);
                matchedNames.add(path.join(fTitle, `S${String(request.season).padStart(2, "0")}`, f));
              }
            }
          }
        } catch {}
      }

      // Determine library files for per-file in-library checks — match by inode (hardlinks share inode)
      const libraryInodes = new Set<number>();
      const libraryNameByInode = new Map<number, string>();
      const libraryFiles = new Set<string>();
      const librarySizes = new Map<number, string>();
      if (request.type === "series" && request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          const seasonFolder = path.join(
            series.path || path.join(MEDIA_TV, series.title),
            `S${String(seasonNum).padStart(2, "0")}`
          );
          if (fs.existsSync(seasonFolder)) {
            for (const f of fs.readdirSync(seasonFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                const fPath = path.join(seasonFolder, f);
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(fPath);
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, fPath);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, fPath);
                } catch {}
              }
            }
          }
        } catch {}
      } else if (request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const movieFolder = movie.path || movie.folderPath;
          if (movieFolder && fs.existsSync(movieFolder)) {
            for (const f of fs.readdirSync(movieFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                const fPath = path.join(movieFolder, f);
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(fPath);
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, fPath);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, fPath);
                } catch {}
              }
            }
          }
        } catch {}
      } else if (request.library_key && request.type === "series") {
        // Native (arr-free) series — scan the library season folder the same way
        // move-to-library resolves it (fuzzy show folder, localized season
        // folders like "Sezon I"), matching by inode for hardlinks.
        try {
          const libFolder = resolveLibraryFolder(request);
          if (libFolder && fs.existsSync(libFolder)) {
            for (const f of fs.readdirSync(libFolder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                const fPath = path.join(libFolder, f);
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(fPath);
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, fPath);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, fPath);
                } catch {}
              }
            }
          }
        } catch {}
      } else if (request.library_key && request.type === "movie") {
        // Native (arr-free) movie — movies live in a "<Title> (Year)/" subfolder
        // under MEDIA_MOVIES, so resolve the folder(s) and scan each.
        try {
          for (const folder of nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key)) {
            if (!fs.existsSync(folder)) continue;
            for (const f of fs.readdirSync(folder)) {
              if (/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) {
                const fPath = path.join(folder, f);
                libraryFiles.add(f);
                try {
                  const st = fs.statSync(fPath);
                  libraryInodes.add(st.ino);
                  librarySizes.set(st.size, fPath);
                  if (!libraryNameByInode.has(st.ino)) libraryNameByInode.set(st.ino, fPath);
                } catch {}
              }
            }
          }
        } catch {}
      }

      const requestTitleNorm = (request.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

      // Collect all files from processedDir — flat or nested (series use SeriesName/S##/ structure)
      type ProcessedEntry = { name: string; relPath: string; fullPath: string; isDir: boolean };
      const allEntries: ProcessedEntry[] = [];
      const targetSeason = request.type === "series" && request.season != null
        ? `S${String(request.season).padStart(2, "0")}` : null;
      for (const entry of fs.readdirSync(processedDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(processedDir, entry.name);
        if (entry.isDirectory()) {
          // Series subfolder — only scan the season dir matching this request (if applicable)
          for (const sub of fs.readdirSync(fullPath, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            if (!/^S\d+$/i.test(sub.name)) continue;
            if (targetSeason && sub.name.toUpperCase() !== targetSeason) continue;
            const seasonDir = path.join(fullPath, sub.name);
            for (const f of fs.readdirSync(seasonDir)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(f)) continue;
              allEntries.push({ name: f, relPath: path.join(entry.name, sub.name, f), fullPath: path.join(seasonDir, f), isDir: false });
            }
          }
        } else {
          allEntries.push({ name: entry.name, relPath: entry.name, fullPath, isDir: false });
        }
      }

      const files: { name: string; size: number; isDir: boolean; inLibrary: boolean; libraryPath: string }[] = [];
      const hasExplicitAssociations = matchedNames.size > 0;

      for (const e of allEntries) {
        const fullPath = e.fullPath;
        let size = 0;
        let ino = 0;
        try {
          const st = fs.statSync(fullPath);
          size = st.size;
          ino = st.ino;
        } catch {}

        // Accept when: explicitly associated (name/relPath), OR the file is a
        // hardlink of one of the request's library files (inode — authoritative
        // even when a torrent is linked and association bookkeeping is lost),
        // OR registered identity claims it for this request's library_key
        // (survives a remove-from-library dropping the library twin), OR
        // title-match fallback when the request has zero explicit associations.
        const linkedToLibrary = ino > 0 && libraryInodes.has(ino);
        const identityRow = request.library_key ? identifyByPath(db, fullPath) : null;
        let identityHit = !!(identityRow && identityRow.library_key === request.library_key);
        // A row naming a library_key no request holds is unattributable, not a
        // statement about this file — a retitle performed before media_files was
        // migrated with the key leaves exactly that behind. Treat it as carrying
        // no identity here too, so the panel does not drop a file the card does
        // own (the same phantom veto that hid it from Fix Names).
        if (identityRow && !identityHit && request.library_key) {
          try {
            const owner = db
              .prepare("SELECT COUNT(*) c FROM media_requests WHERE library_key = ?")
              .get(identityRow.library_key) as any;
            if (!owner || !owner.c) {
              registerVideoTree(db, fullPath, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
              identityHit = true;
            }
          } catch {}
        }
        // An embedded id belonging to another film is decisive: "Mufasa The Lion
        // King (2024)" is not a file of "The Lion King (1994)" no matter which
        // names, inode or title heuristic happens to line up.
        if (nameContradictsRequest(db, request, e.name)) continue;
        // ...and so is a file whose own library twin is filed under a year a
        // sibling request owns. Some releases state no year at all, so the name
        // veto above is silent for them and every same-franchise card would
        // claim the file. The twin's folder is the only place the year is written
        // down. Checked BEFORE the identity/inode branches below, because a stale
        // media_files row must not outrank a folder that plainly says otherwise.
        if (libraryFolderContradicts(db, request, libraryNameByInode.get(ino) || null)) {
          reassignFileByLibraryFolder(db, request, fullPath, libraryNameByInode.get(ino) || null);
          continue;
        }
        if (matchedNames.has(e.name) || matchedNames.has(e.relPath) || linkedToLibrary || identityHit) {
          // Admitted with no identity row of its own (it matched approval_history by
          // name, or is a twin of one of our library files). Claim the inode here
          // for the same reason as the Fix Names scan: an unregistered inode cannot
          // be found by identity from the library side, which leaves a folder whose
          // name states neither the card title nor an id unreachable. Same evidence
          // that admitted the file, so nothing is claimed on a fuzzy guess.
          if (request.library_key && ino > 0 && !identityHit) {
            try {
              registerVideoTree(db, fullPath, { library_key: request.library_key, title: request.title || "", season: request.season ?? 0 });
            } catch {}
          }
        } else {
          if (!hasExplicitAssociations) {
            const entryNorm = e.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (!titlesMatch(requestTitleNorm, entryNorm)) continue;
          } else {
            continue;
          }
        }
        const inLibrary = linkedToLibrary
          || libraryFiles.has(e.name)
          || (e.isDir && [...libraryFiles].some((lf) => lf.startsWith(e.name)))
          || (size > 0 && librarySizes.has(size));
        let libraryMatch = "";
        if (inLibrary) {
          libraryMatch = libraryNameByInode.get(ino) || [...libraryFiles].find((lf) => lf === e.name || lf.startsWith(e.name)) || librarySizes.get(size) || "";
        }
        files.push({ name: e.relPath, size, isDir: e.isDir, inLibrary, libraryPath: libraryMatch });
      }

      res.json({ files, processedDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/scan - Return unlinked files in processed dir (exclude files already matched to other requests)
  // For movies with radarr_id, also imports from Radarr library into processed first
  router.post("/:id/processed/scan", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      // For movie requests with radarr_id, try to import from Radarr library first
      if (request.type === "movie" && request.radarr_id) {
        try {
          const movie = await radarr.getMovie(request.radarr_id);
          const processedDir2 = PROCESSED_MOVIES;
          const imported: string[] = [];
          const hasTrackedTorrent = (db.prepare("SELECT COUNT(*) as cnt FROM release_candidates WHERE request_id = ? AND torrent_hash != ''").get((request as any).id) as any).cnt > 0;
          const filePath = movie.movieFile?.path;
          if (filePath && fs.existsSync(filePath)) {
            const fileName = path.basename(filePath);
            // Skip main movie file if request already has a tracked torrent (already in /processed via MoveToProcessed)
            if (!hasTrackedTorrent) {
              const destPath = path.join(processedDir2, fileName);
              const srcIno = (() => { try { return fs.statSync(filePath).ino; } catch { return 0; } })();
              let already = false;
              if (srcIno > 0) {
                for (const existing of fs.readdirSync(processedDir2)) {
                  try { if (fs.statSync(path.join(processedDir2, existing)).ino === srcIno) { already = true; break; } } catch {}
                }
              } else if (fs.existsSync(destPath)) { already = true; }
              if (!already) {
                fs.linkSync(filePath, destPath);
                imported.push(fileName);
              }
            }
          }
          const movieFolder = movie.path || path.dirname(filePath || "");
          if (fs.existsSync(movieFolder)) {
            for (const entry of fs.readdirSync(movieFolder)) {
              if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
              if (entry === path.basename(filePath || "")) continue;
              const extraPath = path.join(movieFolder, entry);
              const extraDest = path.join(processedDir2, entry);
              const extraIno = (() => { try { return fs.statSync(extraPath).ino; } catch { return 0; } })();
              let alreadyExtra = false;
              if (extraIno > 0) {
                for (const existing of fs.readdirSync(processedDir2)) {
                  try { if (fs.statSync(path.join(processedDir2, existing)).ino === extraIno) { alreadyExtra = true; break; } } catch {}
                }
              } else if (fs.existsSync(extraDest)) { alreadyExtra = true; }
              if (!alreadyExtra) {
                try { fs.linkSync(extraPath, extraDest); imported.push(entry); } catch {}
              }
            }
          }
          if (imported.length > 0) {
            if (request.status !== 'COMPLETED' && request.status !== 'DOWNLOADING' && request.status !== 'SEEDING') {
              db.prepare("UPDATE media_requests SET status = 'COMPLETED' WHERE id = ?").run(request.id);
            }
            const ah = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(request.id) as any;
            if (ah) {
              const existing = JSON.parse(ah.processed_files || "[]");
              for (const f of imported) { if (!existing.includes(f)) existing.push(f); }
              db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(existing), ah.id);
            } else {
              db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(request.id, JSON.stringify(imported));
            }
          }
        } catch {}
      }

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      if (!fs.existsSync(processedDir)) return res.json({ files: [] });

      // Collect names already matched to OTHER requests
      const otherNames = new Set<string>();
      const otherRequests = db.prepare("SELECT id, type FROM media_requests WHERE id != ?").all(id) as any[];
      for (const other of otherRequests) {
        const otherType = other.type === "series" ? "series" : "movie";
        if (otherType !== type) continue;
        const rels = db.prepare(
          "SELECT rc.* FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).all(other.id) as any[];
        for (const rel of rels) {
          if (!rel.torrent_hash) continue;
          try {
            const torrent = await qbittorrent.getTorrentByHash(rel.torrent_hash);
            if (torrent) otherNames.add(path.basename(torrent.content_path));
          } catch {}
        }
        const otherApprovals = db.prepare(
          "SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'"
        ).all(other.id) as any[];
        for (const ah of otherApprovals) {
          try {
            const names = JSON.parse(ah.processed_files);
            for (const n of names) otherNames.add(n);
          } catch {}
        }
      }

      const entries = fs.readdirSync(processedDir, { withFileTypes: true });
      const files: { name: string; size: number; isDir: boolean }[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (otherNames.has(entry.name)) continue;
        // Movies live flat in one shared dir, so the unlinked-files picker must
        // not offer a same-titled other film ("Mufasa The Lion King (2024)" for
        // "The Lion King (1994)") — associating it would forge the link.
        if (nameContradictsRequest(db, request, entry.name)) continue;
        const fullPath = path.join(processedDir, entry.name);
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch {}
        files.push({ name: entry.name, size, isDir: entry.isDirectory() });
      }

      res.json({ files, processedDir });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/associate - Associate processed file(s) with this request
  router.post("/:id/processed/associate", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { fileNames } = req.body || {};
      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return res.status(400).json({ error: "fileNames array required" });
      }

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);

      // Collect all already-associated filenames AND inodes across ALL AH rows for this request
      const allExisting = new Set<string>();
      const existingInodes = new Set<number>();
      const allAh = db.prepare("SELECT processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(id) as any[];
      for (const ah of allAh) {
        try {
          const arr = JSON.parse(ah.processed_files);
          for (const f of arr) {
            allExisting.add(f);
            try { const st = fs.statSync(path.join(processedDir, f)); if (st.ino > 0) existingInodes.add(st.ino); } catch {}
          }
        } catch {}
      }

      // A name carrying another film's IMDb id is refused outright: associating it
      // would create exactly the false link the picker filters out (same title,
      // different movie). Report it rather than silently accepting.
      const rejected = fileNames.filter((f: string) => nameContradictsRequest(db, request, f));
      if (rejected.length) {
        return res.status(409).json({
          error: `These files belong to a different movie (mismatched IMDb id): ${rejected.join(", ")}`,
          rejected,
        });
      }

      // Filter out filenames already associated by name OR inode (hardlink dedup)
      const newNames = fileNames.filter((f: string) => {
        if (allExisting.has(f)) return false;
        try { const st = fs.statSync(path.join(processedDir, f)); return !(st.ino > 0 && existingInodes.has(st.ino)); } catch { return true; }
      });
      if (newNames.length === 0) return res.json({ success: true, message: "Already associated" });

      // Use or create an AH row with release_id IS NULL (library import row)
      const approval = db.prepare(
        "SELECT ah.id, ah.processed_files FROM approval_history ah WHERE ah.request_id = ? AND ah.release_id IS NULL ORDER BY ah.approved_at DESC LIMIT 1"
      ).get(id) as any;

      if (approval) {
        const existing = JSON.parse(approval.processed_files || "[]");
        const merged = [...new Set([...existing, ...newNames])];
        db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(merged), approval.id);
        res.json({ success: true });
      } else {
        const ahId = db.prepare(
          "INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)"
        ).run(id, JSON.stringify(newNames)).lastInsertRowid;
        res.json({ success: true, approvalId: ahId });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/processed/:fileName - Delete a processed file from disk and DB
  router.delete("/:id/processed/:fileName", (req: Request, res: Response) => {
    try {
      const { id, fileName } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const decoded = decodeURIComponent(fileName);
      const filePath = path.join(processedDir, decoded);

      if (!filePath.startsWith(processedDir)) {
        return res.status(400).json({ error: "Invalid path" });
      }

      // Remove from processed_files arrays in ALL AH rows for this request
      const allAh = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND processed_files IS NOT NULL AND processed_files != '[]'").all(id) as any[];
      for (const ah of allAh) {
        try {
          const arr = JSON.parse(ah.processed_files);
          const filtered = arr.filter((f: string) => f !== decoded);
          if (filtered.length !== arr.length) {
            db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(filtered), ah.id);
          }
        } catch {}
      }

      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
      console.log(`[Processed] Deleted ${filePath}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/processed/:fileName/to-workspace - Hardlink a processed file to workspace
  router.post("/:id/processed/:fileName/to-workspace", async (req: Request, res: Response) => {
    try {
      const { id, fileName } = req.params;
      const { name, notes, scripts, workspaceIndex } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);
      const filePath = path.join(processedDir, decodeURIComponent(fileName));

      if (!filePath.startsWith(processedDir)) {
        return res.status(400).json({ error: "Invalid path" });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found in processed" });
      }

      const wsConfig: any = {};
      if (name) wsConfig.name = name;
      if (notes) wsConfig.notes = notes;
      if (scripts) wsConfig.scripts = scripts;

      const result = moveToWorkspaceSync(filePath, request.id, request.title, workspaceIndex, undefined, undefined, Object.keys(wsConfig).length > 0 ? wsConfig : undefined);
      if (!result.success) return res.status(500).json({ error: result.error });

      console.log(`[ProcessedToWorkspace] ${filePath} → ${result.destination}`);
      res.json({ success: true, source: filePath, destination: result.destination });
    } catch (error: any) {
      console.error("Error moving processed to workspace:", error);
      res.status(500).json({ error: `Failed to move to workspace: ${error.message}` });
    }
  });

  // GET /api/requests/:id/workspaces - List existing workspaces for this request
  router.get("/:id/workspaces", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });
      const workspaces = listWorkspaces(request.id, request.title);
      res.json({ workspaces });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/requests/:id/workspaces/:index - Update workspace metadata
  router.patch("/:id/workspaces/:index", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const { name, notes, status } = req.body || {};
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;

      writeWorkspaceMetadata(ws.path, updates);
      const updated = readWorkspaceMetadata(ws.path);
      res.json({ success: true, metadata: updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/workspaces/:index/complete - Complete workspace: delete inputs, move outputs to processed
  router.post("/:id/workspaces/:index/complete", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const type = request.type === "series" ? "series" : "movie";
      const result = completeWorkspace(ws.path, type);
      if (!result.success) return res.status(400).json({ error: result.error });

      const outputBasenames = result.processedPaths.map((p) => path.basename(p));

      // Workspace outputs were MOVED (renameSync) — these are brand-new inodes,
      // so they MUST be registered here or identity is lost forever.
      if (result.processedPaths.length > 0) {
        registerVideoTree(db, path.dirname(result.processedPaths[0]), {
          library_key: request.library_key || "",
          title: request.title || "",
          season: request.season ?? 0,
        });
      }

      const approval = db.prepare(
        "SELECT ah.id FROM approval_history ah WHERE ah.request_id = ? ORDER BY ah.approved_at DESC LIMIT 1"
      ).get(id) as any;
      if (approval) {
        const existing = JSON.parse((db.prepare("SELECT processed_files FROM approval_history WHERE id = ?").get(approval.id) as any)?.processed_files || "[]");
        const merged = [...new Set([...existing, ...outputBasenames])];
        db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(merged), approval.id);
      }

      const processedDir = getProcessedDir(type);
      if (type === "movie" && request.radarr_id) {
        radarr.scanDownloadedMovie(processedDir, request.radarr_id).catch(() => {});
      } else if (type === "series" && request.sonarr_id) {
        sonarr.scanDownloadedEpisodes(processedDir, request.sonarr_id).catch(() => {});
      }

      console.log(`[Workspace] Completed ${ws.dirName}: inputs removed, ${result.processedPaths.length} output(s) moved to processed`);
      res.json({ success: true, processedPaths: result.processedPaths });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/workspaces/:index/clean - Delete inputs only (keep outputs)
  router.post("/:id/workspaces/:index/clean", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const count = deleteWorkspaceInputs(ws.path);
      console.log(`[Workspace] Cleaned ${count} input(s) from ${ws.dirName}`);
      res.json({ success: true, deleted: count });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/workspaces/:index/file/:subDir/:fileName - Delete a single file from workspace
  router.delete("/:id/workspaces/:index/file/:subDir/:fileName", async (req: Request, res: Response) => {
    try {
      const { id, index, subDir, fileName } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (subDir !== "inputs" && subDir !== "output") return res.status(400).json({ error: "subDir must be 'inputs' or 'output'" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      const deleted = deleteWorkspaceFile(ws.path, subDir, decodeURIComponent(fileName));
      if (!deleted) return res.status(404).json({ error: "File not found" });

      console.log(`[Workspace] Deleted ${subDir}/${decodeURIComponent(fileName)} from ${ws.dirName}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/requests/:id/workspaces/:index - Delete entire workspace
  router.delete("/:id/workspaces/:index", async (req: Request, res: Response) => {
    try {
      const { id, index } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      const workspaces = listWorkspaces(request.id, request.title);
      const ws = workspaces.find((w) => w.index === Number(index));
      if (!ws) return res.status(404).json({ error: "Workspace not found" });

      deleteWorkspace(ws.path);
      console.log(`[Workspace] Deleted entire workspace ${ws.dirName}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/requests/:id/move-to-workspace - Hardlink files from download folder to workspace for manual preprocessing
  router.post("/:id/move-to-workspace", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { releaseId, name, notes, scripts } = req.body || {};
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      let release;
      if (releaseId) {
        release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      } else {
        release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ? " +
          "ORDER BY ah.approved_at DESC LIMIT 1"
        ).get(id) as any;
      }

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) return res.status(404).json({ error: "Torrent not found in qBittorrent" });

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      const wsConfig: any = {};
      if (name) wsConfig.name = name;
      if (notes) wsConfig.notes = notes;
      if (scripts) wsConfig.scripts = scripts;

      const result = moveToWorkspaceSync(contentPath, request.id, request.title, req.body?.workspaceIndex, release.id, release.torrent_hash, Object.keys(wsConfig).length > 0 ? wsConfig : undefined);
      if (!result.success) return res.status(500).json({ error: result.error });

      console.log(`[MoveToWorkspace] ${contentPath} → ${result.destination}`);
      res.json({ success: true, source: contentPath, destination: result.destination });
    } catch (error: any) {
      console.error("Error moving to workspace:", error);
      res.status(500).json({ error: `Failed to move to workspace: ${error.message}` });
    }
  });

  // POST /api/requests/:id/move-to-library - Hardlink files from processed folder to library
  router.post("/:id/move-to-library", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { fileName } = req.body as { fileName?: string };
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const type = request.type === "series" ? "series" : "movie";
      const processedDir = getProcessedDir(type);

      let sourcePath = "";
      let destFolder = "";

      // A request whose content has reached the library is complete. Only
      // DOWNLOADING/SEEDING rows are eligible — earlier states still need their
      // release fetched, later ones are already final.
      const markCompleted = () => {
        if (request.status === "DOWNLOADING" || request.status === "SEEDING") {
          db.prepare("UPDATE media_requests SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(request.id);
        }
      };

      if (fileName) {
        // Direct file lookup in processed dir — used by processed panel
        sourcePath = path.join(processedDir, fileName);
        if (!fs.existsSync(sourcePath)) {
          return res.status(404).json({ error: `Processed file not found: ${fileName}` });
        }
      } else {
        // TorrentPanel: hardlink directly from download content to library (no processed entry)
        const release = db.prepare(
          "SELECT rc.* FROM release_candidates rc " +
          "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
        ).get(id) as any;

        if (!release || !release.torrent_hash) {
          if (request.library_key) {
            return res.status(400).json({ error: "arr-free request — use the per-file To Library button in the processed panel" });
          }
          return res.status(400).json({ error: "No torrent found for this request" });
        }

        const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
        if (!torrent) {
          return res.status(404).json({ error: "Torrent not found in qBittorrent" });
        }

        let contentPath = torrent.content_path;
        if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
        if (!fs.existsSync(contentPath)) {
          return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
        }

        sourcePath = contentPath;
      }

      if (request.type === "series" && request.sonarr_id) {
        try {
          const series = await sonarr.getSeries(request.sonarr_id);
          const seasonNum = request.season || 1;
          destFolder = path.join(
            series.path || path.join(MEDIA_TV, series.title),
            `S${String(seasonNum).padStart(2, "0")}`
          );
        } catch {
          return res.status(500).json({ error: "Could not determine series folder from Sonarr" });
        }
      } else if (request.radarr_id) {
        const movie = await radarr.getMovie(request.radarr_id);
        destFolder = movie.path || movie.folderPath;
        if (!destFolder) {
          return res.status(500).json({ error: "Could not determine movie folder from Radarr" });
        }
      } else if (request.library_key) {
        // Native (arr-free) request: resolve the library destination from the
        // title, tolerating localized names / year suffixes like the processed
        // folder lookups do.
        if (request.type === "series") {
          const baseTitle = (request.title || "").replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
          let showFolder = path.join(MEDIA_TV, baseTitle);
          if (!fs.existsSync(showFolder)) {
            const want = normalizeFolder(baseTitle);
            let found: string | null = null;
            try {
              for (const d of fs.readdirSync(MEDIA_TV)) {
                const norm = normalizeFolder(d);
                if (!norm) continue;
                if (norm === want || (want.length >= 6 && norm.includes(want)) || (norm.length >= 6 && want.includes(norm))) {
                  found = d;
                  break;
                }
              }
            } catch {}
            if (found) showFolder = path.join(MEDIA_TV, found);
          }
          if (!fs.existsSync(showFolder)) {
            return res.status(500).json({ error: "Could not locate library folder for this series" });
          }
          const seasonNum = request.season || 1;
          destFolder = findExistingSeasonFolder(showFolder, seasonNum) || path.join(showFolder, `S${String(seasonNum).padStart(2, "0")}`);
        } else {
          // Native movie: place into the matching "<Title> (Year)/" library
          // subfolder when one exists (same resolution the processed panel's
          // in-library scan uses), else the MEDIA_MOVIES root.
          const folders = nativeMovieLibraryFolders(request.title || "", requestImdbId(db, request), db, request.library_key);
          destFolder = folders[0] && folders[0] !== MEDIA_MOVIES ? folders[0] : MEDIA_MOVIES;
        }
        try {
          if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
        } catch {}
      } else {
        return res.status(400).json({ error: "No Radarr or Sonarr ID associated" });
      }

      // P1 canonical naming: for native (arr-free) requests, name NEW library
      // files per the naming template instead of copying the release basename.
      // Dirs keep their structure; null means "keep raw name, never guess".
      let destFileName = path.basename(sourcePath);
      if (request.library_key && !fs.statSync(sourcePath).isDirectory()) {
        try {
          const probe = await probeVideoFile(sourcePath);
          const canonical = await canonicalFileBase(
            db,
            request,
            path.basename(sourcePath),
            request.type === "series" ? path.dirname(destFolder) : destFolder,
            probe,
          );
          if (canonical) destFileName = `${canonical}${path.extname(sourcePath)}`;
        } catch {}
      }

      // Same-inode destination returns unchanged (idempotent already-exists);
      // a different file at the canonical name gets a "-2" suffix so multiple
      // versions of a movie/special coexist instead of silently skipping.
      const srcStat0 = fs.statSync(sourcePath);
      const destPath = uniqueDestPath(path.join(destFolder, destFileName), srcStat0.ino);

      if (fs.existsSync(destPath)) {
        markCompleted();
        return res.json({ success: true, message: "File already exists in library", source: sourcePath, destination: destPath, alreadyExists: true });
      }

      // Check if any file in library folder has the same inode (already there, possibly renamed)
      try {
        const srcStat = fs.statSync(sourcePath);
        if (srcStat.ino > 0) {
          const libFiles = fs.readdirSync(destFolder).filter((f: string) => /\.(mkv|mp4|avi|mov|ts|wmv|bdmv)$/i.test(f));
          for (const lf of libFiles) {
            try {
              const lfStat = fs.statSync(path.join(destFolder, lf));
              if (lfStat.ino === srcStat.ino && lfStat.ino > 0) {
                markCompleted();
                return res.json({ success: true, message: "File already in library", source: sourcePath, destination: path.join(destFolder, lf), alreadyExists: true });
              }
            } catch {}
          }
          // Also check BDMV directories
          for (const lf of libFiles) {
            if (lf === "BDMV") {
              try {
                const bdPath = path.join(destFolder, lf);
                const bdStat = fs.statSync(bdPath);
                if (bdStat.ino === srcStat.ino && bdStat.ino > 0) {
                  markCompleted();
                  return res.json({ success: true, message: "File already in library", source: sourcePath, destination: path.join(destFolder, lf), alreadyExists: true });
                }
              } catch {}
            }
          }
        }
      } catch {}

      const stat = fs.statSync(sourcePath);

      // Let Radarr/Sonarr handle the file placement + rename
      let importResult = { success: false, error: "" };
      if (request.type === "series" && request.sonarr_id) {
        importResult = await sonarr.manualImport(sourcePath, request.sonarr_id, request.season || 1) as any;
      } else if (request.radarr_id) {
        importResult = await radarr.manualImport(sourcePath, request.radarr_id) as any;
      }

      if (!importResult.success) {
        // Fallback: hardlink ourselves
        console.log(`[MoveToLibrary] Manual import failed, falling back to hardlink`);
        if (stat.isDirectory()) {
          hardlinkDirRecursive(sourcePath, path.join(destFolder, path.basename(sourcePath)));
        } else {
          fs.mkdirSync(destFolder, { recursive: true });
          try {
            fs.linkSync(sourcePath, destPath);
          } catch (linkErr: any) {
            if (linkErr.code === "EXDEV") {
              console.warn(`[MoveToLibrary] Cross-device link, falling back to copy`);
              fs.copyFileSync(sourcePath, destPath);
            } else {
              throw linkErr;
            }
          }
        }
      }

      const finalDest = importResult.success ? sourcePath : destPath;
      const method = importResult.success ? "imported via Radarr/Sonarr" : (fs.existsSync(destPath) && fs.statSync(destPath).nlink > 1 ? "hardlinked" : "copied");
      console.log(`[MoveToLibrary] ${method} ${sourcePath} -> ${finalDest}`);

      // Register identity on both trees — source (processed) and dest (library);
      // copy fallbacks create a new inode, so both sides are recorded.
      const identity = {
        library_key: request.library_key || "",
        title: request.title || "",
        season: request.season ?? 0,
      };
      registerVideoTree(db, sourcePath, identity);
      registerVideoTree(db, destPath, identity);

      markCompleted();
      if (fileName) {
        const ah = db.prepare(
          "SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1"
        ).get(request.id) as any;
        const list: string[] = ah ? (JSON.parse(ah.processed_files || "[]") as string[]) : [];
        const base = path.basename(destPath);
        if (!list.includes(base)) list.push(base);
        if (ah) {
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(list), ah.id);
        } else {
          db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(request.id, JSON.stringify(list));
        }
      }

      res.json({ success: true, message: `Files ${method} to library`, source: sourcePath, destination: finalDest });
    } catch (error: any) {
      console.error("Error moving to library:", error);
      if (error?.code === "EACCES") {
        const folder = typeof error.path === "string" ? path.dirname(error.path) : "";
        return res.status(403).json({
          error: `Permission denied — the library folder is owned by another user (root from a Sonarr/Radarr import). Fix on the server: sudo chown -R <appuser>:<appuser> "${folder}"`,
        });
      }
      res.status(500).json({ error: `Failed to move to library: ${error.message}` });
    }
  });

  // POST /api/requests/:id/process - Process downloaded files through workspace to processed folder
  router.post("/:id/process", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const release = db.prepare(
        "SELECT rc.* FROM release_candidates rc " +
        "JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?"
      ).get(id) as any;

      if (!release || !release.torrent_hash) {
        return res.status(400).json({ error: "No torrent found for this request" });
      }

      const torrent = await qbittorrent.getTorrentByHash(release.torrent_hash);
      if (!torrent) {
        return res.status(404).json({ error: "Torrent not found in qBittorrent" });
      }

      let contentPath = torrent.content_path;
      if (!fs.existsSync(contentPath)) contentPath = fromQBittorrentPath(contentPath);
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Content path not found: ${torrent.content_path}` });
      }

      const type = request.type === "series" ? "series" : "movie";
      const destFolder = getProcessedDir(type);

      const options: ProcessOptions = {
        stripAudioTracks: req.body?.stripAudioTracks,
        keepAudioTracks: req.body?.keepAudioTracks,
        removeSubtitles: req.body?.removeSubtitles,
        audioCodec: req.body?.audioCodec,
      };

      const result = await processToLibrary(contentPath, destFolder, options, request.id, request.title);

      if (result.success) {
        console.log(`[Process] ${result.method} ${result.sourceFiles.length} file(s) → ${destFolder}`);
      }

      res.json({
        success: result.success,
        method: result.method,
        sourceFiles: result.sourceFiles,
        outputFiles: result.outputFiles,
        workspaceDir: `${request.id}-${request.title}`,
        error: result.error,
      });
    } catch (error: any) {
      console.error("Error processing files:", error);
      res.status(500).json({ error: `Failed to process files: ${error.message}` });
    }
  });

  // POST /api/requests/:id/search - Re-search for releases (SSE progress)
  router.post("/:id/search", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const { id } = req.params;
    const { searchTerm } = req.body || {};
    const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;

    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "close");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      db.prepare("DELETE FROM release_candidates WHERE request_id = ? AND id NOT IN (SELECT release_id FROM approval_history WHERE request_id = ?)").run(id, id);
      const prevStatus = request.status;
      const preserveStatus = prevStatus === "DOWNLOADING" || prevStatus === "SEEDING";
      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'SEARCHING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }

      const service = request.type === "series" ? "Sonarr" : "Radarr";
      send("progress", { step: "searching", message: `Querying Prowlarr for releases...` });

      let releases: RadarrSearchResult[] = [];

      const searchTimeout = (p: Promise<any>, ms: number) => Promise.race([
        p,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Search timed out")), ms))
      ]);

      const prowlarrApiKey = process.env.PROWLARR_API_KEY;
      const useProwlarr = !!prowlarr && !!process.env.PROWLARR_URL && !!prowlarrApiKey;

      try {
        if (useProwlarr) {
          const rawQuery = searchTerm || request.title;
          const episodePrefix = rawQuery.trim().match(/^(S\d{1,2}E\d{1,3}(?:E\d{1,3})*)\s*(.*)/i);
          let query: string;
          if (episodePrefix) {
            const baseTitle = request.title.replace(/\s+S\d{1,2}$/i, "").trim();
            const episodeName = episodePrefix[2] || "";
            query = `${baseTitle} ${episodePrefix[1]}${episodeName ? " " + episodeName : ""}`.trim();
          } else {
            query = rawQuery;
          }
          const categories = request.type === "movie" ? [2000] : [5000];
          send("progress", { step: "searching", message: `Searching Prowlarr: "${query}"...` });
          const prowlarrResults = await searchTimeout(prowlarr.search(query, categories), 45000);
          releases = prowlarrResults.map(mapProwlarrToRadarrResult);
          console.log(`[Search] Prowlarr returned ${releases.length} results for "${query}"`);
        } else {
          send("progress", { step: "searching", message: `Querying ${service} for releases...` });
          if (request.type === "series" && request.sonarr_id != null && request.season != null) {
            releases = await searchTimeout(sonarr.searchReleases(request.sonarr_id, request.season, searchTerm || undefined), 60000);
          } else if (request.radarr_id) {
            releases = await searchTimeout(radarr.searchReleases(request.radarr_id, searchTerm || undefined), 60000);
          } else {
            send("error", { error: "No search backend: native request and Prowlarr is not configured (set PROWLARR_URL and PROWLARR_API_KEY), or no Radarr/Sonarr ID associated" });
            res.end();
            return;
          }
        }
      } catch (searchErr) {
        console.error(`[Search] ${request.title} timed out or failed:`, (searchErr as Error).message);
        if (!preserveStatus) {
          db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        }
        send("error", { error: "Search timed out or failed" });
        res.end();
        return;
      }

      send("progress", { step: "found", message: `Found ${releases.length} release(s), scoring...`, total: releases.length });

      const insertStmt = db.prepare(`
        INSERT INTO release_candidates
        (request_id, radarr_release_id, title, indexer, size_mb, radarr_quality, radarr_custom_formats, app_score, radarr_rank, language, info_url, seeders, leechers, release_group, edition, protocol, publish_date, radarr_indexer_id, torrent_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id, radarr_release_id) DO UPDATE SET
          title = excluded.title,
          indexer = excluded.indexer,
          size_mb = excluded.size_mb,
          radarr_quality = excluded.radarr_quality,
          radarr_custom_formats = excluded.radarr_custom_formats,
          app_score = excluded.app_score,
          radarr_rank = excluded.radarr_rank,
          language = CASE WHEN excluded.language != '' THEN excluded.language ELSE release_candidates.language END,
          info_url = CASE WHEN excluded.info_url != '' THEN excluded.info_url ELSE release_candidates.info_url END,
          seeders = excluded.seeders,
          leechers = excluded.leechers,
          release_group = CASE WHEN excluded.release_group != '' THEN excluded.release_group ELSE release_candidates.release_group END,
          edition = CASE WHEN excluded.edition != '' THEN excluded.edition ELSE release_candidates.edition END,
          protocol = CASE WHEN excluded.protocol != '' THEN excluded.protocol ELSE release_candidates.protocol END,
          publish_date = CASE WHEN excluded.publish_date != '' THEN excluded.publish_date ELSE release_candidates.publish_date END,
          radarr_indexer_id = CASE WHEN excluded.radarr_indexer_id != 0 THEN excluded.radarr_indexer_id ELSE release_candidates.radarr_indexer_id END,
          torrent_hash = CASE WHEN excluded.torrent_hash != '' THEN excluded.torrent_hash ELSE release_candidates.torrent_hash END
      `);

      for (let i = 0; i < releases.length; i++) {
        const r = releases[i];
        const sizeMb = Math.round((r.size || 0) / (1024 * 1024));
        const qualityName = r.quality?.quality?.name || "Unknown";
        const cfNames = r.customFormats?.map((f: any) => f.name) || [];
        const customFormats = JSON.stringify(cfNames);
        const appScore = computeAppScore(qualityName, cfNames, sizeMb, i + 1);
        const language = r.languages?.map((l: any) => l.name).join(", ") || r.language?.name || "";

        insertStmt.run(id, r.guid, r.title, r.indexer, sizeMb, qualityName, customFormats, appScore, i + 1, language, r.infoUrl || "", r.seeders ?? null, r.leechers ?? null, r.releaseGroup || "", r.edition || "", r.protocol || "", r.publishDate || "", (r as any).indexerId ?? 0, r.infoHash || "");

        if ((i + 1) % 10 === 0 || i === releases.length - 1) {
          send("progress", { step: "indexing", message: `Indexed ${i + 1}/${releases.length}`, current: i + 1, total: releases.length });
        }
      }

      if (!preserveStatus) {
        db.prepare("UPDATE media_requests SET status = 'AWAITING_APPROVAL', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      }

      send("done", { success: true, releasesFound: releases.length });
      console.log(`[Search] ${request.title}: done (${releases.length} releases, ${Date.now() - startTime}ms)`);
      res.end();
    } catch (error) {
      console.error("Error searching releases:", error);
      send("error", { error: "Failed to search releases" });
      res.end();
    }
  });

  // POST /api/requests/:id/approve - Approve a release and grab via Radarr
  router.post("/:id/approve", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { releaseId, reason } = req.body;

      const release = db.prepare("SELECT * FROM release_candidates WHERE id = ?").get(releaseId) as any;
      if (!release) {
        return res.status(404).json({ error: "Release not found" });
      }

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const stmt = db.prepare(`
        INSERT INTO approval_history (request_id, release_id, approved_by, approval_reason)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(id, releaseId, "web-user", reason || "");

      const hasProwlarrHash = release.torrent_hash && release.torrent_hash.length === 40;

      if (hasProwlarrHash) {
        const magnetUrl = release.info_url?.includes("magnet") ? release.info_url : "";
        if (magnetUrl) {
          try {
            // Downloads must land in the immutable Download tree, never in the
            // Jellyfin library. Seeding from the library breaks as soon as
            // Sonarr/Radarr import renames or moves the file, and it skips the
            // Download -> Processed -> Library hardlink flow entirely.
            const savePath = request.type === "movie"
              ? DOWNLOADS_MOVIES
              : DOWNLOADS_TV;
            await qbittorrent.addTorrent(magnetUrl, toQBittorrentPath(savePath));
            console.log(`[Grab] Added torrent via magnet for ${request.title}: ${release.title}`);
          } catch (grabErr: any) {
            console.error(`[Grab] Failed to add torrent for ${request.title}:`, grabErr.message);
            return res.status(500).json({ error: "Failed to add torrent to qBittorrent", details: String(grabErr) });
          }
        } else {
          console.log(`[Grab] Prowlarr release has infoHash=${release.torrent_hash} but no magnet URL — torrent must be added manually`);
        }
      } else if (request.radarr_id && release.radarr_release_id) {
        try {
          console.log(`[Radarr] Refreshing release cache for ${request.title} before grab...`);
          let refreshedReleases: RadarrSearchResult[] = [];
          try {
            refreshedReleases = await radarr.searchReleases(request.radarr_id);
          } catch {
            // proceed with stale guid
          }

          let indexerId = release.radarr_indexer_id || 0;
          let guid = release.radarr_release_id;

          if (refreshedReleases.length > 0) {
            const match = refreshedReleases.find((r) => r.guid === guid);
            if (match) {
              indexerId = match.indexerId || indexerId;
            }
          }

          // Snapshot existing torrents before grab to detect the new one
          let preGrabHashes: Set<string> = new Set();
          try {
            const preTorrents = await qbittorrent.getTorrents();
            preGrabHashes = new Set(preTorrents.map((t) => t.hash));
          } catch {
            // qBittorrent might not be reachable, fall back to title search
          }

          await radarr.grabRelease(guid, indexerId);
          console.log(`[Radarr] Grabbed release for ${request.title}: ${release.title}`);

          // Find the NEW torrent in qBittorrent (poll up to 30s)
          const detectTorrent = async (attempt: number) => {
            try {
              const postTorrents = await qbittorrent.getTorrents();
              const newTorrent = postTorrents.find((t) => !preGrabHashes.has(t.hash));
              if (newTorrent) {
                db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                  .run(newTorrent.hash, newTorrent.save_path, release.id);
                console.log(`[Radarr] Detected new torrent: ${newTorrent.name} hash=${newTorrent.hash}`);
                return;
              }
            } catch {
              // retry
            }
            if (attempt < 10) {
              setTimeout(() => detectTorrent(attempt + 1), 3000);
            } else {
              console.log(`[Radarr] Could not detect new torrent for ${request.title} after 30s`);
            }
          };
          setTimeout(() => detectTorrent(0), 3000);
        } catch (grabErr: any) {
          if (grabErr?.response?.status === 409) {
            console.log(`[Radarr] Release already grabbed for ${request.title}`);
          } else if (grabErr?.response?.status === 404) {
            console.error(`[Radarr] Release expired from cache for ${request.title}, needs re-search`);
            return res.status(500).json({
              error: "Release expired from Radarr cache",
              details: "The release was found when searching but expired before grab. Please search again and approve quickly.",
            });
          } else {
            console.error(`[Radarr] Failed to grab release for ${request.title}:`, grabErr);
            return res.status(500).json({ error: "Failed to grab release from Radarr", details: String(grabErr) });
          }
        }
      } else if (request.sonarr_id && release.radarr_release_id) {
        // Sonarr grab
        try {
          console.log(`[Sonarr] Refreshing release cache for ${request.title} before grab...`);
          let refreshedReleases: RadarrSearchResult[] = [];
          try {
            refreshedReleases = await sonarr.searchReleases(request.sonarr_id, request.season || 1);
          } catch {
            // proceed with stale guid
          }

          let indexerId = release.radarr_indexer_id || 0;
          let guid = release.radarr_release_id;

          if (refreshedReleases.length > 0) {
            const match = refreshedReleases.find((r) => r.guid === guid);
            if (match) {
              indexerId = match.indexerId || indexerId;
            }
          }

          let preGrabHashes: Set<string> = new Set();
          try {
            const preTorrents = await qbittorrent.getTorrents();
            preGrabHashes = new Set(preTorrents.map((t) => t.hash));
          } catch {
            // qBittorrent might not be reachable
          }

          await sonarr.grabRelease(guid, indexerId);
          console.log(`[Sonarr] Grabbed release for ${request.title}: ${release.title}`);

          const detectTorrent = async (attempt: number) => {
            try {
              const postTorrents = await qbittorrent.getTorrents();
              const newTorrent = postTorrents.find((t) => !preGrabHashes.has(t.hash));
              if (newTorrent) {
                db.prepare("UPDATE release_candidates SET torrent_hash = ?, save_path = ? WHERE id = ?")
                  .run(newTorrent.hash, newTorrent.save_path, release.id);
                console.log(`[Sonarr] Detected new torrent: ${newTorrent.name} hash=${newTorrent.hash}`);
                return;
              }
            } catch {
              // retry
            }
            if (attempt < 10) {
              setTimeout(() => detectTorrent(attempt + 1), 3000);
            } else {
              console.log(`[Sonarr] Could not detect new torrent for ${request.title} after 30s`);
            }
          };
          setTimeout(() => detectTorrent(0), 3000);
        } catch (grabErr: any) {
          if (grabErr?.response?.status === 409) {
            console.log(`[Sonarr] Release already grabbed for ${request.title}`);
          } else if (grabErr?.response?.status === 404) {
            console.error(`[Sonarr] Release expired from cache for ${request.title}, needs re-search`);
            return res.status(500).json({
              error: "Release expired from Sonarr cache",
              details: "The release was found when searching but expired before grab. Please search again and approve quickly.",
            });
          } else {
            console.error(`[Sonarr] Failed to grab release for ${request.title}:`, grabErr);
            return res.status(500).json({ error: "Failed to grab release from Sonarr", details: String(grabErr) });
          }
        }
      }

      const updateStmt = db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      updateStmt.run("DOWNLOADING", id);

      res.json({ success: true, message: "Release approved and grabbing" });
    } catch (error) {
      console.error("Error approving release:", error);
      res.status(500).json({ error: "Failed to approve release" });
    }
  });

  // POST /api/requests/:id/import - Import a .torrent file or magnet link
  router.post("/:id/import", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { magnetUrl, torrentFileBase64, torrentFilename, bypassApproval } = req.body || {};

      const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id) as any;
      if (!request) return res.status(404).json({ error: "Request not found" });

      if (!magnetUrl && !torrentFileBase64) {
        return res.status(400).json({ error: "Provide magnetUrl or torrentFileBase64" });
      }

      const type = request.type === "series" ? "series" : "movie";
      const downloadDir = type === "series"
        ? (DOWNLOADS_TV)
        : (DOWNLOADS_MOVIES);
      const qbitSavePath = toQBittorrentPath(downloadDir);

      // Snapshot existing qBittorrent hashes before adding
      const preHashes = new Set((await qbittorrent.getTorrents()).map((t) => t.hash));

      let addedTitle = "";
      let addedHash = "";

      if (magnetUrl) {
        await qbittorrent.addTorrent(magnetUrl, qbitSavePath);
        addedTitle = request.title || "Imported";
      } else if (torrentFileBase64) {
        const buf = Buffer.from(torrentFileBase64, "base64");
        const filename = torrentFilename || "imported.torrent";
        await qbittorrent.addTorrentFile(buf, filename, qbitSavePath);
        addedTitle = filename.replace(/\.torrent$/i, "") || request.title || "Imported";
      }

      // Poll qBittorrent up to 10 times, 3s apart, to find the new torrent
      let newTorrent = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const torrents = await qbittorrent.getTorrents();
        newTorrent = torrents.find((t) => !preHashes.has(t.hash)) || null;
        if (newTorrent) break;
      }

      if (newTorrent) {
        addedHash = newTorrent.hash;
        addedTitle = newTorrent.name || addedTitle;
        newTorrent.content_path = fromQBittorrentPath(newTorrent.content_path);
        newTorrent.save_path = fromQBittorrentPath(newTorrent.save_path);
      }

      // Create release_candidate
      const radarrReleaseId = addedHash || `imported-${Date.now()}`;
      let releaseId: number;

      const existing = db.prepare(
        "SELECT id FROM release_candidates WHERE request_id = ? AND radarr_release_id = ?"
      ).get(id, radarrReleaseId) as any;

      if (existing) {
        releaseId = existing.id;
        db.prepare(`
          UPDATE release_candidates SET title = ?, torrent_hash = ?, save_path = ?, size_mb = ?
          WHERE id = ?
        `).run(addedTitle, addedHash, newTorrent?.save_path || downloadDir,
          newTorrent ? Math.round(newTorrent.size / (1024 * 1024)) : 0, releaseId);
      } else {
        const rcResult = db.prepare(`
          INSERT INTO release_candidates
          (request_id, radarr_release_id, title, indexer, size_mb, torrent_hash, save_path, radarr_quality, protocol, info_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          radarrReleaseId,
          addedTitle,
          "imported",
          newTorrent ? Math.round(newTorrent.size / (1024 * 1024)) : 0,
          addedHash,
          newTorrent?.save_path || downloadDir,
          "",
          "torrent",
          magnetUrl || "",
        );
        releaseId = Number(rcResult.lastInsertRowid);
      }

      if (bypassApproval) {
        db.prepare(`
          INSERT INTO approval_history (request_id, release_id, approved_by, approval_reason)
          VALUES (?, ?, ?, ?)
        `).run(id, releaseId, "web-user", "imported");
        db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run("DOWNLOADING", id);
      }

      console.log(`[Import] ${addedTitle} (${addedHash || "pending"}) → request #${id} (bypass=${!!bypassApproval})`);
      res.json({ success: true, releaseId, title: addedTitle, hash: addedHash });
    } catch (error: any) {
      console.error("Error importing torrent:", error);
      res.status(500).json({ error: error.message || "Failed to import torrent" });
    }
  });

  // POST /api/requests/:id/torrent/pause?releaseId=X - Pause torrent
  router.post("/:id/torrent/pause", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;
      let hash: string | undefined;
      if (releaseId) {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?").get(releaseId) as any;
        hash = release?.torrent_hash;
      } else {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?").get(id) as any;
        hash = release?.torrent_hash;
      }
      if (!hash) return res.status(400).json({ error: "No torrent" });
      await qbittorrent.pauseTorrent(hash);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Pause] Error:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to pause torrent" });
    }
  });

  // POST /api/requests/:id/torrent/resume?releaseId=X - Resume torrent
  router.post("/:id/torrent/resume", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const releaseId = req.query.releaseId as string | undefined;
      let hash: string | undefined;
      if (releaseId) {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc WHERE rc.id = ?").get(releaseId) as any;
        hash = release?.torrent_hash;
      } else {
        const release = db.prepare("SELECT rc.torrent_hash FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?").get(id) as any;
        hash = release?.torrent_hash;
      }
      if (!hash) return res.status(400).json({ error: "No torrent" });
      await qbittorrent.resumeTorrent(hash);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Resume] Error:", error.message || error);
      res.status(500).json({ error: error.message || "Failed to resume torrent" });
    }
  });

  // POST /api/requests/:id/set-status - Manually fix stuck request status
  router.post("/:id/set-status", (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body;
    const valid = ["NEW", "SEARCHING", "AWAITING_APPROVAL", "APPROVED", "DOWNLOADING", "SEEDING", "COMPLETED", "REJECTED", "DISMISSED"];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(", ")}` });
    }
    const request = db.prepare("SELECT id FROM media_requests WHERE id = ?").get(id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    db.prepare("UPDATE media_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
    res.json({ success: true, status });
  });

  // GET /api/requests/:id/debug - Dump raw DB data for a request
  router.get("/:id/debug", (req: Request, res: Response) => {
    const { id } = req.params;
    const request = db.prepare("SELECT * FROM media_requests WHERE id = ?").get(id);
    const rcs = db.prepare("SELECT rc.* FROM release_candidates rc JOIN approval_history ah ON ah.release_id = rc.id WHERE ah.request_id = ?").all(id);
    const ahs = db.prepare("SELECT * FROM approval_history WHERE request_id = ?").all(id);
    res.json({ request, release_candidates: rcs, approval_history: ahs });
  });

  return router;
}
