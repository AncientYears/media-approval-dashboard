// Tracker-recovery engine. Reads the .torrent files saved in TRACKERS_DIR,
// matches their internal files against the download/processed/library trees by
// exact byte length (renames are irrelevant to a length), and produces the
// pieces needed to re-add a torrent to qBittorrent: where to place hardlinks,
// which files go to which internal path, and the storage of the tracker + its
// announce list into TRACKERS_DIR/<infoHash>/.
//
// Purity: all fs knowledge is funnelled through the root config below (defaults
// from paths.ts, overridable for tests). No DB, no qBittorrent here — the route
// layer attaches qBittorrent state, request linkage and the apply/vote flow.

import fs from "fs";
import path from "path";
import { parseTorrentFile, type ParsedTorrent } from "./torrentMeta";
import {
  DOWNLOADS_MOVIES,
  DOWNLOADS_TV,
  PROCESSED_MOVIES,
  PROCESSED_TV,
  MEDIA_MOVIES,
  MEDIA_TV,
  TRACKERS_DIR,
} from "../config/paths";

export interface VideoEntry {
  /** Absolute path on disk. */
  path: string;
  size: number;
  dev: number;
  ino: number;
  tree: "download" | "processed" | "library";
  type: "movie" | "series";
}

export interface RecoveryRoots {
  downloadMovies?: string;
  downloadTv?: string;
  processedMovies?: string;
  processedTv?: string;
  libraryMovies?: string;
  libraryTv?: string;
  trackersDir?: string;
}

export function defaultRecoveryRoots(): RecoveryRoots {
  return {
    downloadMovies: DOWNLOADS_MOVIES,
    downloadTv: DOWNLOADS_TV,
    processedMovies: PROCESSED_MOVIES,
    processedTv: PROCESSED_TV,
    libraryMovies: MEDIA_MOVIES,
    libraryTv: MEDIA_TV,
    trackersDir: TRACKERS_DIR,
  };
}

/** Walk a tree collecting every regular file with size + inode identity.
 *  Not video-only on purpose: a torrent's integrity depends on its subtitle
 *  and sidecar files too, so a single-file match that omits them would make a
 *  perfectly-restorable torrent look incomplete. */
export function collectVideos(roots: RecoveryRoots = defaultRecoveryRoots()): VideoEntry[] {
  const out: VideoEntry[] = [];
  const rootsDef: Array<{ root?: string; tree: VideoEntry["tree"]; type: VideoEntry["type"] }> = [
    { root: roots.downloadMovies, tree: "download", type: "movie" },
    { root: roots.downloadTv, tree: "download", type: "series" },
    { root: roots.processedMovies, tree: "processed", type: "movie" },
    { root: roots.processedTv, tree: "processed", type: "series" },
    { root: roots.libraryMovies, tree: "library", type: "movie" },
    { root: roots.libraryTv, tree: "library", type: "series" },
  ];
  const seen = new Set<string>();
  for (const def of rootsDef) {
    if (!def.root || !fs.existsSync(def.root)) continue;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        try {
          if (e.isDirectory()) {
            walk(full);
          } else if (e.isFile()) {
            if (seen.has(full)) continue;
            seen.add(full);
            const st = fs.statSync(full);
            out.push({ path: full, size: st.size, dev: st.dev, ino: st.ino, tree: def.tree, type: def.type });
          }
        } catch {}
      }
    };
    walk(def.root);
  }
  return out;
}

export interface SavedTracker {
  infoHash: string;
  name: string;
  sourcePath: string;
  parsed: ParsedTorrent;
  announce: string[];
}

export interface SavedTrackerScan {
  trackers: SavedTracker[];
  errors: { file: string; error: string }[];
  /** Duplicate .torrent files collapsed onto the surviving hash (first win). */
  duplicates: { infoHash: string; sourcePath: string }[];
}

