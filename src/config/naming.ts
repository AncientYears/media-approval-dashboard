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
  special_file: "{Title} ({Year}) [imdbid-tt{ImdbId}] - {SpecialCode} {Tags}{Group}",
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
  "{AirDate}",
  "{EpisodeYear}",
  "{SpecialCode}",
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

/** Render a template, expanding {Token} and zero-padded {Token:NN}. An empty
 *  value renders as nothing at all — padding it would turn a missing season into
 *  a literal "S00"/"00", which reads like real data. */
export function renderNamingTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)(?::(\d+))?\}/g, (_m, token: string, width?: string) => {
    const v = (vars[token] ?? "").trim();
    if (!v) return "";
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

function withChannel(label: string, tok: string): string {
  const ch = tok.match(/(\d\.\d)\s*$/);
  return ch ? `${label} ${ch[1]}` : label;
}

function parseAudioToken(tok: string): string | null {
  const m = tok.match(/\b(AC3|AAC)\s*[- ]\s*(\d\.\d)/i);
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  if (/true-?hd/i.test(tok)) return withChannel(tok.toLowerCase().includes("atmos") ? "TrueHD Atmos" : "TrueHD", tok);
  if (/dts-?hd/i.test(tok)) return withChannel(tok.toLowerCase().includes(" ma") ? "DTS-HD MA" : "DTS-HD", tok);
  if (/dts\b/i.test(tok)) return withChannel("DTS", tok);
  if (/e-?ac3|dd[P+]?\s?5\.1/i.test(tok)) return withChannel("EAC3", tok);
  if (/^dd\b|dd[+p]/i.test(tok)) return withChannel("EAC3", tok);
  if (/ac3/i.test(tok)) return withChannel("AC3", tok);
  if (/aac/i.test(tok)) return withChannel("AAC", tok);
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

/** Edition markers preserved as tags (theatrical/extended/international/…). */
const EDITION_MULTI_RE =
  /\b(director'?s cut|special edition|anniversary edition|limited edition|theatrical|extended|international|uncut|unrated|ultimate|remastered|anniversary)\b/gi;
const EDITION_SINGLE = new Set([
  "theatrical", "extended", "international", "uncut", "unrated", "ultimate",
  "remastered", "anniversary", "limited", "edition", "cut",
]);

function editionLabel(word: string): string {
  const key = word.toLowerCase().replace(/'/g, "");
  if (key === "directors cut") return "Director's Cut";
  return key.split(/\s+/).map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "")).join(" ");
}

/** Multi-word release phrases that must survive as ONE tag. Everything else in
 *  a bracket is split on whitespace so "[DV HDR10Plus]" classifies piece by
 *  piece, which would otherwise shred "[Dual Audio]" into "[Dual][Audio]". */
const MISC_PHRASES: Record<string, string> = {
  "dual audio": "Dual Audio",
  "multi audio": "Multi Audio",
  "dual subs": "Dual Subs",
  "dual subtitles": "Dual Subtitles",
  "multi subs": "Multi Subs",
  "multi subtitle": "Multi Subtitles",
  "multi subtitles": "Multi Subtitles",
  "multi language": "Multi Language",
  "dual language": "Dual Language",
  "audio only": "Audio Only",
  "video only": "Video Only",
  "complete season": "Complete Season",
  "complete series": "Complete Series",
  "season pack": "Season Pack",
  "limited series": "Limited Series",
};

function collectEditions(base: string): string[] {
  const out: string[] = [];
  for (const m of base.matchAll(EDITION_MULTI_RE)) {
    const label = editionLabel(m[1]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export interface ReleaseTags {
  tags: string;
  group: string | null;
  language: string | null;
  source: string | null;
  resolution: string | null;
  audio: string[];
  hdr: string[];
  video: string[];
  misc: string[];
}

/** Raw ffprobe facts for one video stream (see services/mediaProbe). */
export interface ProbeVideoInfo {
  codecName: string | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  hdr: string[];
}

/** Raw ffprobe facts for one audio stream. */
export interface ProbeAudioInfo {
  codecName: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
}

export interface ProbeInfo {
  video: ProbeVideoInfo | null;
  audio: ProbeAudioInfo[];
}

const HDR_FLAGS: Record<string, string> = {
  DV: "DV",
  DOVI: "DV",
  DOLBYVISION: "DV",
  HDR10PLUS: "HDR10+",
  "HDR10+": "HDR10+",
  HDR10: "HDR10",
  HDR: "HDR",
  HLG: "HLG",
  WCG: "WCG",
  BT2020: "WCG",
};

function hdrFlagOf(tok: string): string | null {
  const n = tok.toUpperCase().replace(/\./g, "");
  return HDR_FLAGS[n] || null;
}

/** Render the canonical tag run: "[PL] [Remux-2160p][TrueHD Atmos 7.1][DV HDR10Plus][HEVC][10bit][Custom]". */
const HDR_RANK = ["DV", "HDR10+", "HDR10", "HDR", "HLG", "WCG"];
function renderTags(f: {
  language: string | null;
  source: string | null;
  resolution: string | null;
  audio: string[];
  hdr: string[];
  video: string[];
  misc: string[];
}): string {
  let tags = f.language ? `[${f.language}] ` : "";
  if (f.source && f.resolution) tags += `[${f.source}-${f.resolution}]`;
  else if (f.source) tags += `[${f.source}]`;
  else if (f.resolution) tags += `[${f.resolution}]`;
  for (const a of f.audio) tags += `[${a}]`;
  // HDR10+ implies the HDR10 base layer — never print both (redundant).
  const hdr = [...f.hdr]
    .filter((x) => !(x === "HDR10" && f.hdr.includes("HDR10+")))
    .sort((a, b) => {
      const ra = HDR_RANK.indexOf(a);
      const rb = HDR_RANK.indexOf(b);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
    });
  if (hdr.length) tags += `[${hdr.join(" ")}]`;
  for (const v of f.video) tags += `[${v}]`;
  for (const m of f.misc) tags += `[${m}]`;
  return tags.trim();
}

function probeVideoLabel(codec: string): string | null {
  const n = codec.toLowerCase();
  if (n === "hevc" || n === "h265") return "HEVC";
  if (n === "h264") return "x264";
  if (n === "avc") return "AVC";
  if (n === "av1") return "AV1";
  if (n === "vp9") return "VP9";
  if (n === "mpeg4") return "Xvid";
  return null;
}

function probeAudioLabel(codec: string): string | null {
  const n = codec.toLowerCase();
  if (n === "truehd" || n === "mlp") return "TrueHD";
  if (n === "eac3") return "EAC3";
  if (n === "ac3") return "AC3";
  if (n === "dts") return "DTS";
  if (n === "aac") return "AAC";
  if (n === "flac") return "FLAC";
  if (n === "opus") return "Opus";
  if (n === "mp3") return "MP3";
  if (n.startsWith("pcm_")) return "PCM";
  return null;
}

function probeChannelLabel(channels: number | null, layout: string | null): string | null {
  const fromLayout = layout ? layout.match(/\d\.\d/) : null;
  if (fromLayout) return fromLayout[0];
  if (channels === 8) return "7.1";
  if (channels === 7) return "6.1";
  if (channels === 6) return "5.1";
  if (channels === 4) return "3.1";
  if (channels === 3) return "2.1";
  if (channels === 2) return "2.0";
  if (channels === 1) return "1.0";
  return null;
}

function probeResolution(height: number | null | undefined): string | null {
  if (!height) return null;
  if (height >= 2000) return "2160p"; // 2160 / 3840 / 4320
  if (height >= 1700) return "1080p"; // 1920 (2K DCI)
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 550) return "480p";
  return null;
}

function audioFamilyOf(l: string): string {
  const n = l.toLowerCase();
  if (/truehd|mlp/.test(n)) return "truehd";
  if (/eac3/.test(n)) return "eac3";
  if (/ac3/.test(n)) return "ac3";
  if (/dts/.test(n)) return "dts";
  if (/aac/.test(n)) return "aac";
  if (/flac/.test(n)) return "flac";
  if (/opus/.test(n)) return "opus";
  if (/pcm/.test(n)) return "pcm";
  return n;
}

function videoFamilyOf(l: string): string {
  const n = l.toLowerCase();
  if (/hevc|x265|h265/.test(n)) return "hevc";
  if (/h264|x264|avc/.test(n)) return "avc";
  if (/av1/.test(n)) return "av1";
  if (/vp9/.test(n)) return "vp9";
  return n;
}

/**
 * P1b: enrich a title-parsed tag set with authoritative facts probed from the
 * file itself (ffprobe). Probe wins for resolution (real pixel height), video
 * codec + bit depth, and primary audio codec + channels; the title still
 * supplies source, language, group, and the "Atmos" flag (ffprobe cannot
 * reliably flag Atmos). No probe → title inference only.
 */
export function assembleCanonicalTags(t: ReleaseTags, probe: ProbeInfo | null): ReleaseTags {
  if (!probe) return { ...t, tags: renderTags(t) };
  const v = probe.video;
  const primary = probe.audio[0] || null;

  const audio = t.audio.slice();
  const probedAudioLabel = primary?.codecName ? probeAudioLabel(primary.codecName) : null;
  if (probedAudioLabel) {
    const ch = probeChannelLabel(primary!.channels, primary!.channelLayout);
    const fam = audioFamilyOf(probedAudioLabel);
    // The title often carries a subtype ffprobe cannot see (DTS-HD MA,
    // DTS-HD, TrueHD + Atmos). Probe stays authoritative for the family and
    // channels; the most specific same-family title label wins so detail
    // survives instead of flattening "DTS-HD MA" to "DTS".
    const sameFam = audio.filter((a) => audioFamilyOf(a) === fam);
    const atmos = fam === "truehd" && audio.some((a) => /atmos/i.test(a)) ? " Atmos" : "";
    let base = probedAudioLabel;
    if (sameFam.length) {
      if (fam === "dts") {
        if (sameFam.some((a) => /dts-hd ma/i.test(a))) base = "DTS-HD MA";
        else if (sameFam.some((a) => /dts-hd/i.test(a))) base = "DTS-HD";
        else base = "DTS";
      } else if (fam === "truehd") {
        base = "TrueHD";
      } else {
        base = sameFam[0].replace(/\s+\d\.\d$/, "");
      }
    }
    const entry = `${base}${atmos}${ch ? ` ${ch}` : ""}`;
    const kept = audio.filter((a) => audioFamilyOf(a) !== fam);
    audio.length = 0;
    audio.push(entry, ...kept);
  }

  const video = t.video.slice();
  const probedVideoLabel = v?.codecName ? probeVideoLabel(v.codecName) : null;
  if (probedVideoLabel) {
    const fam = videoFamilyOf(probedVideoLabel);
    const kept = video.filter((x) => videoFamilyOf(x) !== fam);
    video.length = 0;
    video.push(probedVideoLabel, ...kept);
  }
  if (v?.bitDepth && Number(v.bitDepth) >= 10 && !video.some((x) => /10bit/i.test(x))) video.push("10bit");

  const hdr = Array.from(new Set([...t.hdr, ...(v?.hdr || [])]));
  const resolution = t.resolution ?? probeResolution(v?.height);

  // A Polish dub carries no language in its file NAME — the only evidence is the
  // audio stream tag ffprobe already returns. Fill the language in from the
  // primary audio track, but never override a language the title stated, and only
  // for a track we recognise (so an "und"/empty tag cannot invent a tag).
  const language = t.language ?? probeLanguageLabel(probe);

  return {
    ...t,
    language,
    resolution,
    audio,
    hdr,
    video,
    tags: renderTags({ ...t, language, resolution, audio, hdr, video }),
  };
}

/** Language tag from the audio streams' container tags, or null.
 *  A Polish dub carries nothing in its file NAME — the stream tag is the only
 *  evidence — but tagging every plain English original "[EN]" is just noise. So:
 *  fire when the file has more than one audio track, or when a single track is
 *  not English. Tracks in DIFFERENT languages are ambiguous, so stay silent. */
function probeLanguageLabel(probe: ProbeInfo | null): string | null {
  const streams = probe?.audio || [];
  const codes = streams.map((a) => String(a.language || "").trim().toLowerCase()).filter((c) => c && c !== "und" && c !== "unknown");
  if (!codes.length) return null;
  if (new Set(codes).size > 1) return null;
  if (streams.length < 2 && isEnglishCode(codes[0])) return null;
  const raw = codes[0];
  if (raw.length === 3) {
    return ISO3_TO_2[raw.toUpperCase()] || (/^[a-z]{3}$/.test(raw) ? raw.toUpperCase() : null);
  }
  return /^[a-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

const isEnglishCode = (code: string): boolean => code === "en" || code === "eng";

const ISO3_TO_2: Record<string, string> = {
  POL: "PL",
  ENG: "EN",
  GER: "DE",
  FRE: "FRA",
  SPA: "ESP",
  ITA: "ITA",
  NLD: "NLD",
  POR: "POR",
  RUS: "RUS",
  JPN: "JPN",
  KOR: "KOR",
  CHI: "CHI",
  ZHO: "CHI",
  SWE: "SWE",
  NOR: "NOR",
  DAN: "DAN",
  FIN: "FIN",
  CZE: "CZE",
  CES: "CZE",
  HUN: "HUN",
  ROU: "ROU",
  GRE: "GRE",
  UKR: "UKR",
  TUR: "TUR",
  ARA: "ARA",
  HEB: "HEB",
  THA: "THA",
  VIE: "VIE",
  IND: "IND",
};

/**
 * Extract the trailing release metadata from a filename base so it can survive
 * a canonical rename. Reads both bracketed ("[Bluray-1080p]", "[AC3 2.0]",
 * "[PL]", "[HDR10]") and loose dotted ("Dune.2021.1080p.WEB-DL.x265-GRP") forms,
 * plus a "-GROUP" tail. Unknown pieces are dropped, never guessed at — other
 * than preserving unrecognized short bracket tags verbatim.
 */
export function parseReleaseTags(baseName: string): ReleaseTags {
  const out: ReleaseTags = { tags: "", group: null, language: null, source: null, resolution: null, audio: [], hdr: [], video: [], misc: [] };
  let base = baseName.replace(/\.(mkv|mp4|avi|mov|ts|wmv|iso|m2ts|webm)$/i, "");

  // Editions ("International", "Extended", "Director's Cut", …) are preserved
  // as tags — and a bare "-International"-style tail that is one of them stops
  // being treated as a release group.
  const editions = collectEditions(base);
  const grp = base.match(/-([A-Z0-9]{2,12})$/i);
  if (grp && !looksLikeCodec(grp[1]) && !EDITION_SINGLE.has(grp[1].toLowerCase())) {
    out.group = grp[1];
    base = base.slice(0, grp.index).replace(/[-.\s]+$/g, "");
  }

  const misc: string[] = [];
  const tryToken = (tok: string, fromBracket: boolean) => {
    const at = tok.trim();
    if (!at) return;
    if (EDITION_SINGLE.has(at.toLowerCase())) return;
    if (LANG_TAGS.has(at.toUpperCase()) && at.length <= 12) {
      out.language = at.toUpperCase();
      return;
    }
    // A bare channel number ("7.1", "2.0") right after an audio token appends
    // to that track ("TrueHD Atmos" + "7.1" → "TrueHD Atmos 7.1").
    if (/^\d\.\d$/.test(at) && out.audio.length) {
      const last = out.audio[out.audio.length - 1];
      if (!last.includes(at)) out.audio[out.audio.length - 1] = `${last} ${at}`;
      return;
    }
    const srcM = at.match(SOURCE_RE);
    const resM = at.match(RES_RE);
    if (srcM) out.source = normalizeSource(srcM[1]);
    if (resM) out.resolution = `${resM[1]}p`;
    const audio = parseAudioToken(at);
    if (audio) {
      if (audio === "Atmos") {
        const idx = out.audio.findIndex((a) => a === "TrueHD" || a === "DTS-HD" || a === "DTS-HD MA" || a === "TrueHD Atmos");
        if (idx >= 0) out.audio[idx] = `${out.audio[idx]} Atmos`;
        else if (!out.audio.includes("Atmos")) out.audio.push("Atmos");
      } else if (!out.audio.includes(audio)) {
        out.audio.push(audio);
      }
    }
    const video = parseVideoToken(at);
    if (video && !out.video.includes(video)) out.video.push(video);
    // "MA" splits out of "DTS-HD MA 2.0" into its own token — fold it back
    // onto a dts family entry so the label reads "DTS-HD MA 2.0", not "DTS-HD
    // 2.0" + a stray "[MA]".
    if (/^ma$/i.test(at)) {
      const di = out.audio.findIndex((a) => /dts-hd/i.test(a));
      if (di >= 0 && !/ ma/i.test(out.audio[di])) {
        out.audio[di] = `${out.audio[di]} MA`;
        return;
      }
    }
    if (!srcM && !resM && !audio && !video) {
      // HDR flags (DV, HDR10Plus, HDR10, HLG, ...) are recognized from loose
      // dotted words AND brackets. Unknown short bracket tags are preserved
      // verbatim (except a trailing "[Unknown]"/"[Group]"/"[NoGrp]" bracket,
      // which becomes the release group). Everything else is dropped — the
      // kernel never guesses at words it doesn't know.
      const flag = hdrFlagOf(at);
      if (flag) {
        if (!out.hdr.includes(flag)) out.hdr.push(flag);
        return;
      }
      if (fromBracket && /^[A-Z][A-Za-z0-9.+-]{0,12}$/.test(at)) {
        if (/^(unknown|nogrp|group)$/i.test(at)) {
          if (!out.group) out.group = at;
        } else {
          misc.push(at);
        }
      }
    }
  };

  for (const m of base.matchAll(/[\[({]([^\])}]+)[\])}]/g)) {
    // Split multi-word bracket tags ("[DV HDR10Plus]", "[TrueHD Atmos 7.1]",
    // "[AC3 2.0]") into single tokens so each piece classifies/merges, then
    // re-joins into the canonical shape ([TrueHD Atmos 7.1], [DV HDR10Plus]).
    // Known phrases ("[Dual Audio]") are kept whole first, or the whitespace
    // split below would emit them as a row of meaningless single-word tags.
    const whole = m[1].trim();
    const phrase = MISC_PHRASES[whole.toLowerCase()];
    if (phrase) {
      misc.push(phrase);
      continue;
    }
    for (const piece of m[1].split(/\s+/)) tryToken(piece, true);
  }
  // Loose dotted/separated release tail. Re-join known multi-word compounds
  // ("WEB" "DL", "BD" "RIP", "BLU" "RAY") so "1080p.WEB-DL.x265" classifies.
  // A protected placeholder keeps channel numbers ("DD+5.1", "7.1") intact so
  // the split never tears the "5.1" apart from its codec.
  const keepNums = base.replace(/(\d)\.(\d)/g, "$1\x00$2");
  const looseTokens = keepNums.replace(/[\[({][^\])}]*[\])}]/g, " ").split(/[.\s_]+/).filter((t) => t).map((t) => t.replace(/\x00/g, "."));
  for (let i = 0; i < looseTokens.length; i++) {
    const t = looseTokens[i];
    const next = looseTokens[i + 1] || "";
    if (/^web$/i.test(t) && /^(dl|rip)$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    if (/^(bd|dvd|blu)$/i.test(t) && /^rip$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    if (/^blu$/i.test(t) && /^ray$/i.test(next)) { tryToken(`${t}-${next}`, false); i++; continue; }
    // Same phrase rule for the unbracketed tail: "…x264 Dual Audio" must stay
    // one tag rather than losing both halves to the unknown-token drop.
    if (/^(dual|multi)$/i.test(t) && /^(audio|subs?|subtitles|language)$/i.test(next)) {
      const phrase = MISC_PHRASES[`${t.toLowerCase()} ${next.toLowerCase()}`];
      if (phrase) {
        if (!misc.includes(phrase)) misc.push(phrase);
        i++;
        continue;
      }
    }
    tryToken(t, false);
  }

  out.misc = [...editions, ...misc];
  out.tags = renderTags(out);
  return out;
}

/**
 * Parse the first SxxExx code from a file base (E01E02 → first episode).
 * Also accepts the spelled-out "Season 1 Episode 12" form (Kids' shows, Jellyfin
 * hand-placed files), plus plain "- E12" / "_E12_" episode numbers when the
 * season is known. Returns a zero-based `forcedSeason` when a Season word was
 * present, so callers can reject a file whose season contradicts the folder.
 */
export function parseEpisodeCode(
  fileBase: string,
  opts?: { knownSeason?: number | null },
): { season: number; episode: number; forcedSeason?: boolean; episodeEnd?: number } | null {
  // A multi-episode file ("S01E01-02", "S01E01-E02") must never be read as a
  // single episode: naming it "S01E01" silently mislabels the E02 content it
  // also holds. `episodeEnd` marks it so callers can skip it instead.
  const multi = fileBase.match(/\b[sS](\d{1,2})\s*[eE](\d{1,3})\s*[-‐‑‒–—―]\s*[eE]?(\d{1,3})\b/);
  if (multi) {
    const season = parseInt(multi[1], 10);
    const episode = parseInt(multi[2], 10);
    const episodeEnd = parseInt(multi[3], 10);
    if (Number.isFinite(season) && Number.isFinite(episode) && Number.isFinite(episodeEnd) && episodeEnd > episode) {
      return { season, episode, episodeEnd };
    }
  }
  const m = fileBase.match(/\b[sS](\d{1,2})\s*[eE](\d{1,3})\b/);
  if (m) {
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
    return { season, episode };
  }
  const spelled = fileBase.match(/\b(?:Season|Seasons)\s*(\d{1,2})\s*[-_. ]\s*(?:Episode|Ep\.?)\s*(\d{1,3})\b/i);
  if (spelled) {
    const season = parseInt(spelled[1], 10);
    const episode = parseInt(spelled[2], 10);
    if (Number.isFinite(season) && Number.isFinite(episode)) return { season, episode, forcedSeason: true };
  }
  // Episode-only number ("Show - E12.mkv", "Show 012.mkv") — only when the
  // caller knows the season, so we never invent a season from a stray digit.
  if (typeof opts?.knownSeason === "number") {
    const eOnly = fileBase.match(/(?:^|[\s._-])[eE](\d{1,3})(?=[\s._-]|$)/);
    if (eOnly) {
      const episode = parseInt(eOnly[1], 10);
      if (Number.isFinite(episode) && episode > 0) return { season: opts.knownSeason, episode };
    }
    const padded = fileBase.match(/(?:^|[\s._-])(\d{2,3})(?=[\s._-]|$)/);
    if (padded) {
      const episode = parseInt(padded[1], 10);
      if (Number.isFinite(episode) && episode > 0) return { season: opts.knownSeason, episode };
    }
  }
  return null;
}

export interface CanonicalFilePieces {
  title: string;
  year?: number | null;
  imdbId?: string | null;
  tvdbId?: number | string | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  airDate?: string | null;
  episodeYear?: string | null;
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
  AirDate: (p.airDate || "").trim(),
  EpisodeYear: (p.episodeYear || "").trim(),
  // S00 specials get their whole "S00E03" marker from one token so it can never
  // half-render (a padded "00" with no episode) when the number is unknown.
  SpecialCode: p.season === 0 && p.episode ? `S${String(0).padStart(2, "0")}E${String(p.episode).padStart(2, "0")}` : "",
  Tags: p.tags || "",
  Group: p.group ? `-${p.group}` : "",
});

/** Movie file / S00 special: "Title (YYYY) [imdbid-tt####] - [tags]-GROUP". */
export function canonicalMovieFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || !p.imdbId) return null;
  return sanitizeSegment(renderNamingTemplate(conf.movie_file, fileVars(p, conf)));
}

