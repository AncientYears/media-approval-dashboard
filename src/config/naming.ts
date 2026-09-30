import fs from "fs";
import path from "path";
import type { Database } from "better-sqlite3";

/**
 * Canonical naming kernel (P1). Builds the ID-anchored, Jellyfin-friendly names
 * the roadmap specifies, driven by a token template stored in the `settings`
 * table (defaults below). Names here are cosmetic ONLY: reads are inode-based
 * and never depend on these strings. Every builder returns null when its pivot
 * pieces (title/year/id/episode) are missing, so callers fall back to today's
 * raw basename instead of guessing.
 *
 * Default shapes:
 *   series dir:  "Title (YYYY) [tvdbid-####]"
 *   movie dir:   "Title (YYYY) [imdbid-tt####]"
 *   season dir:  "S01"
 *   episode:     "Show - S01E01 - Name [PL] [Bluray-1080p][AC3 2.0][x264]-GROUP"
 *   special/movie file: "Title (YYYY) [imdbid-tt####] - [PL] [Bluray-1080p][x264]-GROUP"
 */

export interface NamingConf {
  enabled: boolean;
  series_dir: string;
  movie_dir: string;
  season_dir: string;
  episode_file: string;
  special_file: string;
  movie_file: string;
}

export const DEFAULT_NAMING: NamingConf = {
  enabled: true,
  series_dir: "{Title} ({Year}) [tvdbid-{TvdbId}]",
  movie_dir: "{Title} ({Year}) [imdbid-tt{ImdbId}]",
  season_dir: "S{Season:02}",
  episode_file: "{Title} - S{Season:02}E{Episode:02} - {EpisodeTitle} {Tags}{Group}",
  special_file: "{Title} ({Year}) [imdbid-tt{ImdbId}] - {Tags}{Group}",
  movie_file: "{Title} ({Year}) [imdbid-tt{ImdbId}] - {Tags}{Group}",
};

/** All writable naming settings keys (mirror of NamingConf). */
export const NAMING_FIELDS: (keyof NamingConf)[] = [
  "enabled",
  "series_dir",
  "movie_dir",
  "season_dir",
  "episode_file",
  "special_file",
  "movie_file",
];

/** Documented tokens shown in the Settings UI. */
export const NAMING_TOKENS = [
  "{Title}",
  "{Year}",
  "{TvdbId}",
  "{ImdbId}",
  "{Season}",
  "{Episode}",
  "{EpisodeTitle}",
  "{Tags}",
  "{Group}",
];

export function loadNamingConf(db: Database): NamingConf {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'naming.%'").all() as any[];
  const conf: NamingConf = { ...DEFAULT_NAMING };
  for (const r of rows) {
    const k = r.key.replace(/^naming\./, "");
    if (k === "enabled") conf.enabled = r.value !== "0" && r.value !== "false";
    else if (k in conf) (conf as any)[k] = String(r.value ?? "");
  }
  return conf;
}

/** Persist a subset of naming settings. `null`/`undefined`/empty resets to the default. */
export function saveNamingConf(db: Database, patch: Partial<NamingConf>): void {
  for (const k of NAMING_FIELDS) {
    if (!(k in patch)) continue;
    const v = (patch as any)[k];
    if (k === "enabled") {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('naming.enabled', ?)").run(v ? "1" : "0");
      continue;
    }
    const value = v === null || v === undefined || String(v).trim() === "" ? (DEFAULT_NAMING[k] as string) : String(v).trim();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`naming.${k}`, value);
  }
}

/** Render a template, expanding {Token} and zero-padded {Token:NN}. */
export function renderNamingTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)(?::(\d+))?\}/g, (_m, token: string, width?: string) => {
    const v = (vars[token] ?? "").trim();
    if (width) return v.padStart(Number(width), "0");
    return v;
  });
}

/** Sanitize a name segment: drop path separators / Windows-illegal chars,
 * collapse whitespace, trim trailing dots/spaces. Keeps unicode letters. */
export function sanitizeSegment(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");
}