export function listSavedTrackers(roots: RecoveryRoots = defaultRecoveryRoots()): SavedTrackerScan {
  const trackersDir = roots.trackersDir || TRACKERS_DIR;
  const scan: SavedTrackerScan = { trackers: [], errors: [], duplicates: [] };
  if (!fs.existsSync(trackersDir)) return scan;

  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.torrent$/i.test(e.name)) files.push(full);
    }
  };
  walk(trackersDir);

  const seen = new Set<string>();
  for (const f of files) {
    try {
      const parsed = parseTorrentFile(fs.readFileSync(f));
      if (seen.has(parsed.infoHash)) {
        scan.duplicates.push({ infoHash: parsed.infoHash, sourcePath: f });
        continue;
      }
      seen.add(parsed.infoHash);
      scan.trackers.push({
        infoHash: parsed.infoHash,
        name: parsed.name || path.basename(f, ".torrent"),
        sourcePath: f,
        parsed,
        announce: parsed.announce,
      });
    } catch (err: any) {
      scan.errors.push({ file: f, error: err.message });
    }
  }
  return scan;
}

export interface TorrentMatch {
  /** Relative path inside the torrent (single-file: the filename; folder: <name>/<rel>). */
  torrentPath: string;
  length: number;
  /** Absolute path of the file on disk that satisfies it (null for zero-length + padding). */
  sourcePath: string | null;
  tree: VideoEntry["tree"] | "zero";
  type: VideoEntry["type"] | null;
  unique: boolean;
  /** 0-based index in the torrent's file list (the id qBittorrent's filePrio takes). */
  fileIndex: number;
}

export interface TorrentPlan {
  infoHash: string;
  name: string;
  sourcePath: string;
  announce: string[];
  layout: ParsedTorrent["layout"];
  totalSize: number;
  files: ParsedTorrent["files"];
  matches: TorrentMatch[];
  missing: TorrentMatch[];
  coveredBytes: number;
  /** True when no MEDIA file is missing. Missing sidecars (nfo/txt/jpg/…)
   *  do not block a restore: they are skipped in qBittorrent (filePrio 0) so
   *  the recheck can still reach 100% — the release seeds without them. */
  complete: boolean;
  /** Best-effort kind from the torrent name. The route lets the user override. */
  typeGuess: "movie" | "series";
}

function guessType(name: string): "movie" | "series" {
  return /\bS\d{1,2}(?:E\d|\b)|Se(zon)?\s*\d|(^|[.\-_ ])S\d{2}[.\-_ ]/i.test(name) ? "series" : "movie";
}

const MEDIA_EXT_RE = /\.(mkv|mp4|avi|mov|ts|wmv|m2ts|mk3d|m4v|mpg|mpeg|vob|flv|webm|ogm|divx)$/i;

/** Is this torrent-internal path a video file? Only a missing MEDIA file makes
 *  a plan unrestorable — sidecars (.nfo/.txt/.srt/.jpg/…) are metadata the
 *  release cannot be verified without, but seeding never needs them, so their
 *  absence is reported (and skipped in qBittorrent) rather than blocking. */
export function isMediaTorrentPath(p: string): boolean {
  return MEDIA_EXT_RE.test(p);
}