/** Drop empty bracket pairs, an id bracket with no id, and the dangling
 *  separators an unused token leaves behind, so a template with an optional
 *  field degrades to a clean name. */
function tidyTemplate(out: string): string {
  return out
    .replace(/\[\s*imdbid-\s*(?:tt)?\s*\]/gi, "")
    .replace(/[([]\s*[)\]]/g, "")
    .replace(/\s+-\s+(?=\[)/g, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** S00 special file. Unlike a movie it may have no year/imdbId — the special is
 *  often not listed under the show on TMDB — in which case those tokens render
 *  empty and the on-disk title is kept; the SxxExx marker still keeps it unique. */
export function canonicalSpecialFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title) return null;
  return sanitizeSegment(tidyTemplate(renderNamingTemplate(conf.special_file, fileVars(p, conf))));
}

/** Numbered episode: "Show - S01E01 - Name [tags]-GROUP". Episode title optional. */
export function canonicalEpisodeFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || typeof p.season !== "number" || typeof p.episode !== "number") return null;
  const out = renderNamingTemplate(conf.episode_file, fileVars(p, conf));
  // Drop empty bracket pairs first: an optional token ({AirDate} on an unaired
  // episode) must not leave a dangling "()" or "[]" behind.
  return sanitizeSegment(tidyTemplate(out));
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