const LANG_TAGS = new Set([
  "PL", "PL-PL", "EN", "ENG", "FR", "DE", "ES", "IT", "PT", "NL", "SE", "NO", "FI",
  "DK", "SK", "CS", "CZ", "HU", "RO", "BG", "RU", "UK", "UA", "TR", "AR", "HE", "GR",
  "JA", "KO", "ZH", "VI", "TH", "MULTI", "DUB", "DUBBED", "DUBBING",
]);

const SOURCE_RE = /(remux|blu-?ray|bd-?rip|web-?dl|web-?rip|web|hdtv|dvd-?rip)/i;
const RES_RE = /\b(\d{3,4})[pi]\b/i;
const AUDIO_RE = /(\btrue-?hd\b|\bdts-?hd(?:\s*ma)?\b|\bdts\b|\be?-?ac3\b|\bdd[P+]?\s?5\.1\b|\bac3(?:[-\s]\d\.\d)?\b|\baac(?:[-\s]\d\.\d)?\b|\bflac\b|\batmos\b|\bdolby\b|\bopus\b|\bmp3\b)/i;
const VIDEO_RE = /(\b(?:x|h)\.?26[45]\b|\bhevc\b|\bavc\b|\bav1\b|\b10bit\b)/i;

/** True when a "-(...)" tail is a codec/quality word, not a release group. */
function looksLikeCodec(word: string): boolean {
  if (/\d{3,4}p$/i.test(word)) return true;
  return /^(ac3|eac3|aac|flac|dts|truehd|atmos|dolby|hevc|x26[45]|h\.?26[45]|avc|av1|web|hd|hdrip|bdrip|dvdrip|remux|720p|1080p|2160p|480p)$/i.test(word);
}

/** Normalized quality source (matches QUALITY_WEIGHTS names minus resolution). */
function normalizeSource(s: string): string {
  const v = s.toLowerCase();
  if (v.includes("remux")) return "Remux";
  if (v.includes("blu") || v.includes("bdr")) return "Bluray";
  if (v.includes("webdl") || v.includes("web-dl")) return "WEBDL";
  if (v.includes("webrip") || v.includes("web-rip")) return "WEBRip";
  if (v.includes("web")) return "WEB";
  if (v.includes("hdtv")) return "HDTV";
  if (v.includes("dvd")) return "DVDRip";
  return s;
}

function parseAudioToken(tok: string): string | null {
  const m = tok.match(/\b(AC3|AAC)\s*[- ]\s*(\d\.\d)/i);
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  if (/true-?hd/i.test(tok)) return tok.toLowerCase().includes("atmos") ? "TrueHD Atmos" : "TrueHD";
  if (/dts-?hd/i.test(tok)) return tok.toLowerCase().includes(" ma") ? "DTS-HD MA" : "DTS-HD";
  if (/dts\b/i.test(tok)) return "DTS";
  if (/e-?ac3|dd[P+]?\s?5\.1/i.test(tok)) return "EAC3";
  if (/ac3/i.test(tok)) return "AC3";
  if (/aac/i.test(tok)) return "AAC";
  if (/flac/i.test(tok)) return "FLAC";
  if (/atmos/i.test(tok)) return "Atmos";
  if (/dolby/i.test(tok)) return "Dolby";
  if (/opus/i.test(tok)) return "Opus";
  if (/mp3/i.test(tok)) return "MP3";
  return null;
}

function parseVideoToken(tok: string): string | null {
  if (/\bx265\b/i.test(tok) || /\bh\.?265\b/i.test(tok)) return "x265";
  if (/\bx264\b/i.test(tok) || /\bh\.?264\b/i.test(tok)) return "x264";
  if (/\bhevc\b/i.test(tok)) return "HEVC";
  if (/\bavc\b/i.test(tok)) return "AVC";
  if (/\bav1\b/i.test(tok)) return "AV1";
  if (/\b10bit\b/i.test(tok)) return "10bit";
  return null;
}