function leaf(s: string): string {
  return path.basename(s).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Match every saved tracker against the collected videos, each source used once. */
export function planMatches(
  trackers: SavedTracker[],
  videos: VideoEntry[],
): TorrentPlan[] {
  // Order: torrents whose files already live in the download tree first — those
  // are the ones sitting in place, waiting for their torrent back. Stable-sort
  // so the UI order is deterministic.
  const bySize = new Map<number, VideoEntry[]>();
  for (const v of videos) {
    const list = bySize.get(v.size) || [];
    list.push(v);
    bySize.set(v.size, list);
  }
  const used = new Set<string>(); // `${dev}:${ino}`

  const ordered = [...trackers].sort((a, b) => {
    const bidx = b.parsed.files.some((f) => hasSize(bySize, f.length, used, "download"));
    const aidx = a.parsed.files.some((f) => hasSize(bySize, f.length, used, "download"));
    if (bidx !== aidx) return bidx ? 1 : -1;
    return a.infoHash.localeCompare(b.infoHash);
  });

  return ordered.map((t) => {
    const matches: TorrentMatch[] = [];
    const missing: TorrentMatch[] = [];
    let coveredBytes = 0;

    for (let fileIdx = 0; fileIdx < t.parsed.files.length; fileIdx++) {
      const f = t.parsed.files[fileIdx];
      const torrentPath = t.parsed.layout === "folder" ? `${t.parsed.name}/${f.path}` : f.path;
      if (f.length === 0) {
        matches.push({ torrentPath, length: 0, sourcePath: null, tree: "zero", type: null, unique: true, fileIndex: fileIdx });
        continue;
      }
      const candidates = (bySize.get(f.length) || []).filter((v) => !used.has(`${v.dev}:${v.ino}`));
      if (candidates.length === 0) {
        missing.push({ torrentPath, length: f.length, sourcePath: null, tree: "download", type: null, unique: false, fileIndex: fileIdx });
        continue;
      }
      const ranked = [...candidates].sort((a, b) => {
        const treeRank = { download: 0, processed: 1, library: 2 } as const;
        const ar = treeRank[a.tree];
        const br = treeRank[b.tree];
        if (ar !== br) return ar - br;
        const al = leaf(path.basename(a.path)) === leaf(torrentPath) ? 1 : 0;
        const bl = leaf(path.basename(b.path)) === leaf(torrentPath) ? 1 : 0;
        if (al !== bl) return bl - al;
        return a.path.localeCompare(b.path);
      });
      const pick = ranked[0];
      used.add(`${pick.dev}:${pick.ino}`);
      matches.push({
        torrentPath,
        length: f.length,
        sourcePath: pick.path,
        tree: pick.tree,
        type: pick.type,
        unique: candidates.length === 1,
        fileIndex: fileIdx,
      });
      coveredBytes += f.length;
    }

    return {
      infoHash: t.infoHash,
      name: t.name,
      sourcePath: t.sourcePath,
      announce: t.announce,
      layout: t.parsed.layout,
      totalSize: t.parsed.totalSize,
      files: t.parsed.files,
      matches,
      missing,
      coveredBytes,
      complete: missing.every((m) => !isMediaTorrentPath(m.torrentPath)),
      typeGuess: guessType(t.name),
    };
  });
}

function hasSize(
  bySize: Map<number, VideoEntry[]>,
  length: number,
  used: Set<string>,
  tree: VideoEntry["tree"],
): boolean {
  return (bySize.get(length) || []).some((v) => v.tree === tree && !used.has(`${v.dev}:${v.ino}`));
}

/**
 * Resolve the absolute destination path for a torrent-internal path inside a
 * save root, mirroring qBittorrent's layout: folder torrents land under
 * <save>/<name>/..., single-file ones directly in <save>.
 */
export function contentDest(saveRoot: string, plan: TorrentPlan, torrentPath: string): string {
  return path.join(saveRoot, ...torrentPath.split("/"));
}

export interface PlaceEntry {
  torrentPath: string;
  dest: string;
  sourcePath: string | null;
  length: number;
}

/** Build the list of destinations + sources for a complete plan. */
export function planContentEntries(plan: TorrentPlan, saveRoot: string): PlaceEntry[] {
  return plan.matches.map((m) => ({
    torrentPath: m.torrentPath,
    dest: contentDest(saveRoot, plan, m.torrentPath),
    sourcePath: m.sourcePath,
    length: m.length,
  }));
}

export type PlaceStatus = "linked" | "same-inode" | "created" | "collision" | "error";

export interface PlaceFileResult {
  torrentPath: string;
  dest: string;
  status: PlaceStatus;
  detail?: string;
}

/**
 * Place the plan's files into the download root: hardlink every matched source
 * (same inode when the destination already holds one), create zero-length
 * entries for padding. Never copies, never overwrites a different inode.
 */
export function placeFilesIntoDownload(plan: TorrentPlan, saveRoot: string): PlaceFileResult[] {
  const results: PlaceFileResult[] = [];
  fs.mkdirSync(saveRoot, { recursive: true });
  for (const entry of planContentEntries(plan, saveRoot)) {
    try {
      if (entry.sourcePath === null) {
        if (entry.length === 0) {
          fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
          if (fs.existsSync(entry.dest)) {
            results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "same-inode", detail: "already present" });
          } else {
            fs.writeFileSync(entry.dest, "");
            results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "created" });
          }
        } else {
          results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "error", detail: "no source matched" });
        }
        continue;
      }
      if (!fs.existsSync(entry.sourcePath)) {
        results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "error", detail: "source missing on disk" });
        continue;
      }
      // The matched source already sits exactly where the torrent expects it
      // (a download file that never moved). Nothing to link — qBittorrent just
      // finds it there.
      if (path.resolve(entry.dest) === path.resolve(entry.sourcePath)) {
        results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "same-inode", detail: "already in place" });
        continue;
      }
      if (fs.existsSync(entry.dest)) {
        const dSt = fs.statSync(entry.dest);
        const sSt = fs.statSync(entry.sourcePath);
        if (dSt.dev === sSt.dev && dSt.ino === sSt.ino) {
          results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "same-inode" });
          continue;
        }
        results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "collision", detail: "exists; different file" });
        continue;
      }
      fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
      fs.linkSync(entry.sourcePath, entry.dest);
      results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "linked" });
    } catch (err: any) {
      results.push({ torrentPath: entry.torrentPath, dest: entry.dest, status: "error", detail: err.message });
    }
  }
  return results;
}