export interface ReleaseTags {
  tags: string;
  group: string | null;
  language: string | null;
  source: string | null;
  resolution: string | null;
  audio: string[];
  video: string[];
}

/**
 * Extract the trailing release metadata from a filename base so it can survive
 * a canonical rename. Reads both bracketed ("[Bluray-1080p]", "[AC3 2.0]",
 * "[PL]", "[HDR10]") and loose dotted ("Dune.2021.1080p.WEB-DL.x265-GRP") forms,
 * plus a "-GROUP" tail. Unknown pieces are dropped, never guessed at — other
 * than preserving unrecognized short bracket tags verbatim.
 */
export function parseReleaseTags(baseName: string): ReleaseTags {
  const out: ReleaseTags = { tags: "", group: null, language: null, source: null, resolution: null, audio: [], video: [] };
  let base = baseName.replace(/\.(mkv|mp4|avi|mov|ts|wmv|iso|m2ts|webm)$/i, "");

  const grp = base.match(/-([A-Z0-9]{2,12})$/i);
  if (grp && !looksLikeCodec(grp[1])) {
    out.group = grp[1];
    base = base.slice(0, grp.index).replace(/[-.\s]+$/g, "");
  }

  const misc: string[] = [];
  const tryToken = (tok: string, fromBracket: boolean) => {
    if (!tok.trim()) return;
    if (LANG_TAGS.has(tok.trim().toUpperCase()) && tok.trim().length <= 12) {
      out.language = tok.trim().toUpperCase();
      return;
    }
    const srcM = tok.match(SOURCE_RE);
    const resM = tok.match(RES_RE);
    if (srcM) out.source = normalizeSource(srcM[1]);
    if (resM) out.resolution = `${resM[1]}p`;
    const audio = parseAudioToken(tok);
    if (audio) {
      if (audio === "Atmos") {
        const idx = out.audio.findIndex((a) => a === "TrueHD" || a === "DTS-HD" || a === "DTS-HD MA" || a === "TrueHD Atmos");
        if (idx >= 0) out.audio[idx] = `${out.audio[idx]} Atmos`;
        else if (!out.audio.includes("Atmos")) out.audio.push("Atmos");
      } else if (!out.audio.includes(audio)) {
        out.audio.push(audio);
      }
    }
    const video = parseVideoToken(tok);
    if (video && !out.video.includes(video)) out.video.push(video);
    // Misc preserved ONLY from real brackets (e.g. "[HDR10]", "[DV]") — never from
    // loose dotted words, which are exactly where title/words and years live.
    if (!srcM && !resM && !audio && !video && fromBracket && /^[A-Z][A-Za-z0-9.+-]{0,12}$/.test(tok.trim())) {
      misc.push(tok.trim());
    }
  };

  for (const m of base.matchAll(/[\[({]([^\])}]+)[\])}]/g)) tryToken(m[1], true);
  // Loose dotted/separated release tail. Re-join known multi-word compounds
  // ("WEB" "DL", "BD" "RIP", "BLU" "RAY") so "1080p.WEB-DL.x265" classifies.
  const looseTokens = base.replace(/[\[({][^\])}]*[\])}]/g, " ").split(/[.\s_]+/).filter((t) => t);
  for (let i = 0; i < looseTokens.length; i++) {
    const t = looseTokens[i];
    const next = looseTokens[i + 1] || "";
    if (/^web$/i.test(t) && /^(dl|rip)$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    if (/^(bd|dvd|blu)$/i.test(t) && /^rip$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    if (/^blu$/i.test(t) && /^ray$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    tryToken(t, false);
  }

  // Assemble canonical tag string: "[PL] [Bluray-1080p][AC3 2.0][x264][HDR10]"
  let tags = out.language ? `[${out.language}] ` : "";
  if (out.source && out.resolution) tags += `[${out.source}-${out.resolution}]`;
  else if (out.source) tags += `[${out.source}]`;
  else if (out.resolution) tags += `[${out.resolution}]`;
  for (const a of out.audio) tags += `[${a}]`;
  for (const v of out.video) tags += `[${v}]`;
  for (const m of misc) tags += `[${m}]`;
  out.tags = tags.trim();
  return out;
}

/** Parse the first SxxExx code from a file base (E01E02 → first episode). */
export function parseEpisodeCode(fileBase: string): { season: number; episode: number } | null {
  const m = fileBase.match(/\b[sS](\d{1,2})\s*[eE](\d{1,3})\b/);
  if (!m) return null;
  const season = parseInt(m[1], 10);
  const episode = parseInt(m[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { season, episode };
}

export interface CanonicalFilePieces {
  title: string;
  year?: number | null;
  imdbId?: string | null;
  tvdbId?: number | string | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  tags?: string;
  group?: string | null;
}

const fileVars = (p: CanonicalFilePieces, conf: NamingConf): Record<string, string> => ({
  Title: p.title,
  Year: p.year ? String(p.year) : "",
  ImdbId: p.imdbId ? p.imdbId.replace(/^tt/, "") : "",
  TvdbId: p.tvdbId !== null && p.tvdbId !== undefined ? String(p.tvdbId) : "",
  Season: p.season !== null && p.season !== undefined ? String(p.season) : "",
  Episode: p.episode !== null && p.episode !== undefined ? String(p.episode) : "",
  EpisodeTitle: (p.episodeTitle || "").trim(),
  Tags: p.tags || "",
  Group: p.group ? `-${p.group}` : "",
});

/** Movie file / S00 special: "Title (YYYY) [imdbid-tt####] - [tags]-GROUP". */
export function canonicalMovieFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || !p.imdbId) return null;
  return sanitizeSegment(renderNamingTemplate(conf.movie_file, fileVars(p, conf)));
}

/** S00 special file — same shape as a movie file. */
export function canonicalSpecialFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || !p.imdbId) return null;
  return sanitizeSegment(renderNamingTemplate(conf.special_file, fileVars(p, conf)));
}

/** Numbered episode: "Show - S01E01 - Name [tags]-GROUP". Episode title optional. */
export function canonicalEpisodeFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || typeof p.season !== "number" || typeof p.episode !== "number") return null;
  const out = renderNamingTemplate(conf.episode_file, fileVars(p, conf));
  const cleaned = out.replace(/\s+-\s*$/g, "").replace(/\s{2,}/g, " ").trim();
  return sanitizeSegment(cleaned);
}

/** Series show dir: "Title (YYYY) [tvdbid-####]". */
export function canonicalSeriesDir(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || (!p.tvdbId && !p.imdbId)) return null;
  return sanitizeSegment(renderNamingTemplate(conf.series_dir, fileVars(p, conf)));
}

/** Movie dir: "Title (YYYY) [imdbid-tt####]". */
export function canonicalMovieDir(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || !p.imdbId) return null;
  return sanitizeSegment(renderNamingTemplate(conf.movie_dir, fileVars(p, conf)));
}

/** Season dir: "S01" (respects the season_dir template). */
export function canonicalSeasonDir(conf: NamingConf, season: number): string | null {
  if (typeof season !== "number" || !Number.isFinite(season)) return null;
  return sanitizeSegment(renderNamingTemplate(conf.season_dir, { Season: String(season) }));
}

/**
 * Return a destination path that will not clobber an existing DIFFERENT file.
 * Same-inode existing file → returned unchanged (idempotent). Different-inode
 * existing file → first free "<base>-2<ext>" suffix so multiple versions of a
 * movie/special (expected, not deduped) can coexist.
 */
export function uniqueDestPath(destFilePath: string, srcIno: number | null): string {
  if (!fs.existsSync(destFilePath)) return destFilePath;
  if (srcIno && srcIno > 0) {
    try {
      if (fs.statSync(destFilePath).ino === srcIno) return destFilePath;
    } catch {}
  }
  const ext = path.extname(destFilePath);
  const stem = ext ? destFilePath.slice(0, -ext.length) : destFilePath;
  for (let i = 2; i < 100; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}