export interface StoredTracker {
  dir: string;
  torrentFile: string;
  trackersJson: string;
}

/** Persist the recoverable tracker under TRACKERS_DIR/<infoHash>/ (the destroy-style shape).
 *  Takes the narrow metadata shape so any caller that identified a saved tracker
 *  can persist it without building a full match plan. */
export function storeTrackers(
  plan: Pick<TorrentPlan, "infoHash" | "name" | "announce" | "totalSize">,
  sourceTorrentBytes: Buffer,
  roots: RecoveryRoots = defaultRecoveryRoots(),
): StoredTracker {
  const dir = path.join(roots.trackersDir || TRACKERS_DIR, plan.infoHash);
  fs.mkdirSync(dir, { recursive: true });
  const torrentFile = path.join(dir, `${sanitizeName(plan.name) || plan.infoHash}.torrent`);
  const trackersJson = path.join(dir, "trackers.json");
  fs.writeFileSync(torrentFile, sourceTorrentBytes);
  fs.writeFileSync(
    trackersJson,
    JSON.stringify(
      {
        title: plan.name,
        hash: plan.infoHash,
        release_group: "",
        size_mb: Math.round(plan.totalSize / (1024 * 1024)),
        trackers: plan.announce,
        exported_at: new Date().toISOString(),
        source: "recover",
      },
      null,
      2,
    ),
  );
  return { dir, torrentFile, trackersJson };
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9 ._\-\[\]()]/g, "_").slice(0, 120);
}

/** Normalise a qBittorrent state string for ambiguity checks. */
export function torrentState(st: string): string {
  return String(st || "").toLowerCase();
}

export function torrentIsChecking(st: string): boolean {
  return /^checking|^queued/.test(torrentState(st));
}

export function torrentIsVerified(torrent: { state?: string; progress?: number }): boolean {
  const st = torrentState(torrent.state || "");
  if (torrent.progress !== 1) return false;
  if (st.endsWith("dl")) return false;
  return true;
}