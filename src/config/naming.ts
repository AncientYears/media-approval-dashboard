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
  /** Comma-separated platform/vendor watermarks ("Bajeczki24"). Recognized
   *  case-insensitively anywhere in a release name and re-attached at the very
   *  END of the canonical name, because that is where these rips put it and
   *  where it survives. Recognition only — the name's own spelling is kept, so
   *  the mixed-case rule that protects release groups protects vendors too. */
  vendors: string;
}

/** Vendors recognized when the setting is absent. Polish streaming rips append
 *  their brand as a bare trailing word with no hyphen and no bracket, which is
 *  why it is dropped today: the group rule only reads a "-WORD" tail. */
export const DEFAULT_VENDORS = ["Bajeczki24", "FGT"];

/** The configured vendor list, split and trimmed. This is the single choke point
 *  where the brands become one regex, so it is also where a malformed or
 *  runaway setting is defused: empty names dropped (a trailing comma would
 *  otherwise match every position), duplicates collapsed, and count/length
 *  capped so the pattern stays a sane size. */
export function vendorList(conf: Pick<NamingConf, "vendors">): string[] {
  const raw = conf.vendors !== undefined && conf.vendors !== null ? String(conf.vendors) : DEFAULT_VENDORS.join(",");
  // Deduped case-insensitively but stored with the spelling the user typed:
  // the list is echoed back into Settings, and lowercasing it there would
  // rewrite "Bajeczki24" as "bajeczki24" on every save.
  const seen = new Map<string, string>();
  for (const part of raw.split(/[,\n]/)) {
    const v = part.trim().slice(0, 48);
    if (v) { const key = v.toLowerCase(); if (!seen.has(key)) seen.set(key, v); }
    if (seen.size >= 32) break;
  }
  return [...seen.values()];
}

export const DEFAULT_NAMING: NamingConf = {
  enabled: true,
  series_dir: "{Title} ({Year}) [tvdbid-{TvdbId}]",
  movie_dir: "{Title} ({Year}) [imdbid-tt{ImdbId}]",
  season_dir: "S{Season:02}",
  episode_file: "{Title} - S{Season:02}E{Episode:02} - {EpisodeTitle} {Tags}{Group}{Vendor}",
  special_file: "{Title} ({Year}) [imdbid-tt{ImdbId}] - {SpecialCode} {Tags}{Group}{Vendor}",
  movie_file: "{Title} ({Year}) [imdbid-tt{ImdbId}] - {Tags}{Group}{Vendor}",
  vendors: DEFAULT_VENDORS.join(","),
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
  "vendors",
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
  "{EpisodeEnd}",
  "{EpisodeRange}",
  "{AirDate}",
  "{EpisodeYear}",
  "{SpecialCode}",
  "{Tags}",
  "{Group}",
  "{Vendor}",
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
    // Unlike a template, an emptied vendor list is a deliberate choice — "attach
    // no vendors" — so it must persist as empty rather than snap back to the
    // default brand and reappear on the next rename.
    if (k === "vendors") {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('naming.vendors', ?)").run(
        v === null || v === undefined ? "" : vendorList({ vendors: String(v) }).join(","),
      );
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

/** Sanitize a name segment: drop path separators and other unsafe chars,
 * collapse whitespace, trim trailing dots/spaces. Keeps unicode letters and
 * colons (the target filesystems are Linux, where ":" is legal). */
export function sanitizeSegment(name: string): string {
  return name
    .replace(/[<>"/\\|?*\x00-\x1f]/g, "")
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
const VIDEO_RE = /(\b(?:x|h)\.?26[45]\b|\bhevc\b|\bavc\b|\bav1\b|\bvp9\b|\bxvid\b|\bdivx\b|\bmpeg-?4\b|\b10bit\b)/i;

/**
 * Streaming service a WEB-DL came from. Name-only and a real quality signal —
 * it is where the encode originated, so a WEB-DL from one service is routinely a
 * different encode of the same season — but it is not a source or a codec, so it
 * rides INSIDE the source bracket ("[WEBDL-2160p NF]") the way encode-quality
 * modifiers ride the resolution, rather than in a bracket of its own.
 *
 * Deliberately only the unambiguous tags. "iP" is the one mixed-case service
 * tag kept despite being two ordinary letters: groups write it in exactly that
 * case for ITV Player (and it is how the UK TV releases name it), while matching
 * is case-SENSITIVE and full-token, so a title's "ip" cannot reach it. "MAX" is
 * still excluded — all-caps "MAX" is a real word and a real given name, and a
 * false provider inside the source bracket is worse than a missing one.
 */
const PROVIDERS = new Map<string, string>([
  ["NF", "NF"],
  ["AMZN", "AMZN"],
  ["DSNP", "DSNP"],
  ["ATVP", "ATVP"],
  ["HMAX", "HMAX"],
  ["PCOK", "PCOK"],
  ["STARZ", "STARZ"],
  ["HULU", "HULU"],
  ["iP", "iP"],
]);

/** True when a "-(...)" tail is a codec/quality word, not a release group. */
function looksLikeCodec(word: string): boolean {
  if (/\d{3,4}p$/i.test(word)) return true;
  return /^(ac3|eac3|aac|flac|dts|truehd|atmos|dolby|hevc|x26[45]|h\.?26[45]|avc|av1|vp9|xvid|divx|mpeg-?4|web|hd|hdrip|bdrip|dvdrip|remux|720p|1080p|2160p|480p)$/i.test(word);
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

/** Entries in `audio` that name a real codec family, i.e. can carry a channel
 *  number or an Atmos flag. "Atmos" and "Dolby" on their own are mixing formats. */
function lastAudioCodecIndex(audio: string[]): number {
  for (let i = audio.length - 1; i >= 0; i--) if (!/^(atmos|dolby)$/i.test(audio[i].trim())) return i;
  return -1;
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
  // PCM is an uncompressed codec that ffprobe names directly ("pcm_s16le"), so
  // the probe has always supplied it. A name saying "[PCM 2.0]" did not: it fell
  // through to the keep-unknown-bracket-verbatim rule and became a MISC tag while
  // the probe added its own audio entry, printing "[PCM 2.0][PCM]" — one fact,
  // two tags, and a rename that never converges because the misc copy survives
  // every re-parse. Same shape as the Xvid fix below, so it is fixed the same way:
  // recognised HERE, not just mapped by the probe. The channel rides separately
  // ("[PCM 2.0]" splits into "PCM" then "2.0", which appends), and withChannel
  // catches the undivided "PCM2.0" form.
  if (/\bpcm\b/i.test(tok)) return withChannel("PCM", tok);
  return null;
}

function parseVideoToken(tok: string): string | null {
  if (/\bx265\b/i.test(tok) || /\bh\.?265\b/i.test(tok)) return "x265";
  if (/\bx264\b/i.test(tok) || /\bh\.?264\b/i.test(tok)) return "x264";
  if (/\bhevc\b/i.test(tok)) return "HEVC";
  if (/\bavc\b/i.test(tok)) return "AVC";
  if (/\bav1\b/i.test(tok)) return "AV1";
  if (/\bvp9\b/i.test(tok)) return "VP9";
  // MPEG-4 Part 2 and its two popular encoder names. These must be recognized
  // here, not just mapped by the probe: an unrecognized "[Xvid]" fell through
  // to the "keep unknown short bracket verbatim" rule as a MISC tag while the
  // probe added its own video tag, and the name printed "[Xvid][Xvid]".
  if (/\bxvid\b/i.test(tok)) return "Xvid";
  if (/\bdivx\b/i.test(tok)) return "DivX";
  if (/\bmpeg-?4\b/i.test(tok)) return "MPEG-4";
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

/** "Not stated" placeholders. They carry no information, so they may never
 *  become a tag OR a group. This matters beyond tidiness: an older version read a
 *  bracketed `[Unknown]` as the release group and wrote it to disk as `-Unknown`,
 *  and once a name carries that tail it re-parses as a group on every later pass —
 *  and is then handed to the same-inode twin by `inheritReleaseFacts` — so the
 *  rename could never converge and every preview kept proposing the same tail. */
const PLACEHOLDER_WORDS = new Set(["unknown", "group", "nogrp", "nogroup", "none", "na"]);
const isPlaceholderWord = (w: string) => PLACEHOLDER_WORDS.has(w.toLowerCase());

function editionLabel(word: string): string {
  const key = word.toLowerCase().replace(/'/g, "");
  if (key === "directors cut") return "Director's Cut";
  return key.split(/\s+/).map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "")).join(" ");
}

/** Multi-word release phrases that must survive as ONE tag. Everything else in
 *  a bracket is split on whitespace so "[DV HDR10Plus]" classifies piece by
 *  piece, which would otherwise shred "[Dual Audio]" into "[Dual][Audio]". */
const DUB_MARKERS = new Set(["DUB", "DUBBED", "DUBBING"]);

/** Words that mark a DUBBED audio track, not merely a language. A Polish
 *  release ships both a dubbed and an original track, so the audio source is a
 *  real quality tier: dropping the marker made `[PL] [AC3]` look like the same
 *  thing whether the audio was dubbed or not. */
const DUB_WORDS = new Set([...DUB_MARKERS, "LEKTOR", "LEKTORSKI", "LEKTORSKIE", "NAUKA"]);
/**
 * A LEKTOR is a MONOTONE VOICEOVER laid over the picture, not a dub: the
 * characters are not actually voiced, a single narrator reads the dialogue. That
 * is a genuinely different audio tier from a full dub, so it must not collapse
 * into `[PL DUB]` — two releases of one film differing only in this would render
 * identical names and become indistinguishable in the library. The Polish
 * adjectives ("lektorski"/"lektorskie") are the same claim. NAUKA stays a plain
 * DUB: it is a studio name with no established voiceover meaning.
 */
const LEKTOR_WORDS = new Set(["LEKTOR", "LEKTORSKI", "LEKTORSKIE"]);

/** Word-form resolutions. A title often states the class ("4K", "UHD", "2K")
 *  instead of a pixel count, and the class IS the tier we render — so "UHD
 *  BluRay" with no "2160p" still names a 2160p file. Bare "HD" is deliberately
 *  absent: it means 720p to one scene and 1080p to another, and the kernel
 *  never guesses. */
const RES_WORDS: Record<string, string> = {
  "8K": "4320p",
  "4K": "2160p",
  "UHD": "2160p",
  "ULTRAHD": "2160p",
  "2K": "1440p",
  "QHD": "1440p",
  "FHD": "1080p",
  "FULLHD": "1080p",
};

/** Words that mean a language without naming it. Polish scene releases say
 *  "Lektor" or "Polski", never "PL".
 *
 *  The ISO-639-2/3-letter codes live here too, mapped to the SAME two-letter
 *  form LANG_TAGS uses. That keeps the title parser and the ffprobe stream tags
 *  speaking one alphabet: a name can state "[FRA]" and be normalised to [FR],
 *  and a probe reading a "fre" track yields FR. Previously the probe emitted
 *  mixed-width labels (FRE→FRA, JPN→JPN) that the title parser could not read
 *  back, so a canonical name was not idempotent for those languages. */
const LANG_ALIASES: Record<string, string> = {
  LEKTOR: "PL",
  LEKTORSKI: "PL",
  LEKTORSKIE: "PL",
  NAUKA: "PL",
  POLSKI: "PL",
  POLSKIE: "PL",
  POLISH: "PL",
  POL: "PL",
  ENG: "EN",
  FRE: "FR",
  FRA: "FR",
  FRD: "FR",
  GER: "DE",
  DEU: "DE",
  SPA: "ES",
  ITA: "IT",
  NLD: "NL",
  DUT: "NL",
  POR: "PT",
  RUS: "RU",
  JPN: "JA",
  KOR: "KO",
  CHI: "ZH",
  ZHO: "ZH",
  SWE: "SE",
  NOR: "NO",
  DAN: "DK",
  FIN: "FI",
  CZE: "CZ",
  CES: "CZ",
  HUN: "HU",
  ROM: "RO",
  RUM: "RO",
  GRE: "GR",
  GRC: "GR",
  UKR: "UK",
  TUR: "TR",
  ARA: "AR",
  HEB: "HE",
  THA: "TH",
  VIE: "VI",
};

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
  // A release that says "SDR UPSCALING" is making ONE claim: it was upscaled,
  // and the upscale stayed SDR. "[UPSCALING]" alone says nothing about what was
  // upscaled or to what, so splitting the pair printed two tags where the name
  // had one — and the SDR half is what makes the upscale honest to advertise.
  "sdr upscaling": "SDR UPSCALING",
};

/** A release can go straight from the episode code into its tags, naming no
 *  episode at all ("S14E01.1080p.iP.WEB-DL.AAC2.0.HFR.H.264-RAWR"). Anchored at
 *  the START of what follows the code, because a real episode title never BEGINS
 *  with a resolution, source, provider or codec token — unlike the resolution
 *  search below, which is a substring match and so may fire mid-title. */
const TAG_RUN_HEAD = /^(?:web-?dl|web-?rip|bluray|blu-?ray|remux|hdtv|brrip|bdrip|dvdrip|amzn|dsnp|atvp|hmax|pcook|starz|hulu|\dK\b|x26[45]|h\.?26[45]|hevc|avc|aac\d|ac3|e-?ac3|ddp?\d?|truehd|dts-?hd|atmos)/i;

/** Where the episode title sits inside a name: the cleaned title text plus its
 *  CHARACTER RANGE over `base`, or null when the release names none.
 *
 *  One implementation serves both callers, because they want different halves of
 *  the same fact and a second copy would eventually disagree with the first. The
 *  canonical name wants the TEXT; collectEditions wants the RANGE, so that an
 *  edition word inside the title's prose is not read as a release tag — "The
 *  Ultimate Object of Admiration" was claiming `[Ultimate]`, which then appeared
 *  on every preview as a rename that would never converge. */
function episodeTitleSpan(base: string): { start: number; end: number; title: string } | null {
  // "S0XE03" is a season-0 special marker, not a typo — accept it alongside the
  // normal S00E03 so the title after it is still found.
  const m = base.match(/(?<![A-Za-z0-9])[sS](?:\d{1,2}[\s._-]*[eE]\d{1,3}|0[xX][\s._-]*[eE]\d{1,3})\b[\s._-]+(.+)$/);
  if (!m) return null;
  // Offset of group 1 inside `base`: the match ends with the group, so the group
  // occupies the last m[1].length characters of m[0].
  const start = (m.index ?? 0) + (m[0].length - m[1].length);
  let rest = m[1];
  // Cut the release tail at whichever comes first: the first bracket group, or the
  // run of tags starting at the resolution. The resolution is matched after a DOT
  // as well as a space — a dotted release name is the common form
  // ("...S11E01.Episode.1.1080p.AMZN.WEB-DL") and the space-only pattern never
  // fired on one, so the whole tag run survived as the "title" and the canonical
  // name read "S11E00 - Episode.1.1080p.AMZN.WEB-DL.DDP2.0.H.264-WADU". Matching
  // the EARLIER of the two also keeps a bracketed title ahead of a later
  // resolution from truncating it.
  const bracket = rest.search(/[[({]/);
  // The separator in front of the resolution is OPTIONAL, which is what catches
  // a name that goes straight from the code into the tags: in
  // "S14E01.1080p.iP.WEB-DL..." nothing precedes "1080p", so a required
  // separator never matched, res stayed -1, and the entire tag run was returned
  // as the episode title — printing the release tail TWICE, once as text and
  // once as tags.
  const res = rest.search(/[\s._-]?\w*\d{3,4}[pi]\b/i);
  if (TAG_RUN_HEAD.test(rest)) return null;
  if (bracket >= 0 && (res < 0 || bracket <= res)) {
    // A leading bracket means the name went straight from the code to tags
    // ("- S03E01 [Dual Audio]") — there is no title to keep.
    if (bracket === 0) return null;
    rest = rest.slice(0, bracket);
  } else if (res === 0) {
    return null;
  } else if (res > 0) {
    rest = rest.slice(0, res);
  } else {
    // Neither marker: still drop a trailing tag word run, as before.
    rest = rest.replace(/\s+-\s*[A-Za-z0-9]{2,12}$/, "");
  }
  rest = rest.replace(/[[({]\s*$/, "").replace(/\s*[\])}]\s*$/, "").trim().replace(/[-_]+$/, "").trim();
  // Snapshot the end BEFORE the normalization below: until this line `rest` is
  // still a raw slice of `base`, so start + rest.length is a real range. The dot
  // and whitespace collapsing that follows rewrites lengths, after which the
  // string no longer lines up with `base` and could not be used as an offset.
  const end = start + rest.length;
  // Dots and underscores are how a release delimits words; a real title has
  // spaces. Normalizing here also lets the cached TMDB title agree with it, so
  // the packed-episode trailing check and the tail-shift search match on words.
  rest = rest.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  if (!rest || rest.length > 90) return null;
  // A leftover tag run ("1080p WEB-DL") is not a title.
  if (/^\[.*\]$/.test(rest) || /^\d{3,4}[pi]$/i.test(rest)) return null;
  if (!/[a-z]{3}/i.test(rest)) return null;
  return { start, end, title: rest };
}

/** On-disk episode title, or null when the release names none. Exported for
 *  tests: this decides whether the canonical name carries an episode title at
 *  all, and getting it wrong prints the whole tag run as the title. */
export function episodeTitleFromSourceName(base: string): string | null {
  return episodeTitleSpan(base)?.title ?? null;
}

function collectEditions(base: string): string[] {
  const span = episodeTitleSpan(base);
  const out: string[] = [];
  for (const m of base.matchAll(EDITION_MULTI_RE)) {
    // An edition word inside the episode title is PROSE, not a release claim:
    // "The Ultimate Object of Admiration" and "The Uncut Truth" are episode
    // names, and reading them as tags put [Ultimate]/[Uncut] on every preview of
    // files that are already canonical. Only the region past the title — the
    // bracket/dot/space run the release actually writes tags in — is evidence.
    if (span && m.index !== undefined && m.index >= span.start && m.index < span.end) continue;
    const label = editionLabel(m[1]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export interface ReleaseTags {
  tags: string;
  group: string | null;
  /** Platform watermark ("Bajeczki24"). Name-only, like the group, so it is
   *  inherited from a same-inode twin and never measured. */
  vendor: string | null;
  language: string | null;
  /** Which non-original audio the name states: a full DUB, or a LEKTOR
   *  voiceover. Polish releases are split between a dubbed track, a voiceover
   *  laid over the picture, and the original, so the audio *source* is a real
   *  quality tier and must survive naming. Null means the name says nothing, in
   *  which case the original track is implied. */
  dubKind: "DUB" | "LEKTOR" | null;
  source: string | null;
  /** Streaming service the WEB-DL came from ("NF", "AMZN"). Name-only, like the
   *  group, so inherited from a same-inode twin and never measured. Renders
   *  inside the source bracket — see PROVIDERS. */
  provider: string | null;
  resolution: string | null;
  audio: string[];
  hdr: string[];
  video: string[];
  misc: string[];
  /** Scene ENCODE-QUALITY modifiers ("Proper", "Repack", "Rerip"). They qualify
   *  the resolution and are written right after it ("2160p Proper"), so they
   *  render inside the source/resolution bracket rather than as standalone tags
   *  — see QUALITY_MODIFIERS. Name-only, like the group, so never measured. */
  qualityMods: string[];
}

/** Encode-quality modifiers a group appends to the resolution. These say the
 *  encode was fixed/re-done, which is a claim about the resolution group, so
 *  isolating them in their own bracket both mis-ranks them (they read as an
 *  unrelated edition) and loses the association the name states. */
const QUALITY_MODIFIERS = new Map<string, string>([
  ["proper", "Proper"],
  ["realproper", "Proper"],
  ["repack", "Repack"],
  ["rerip", "Rerip"],
  ["reenc", "Reencode"],
  ["reencode", "Reencode"],
]);
/** Render order, so a name carrying two prints them canonically. */
const QUALITY_MOD_RANK = ["Proper", "Repack", "Rerip", "Reencode"];

/** Raw ffprobe facts for one video stream (see services/mediaProbe). */
export interface ProbeVideoInfo {
  codecName: string | null;
  width: number | null;
  height: number | null;
  bitDepth: number | null;
  hdr: string[];
  /** Average frame rate in frames per second. ffprobe reports it as a fraction
   *  ("50/1"), and `avg_frame_rate` is preferred over `r_frame_rate` because the
   *  latter is the container's base rate and reports 24 for a 50fps broadcast
   *  stream. Null when the file states neither. */
  frameRate?: number | null;
  /** How many video streams the file holds. Only the first is measured, so a
   *  title naming a SECOND codec is only credible when there is more than one —
   *  see the codec-conflict rule in `assembleCanonicalTags`. */
  streamCount?: number;
}

/** Raw ffprobe facts for one audio stream. */
export interface ProbeAudioInfo {
  codecName: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  /** Stream "title" tag. Plenty of rips label the track here ("Polish",
   *  "Lektor") while leaving `language` empty, so it is a second chance at the
   *  same fact. */
  title: string | null;
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
  // "HDR10P"/"HDR10Pr" are the abbreviations release groups actually write
  // ("DV.HDR10P.H.265"). HDR10+ is dynamic metadata that ffprobe only reports
  // when it survives muxing as SMPTE ST 2094 side data — it is routinely absent,
  // leaving only the ST 2086 base layer, so the NAME is often the sole evidence
  // and dropping the spelling as an unknown token silently downgraded a release
  // to plain "[DV HDR10]".
  HDR10P: "HDR10+",
  HDR10PR: "HDR10+",
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
/** Every HDR_RANK entry but the bare umbrella "HDR" — i.e. flags that name a
 *  specific transfer function, and therefore make a plain "HDR" redundant. */
const SPECIFIC_HDR = new Set(HDR_RANK.filter((f) => f !== "HDR"));
function renderTags(f: {
  language: string | null;
  dubKind: "DUB" | "LEKTOR" | null;
  source: string | null;
  provider?: string | null;
  resolution: string | null;
  audio: string[];
  hdr: string[];
  video: string[];
  misc: string[];
  qualityMods?: string[];
}): string {
  // Language and dub share ONE bracket ("[PL DUB]" / "[PL LEKTOR]") because they
  // describe the same track: the same Polish language covers a dubbed, a
  // voiceover'd and an original one, and splitting them read as unrelated tags.
  // DUB and LEKTOR are kept apart because they are different tiers — a real dub
  // voices the characters, a lektor is one narrator over the picture.
  const lang = f.language ? (f.dubKind ? `${f.language} ${f.dubKind}` : f.language) : f.dubKind;
  let tags = lang ? `[${lang}] ` : "";
  // Encode-quality modifiers ride inside the resolution group ("[Remux-2160p
  // Proper]"), which is where groups write them. They are dropped rather than
  // orphaned into their own bracket when there is no resolution to attach to -
  // a bare "[Proper]" says less than the name it came from.
  const mods = [...(f.qualityMods || [])]
    .filter((m) => QUALITY_MOD_RANK.includes(m))
    .sort((a, b) => QUALITY_MOD_RANK.indexOf(a) - QUALITY_MOD_RANK.indexOf(b));
  const res = f.resolution ? [f.resolution, ...mods].join(" ") : null;
  // The streaming service rides inside the source bracket, after the resolution:
  // it qualifies WHERE the WEB-DL was ripped from, so "[WEBDL-2160p NF]" reads as
  // one fact. A separate "[NF]" would sort and scan as an unrelated tag, and the
  // bracket is the part both Radarr and Sonarr keep intact, so a name minted here
  // stays legible in either ecosystem.
  const prov = f.provider ? ` ${f.provider}` : "";
  if (f.source && res) tags += `[${f.source}-${res}${prov}]`;
  else if (f.source) tags += `[${f.source}${prov}]`;
  else if (res) tags += `[${res}${prov}]`;
  else if (prov) tags += `[${prov.trim()}]`;
  for (const a of f.audio) tags += `[${a}]`;
  // One bracket, and never a redundant member. HDR10+ implies the HDR10 base
  // layer, and a plain "HDR" is only the umbrella: once a specific flag is
  // present it adds nothing and reads as a duplicate. That pairing is easy to
  // get — the title claims HDR, the probe reads HDR10, and the merge keeps
  // both, printing "[HDR10 HDR]".
  const specific = f.hdr.some((x) => SPECIFIC_HDR.has(x));
  const hdr = [...f.hdr]
    .filter((x) => !(x === "HDR10" && f.hdr.includes("HDR10+")))
    .filter((x) => !(x === "HDR" && specific))
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

/** Conventional release tiers, lowest first. Used to compare two estimates. */
const RES_RANK = ["360p", "480p", "720p", "1080p", "1440p", "2160p"];

/** Tier implied by the WIDTH alone. Letterboxing and scope crops shrink height
 *  but never width, so width is the dimension that still carries the encode's
 *  real class. */
function resolutionFromWidth(width: number): string | null {
  if (width >= 2800) return "2160p"; // 3200x1800, 3840x2160, 4096x2160 (DCI)
  if (width >= 1800) return "1080p"; // 1920, 2048x1080 (DCI 2K)
  if (width >= 1200) return "720p"; // 1280
  if (width >= 620) return "480p"; // 720x576 PAL-DVD, 640x480
  return null;
}

/** Tier implied by the HEIGHT alone - only the taller formats can be recognised
 *  this way (2560x1440, 4096x2160), and a cropped frame understates the rest. */
function resolutionFromHeight(height: number): string | null {
  if (height >= 2000) return "2160p";
  if (height >= 1700) return "1080p"; // 2048x1080 (DCI)
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 400) return "480p";
  if (height >= 200) return "360p";
  return null;
}

/** The release's resolution TIER, from measured frame size.
 *
 *  Height alone cannot classify this. A 2.40:1 scope film is letterboxed inside
 *  a 1080p or 2160p transfer, so the cropped height lands a full tier or two
 *  low, and a height-only ladder called 1920x800 a "720p" - ranking 1.54
 *  megapixels BELOW 1280x720's 0.92. Naming claims the release resolution, not
 *  the pixel count, so the crop must not lower the answer.
 *
 *  Each dimension is classified independently and the HIGHER estimate wins: a
 *  cropped height may understate the tier, but the width still states it, and a
 *  format only height can identify (2560x1440) is not thrown away by a width
 *  ladder that has no 1440p band. A 3840x800 scope remux is 2160p, not 480p. */
function probeResolution(width: number | null | undefined, height: number | null | undefined): string | null {
  const byW = width ? resolutionFromWidth(width) : null;
  const byH = height ? resolutionFromHeight(height) : null;
  if (byW && byH) return RES_RANK.indexOf(byW) >= RES_RANK.indexOf(byH) ? byW : byH;
  return byW || byH;
}

function audioFamilyOf(l: string): string {
  // Strip the channel layout FIRST. A title entry carries it ("MP3 2.0", "DDP5.1")
  // while a probed label is the bare codec ("MP3"), so an unmapped codec fell
  // through to its raw text and the two stopped matching as one family - the
  // probed entry was then added alongside the title's instead of replacing it,
  // printing "[MP3 2.0][MP3 2.0]". That only surfaced once a release was renamed
  // to its own canonical form, because a raw release name says AVC and never
  // mentions MP3, so there was nothing to collide with.
  const n = l.toLowerCase().replace(/\s*\d\.\d(?:\s*ch)?\s*$/i, "").trim();
  if (/truehd|mlp/.test(n)) return "truehd";
  // DDP is the streaming spelling of E-AC3, so it must land on the same family or
  // a "[EAC3 Atmos 5.1]" name keeps its "DDP" twin bracket beside it.
  if (/eac3|ddp/.test(n)) return "eac3";
  if (/ac3/.test(n)) return "ac3";
  if (/dts/.test(n)) return "dts";
  if (/aac/.test(n)) return "aac";
  if (/flac/.test(n)) return "flac";
  if (/opus/.test(n)) return "opus";
  if (/pcm/.test(n)) return "pcm";
  if (/mp3/.test(n)) return "mp3";
  // The rest of NON_DISC_AUDIO, which had the same fall-through.
  if (/vorbis/.test(n)) return "vorbis";
  if (/alac/.test(n)) return "alac";
  if (/amr/.test(n)) return "amr";
  if (/wmav/.test(n)) return "wmav";
  return n || l.toLowerCase();
}

function videoFamilyOf(l: string): string {
  const n = l.toLowerCase();
  if (/hevc|x265|h265/.test(n)) return "hevc";
  if (/h264|x264|avc/.test(n)) return "avc";
  if (/av1/.test(n)) return "av1";
  if (/vp9/.test(n)) return "vp9";
  // Xvid, DivX and plain "MPEG-4" are all MPEG-4 Part 2, and ffprobe reports
  // that as codec_name "mpeg4" whichever encoder produced it. One family, so
  // the more specific name in the file name survives instead of being flattened
  // (or, worse, printed twice).
  if (/xvid|divx|mpeg-?4/.test(n)) return "mpeg4asp";
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
    const sameFam = audio.filter((a) => audioFamilyOf(a) === fam);    // Atmos is the one thing ffprobe cannot see (it is a mixing flag in the
    // stream metadata, not a codec), so the TITLE is the only evidence for it —
    // which is why it must be preserved for E-AC3 too. Streaming Atmos ships as
    // E-AC3, so restricting this to TrueHD dropped "[EAC3 Atmos 5.1]" to
    // "[EAC3 5.1]" and lost the one fact a reader cares about.
    //
    // Read it off the SAME-FAMILY entry only. The flag describes the track it was
    // written beside, so a name carrying a TrueHD Atmos track must not lend that
    // Atmos to a probed AAC dub of the same film: the Polish Soul dub measured
    // AAC 2.0 and rendered "[AAC Atmos 2.0]". With no same-family title entry
    // there is nothing to carry the claim, so it is simply not made.
    // A DETACHED "Atmos" token is the dotted tail's normal shape
    // ("...2160p.NF.WEB-DL.DDP5.1.Atmos.H.265"): every loose token is its own
    // group, so Atmos never rides a carrier inside its own bracket and sameFam
    // cannot see it. When the probe names a real carrier family and nothing else
    // in the title claims an Atmos, the flag belongs to this track - E-AC3 is the
    // streaming carrier, so a measured E-AC3 track must render
    // "[EAC3 Atmos 5.1]" rather than the two-bracket "[EAC3 5.1][Atmos]" that
    // split the one fact a reader cares about. Gated twice over: only on a real
    // carrier (so the Polish Soul dub measured as AAC still refuses a TrueHD
    // Atmos track's flag), and only on an UNCLAIMED one (so a title that names
    // its Atmos beside a different codec is left alone).
    const carrierFam = fam === "truehd" || fam === "eac3";
    const atmosClaims = audio.filter((a) => /atmos/i.test(a));
    const looseAtmos = atmosClaims.some((a) => /^atmos$/i.test(a.trim())) && atmosClaims.every((a) => /^atmos$/i.test(a.trim()));
    const claimAtmos = sameFam.some((a) => /atmos/i.test(a)) || (carrierFam && looseAtmos);
    const atmos = claimAtmos ? " Atmos" : "";
    let base = probedAudioLabel;
    if (sameFam.length) {
      if (fam === "dts") {
        if (sameFam.some((a) => /dts-hd ma/i.test(a))) base = "DTS-HD MA";
        else if (sameFam.some((a) => /dts-hd/i.test(a))) base = "DTS-HD";
        else base = "DTS";
      } else if (fam === "truehd") {
        base = "TrueHD";
      } else {
        // Keep the family spelling the title used, minus any channel number it
        // carried — the probe supplies the layout, and the two must not disagree.
        // The Atmos word is stripped too: it is appended once, from the single
        // `atmos` decision above, so keeping the title's own copy would double it
        // ("EAC3 Atmos Atmos 5.1") now that E-AC3 is a legal carrier.
        base = sameFam[0].replace(/\s+\d\.\d$/, "").replace(/\s+Atmos$/i, "").trim();
      }
    }
    const entry = `${base}${atmos}${ch ? ` ${ch}` : ""}`;
    // A loose Atmos folded into the carrier above must not survive as its own
    // entry, or the tag run reads "[EAC3 Atmos 5.1][Atmos]".
    const kept = audio.filter(
      (a) => audioFamilyOf(a) !== fam && !(carrierFam && looseAtmos && /^atmos$/i.test(a.trim())),
    );
    // Mirror the video dedup below: whatever survives must not reprint a label the
    // probed entry already carries. Family matching is the primary defence, but a
    // codec missing from audioFamilyOf used to slip a same-label duplicate through,
    // and that printed "[MP3 2.0][MP3 2.0]" which then re-parsed as two more and
    // grew by one bracket on every Fix Names pass.
    const lower = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    audio.length = 0;
    audio.push(entry);
    for (const x of kept) if (!audio.some((y) => lower(y) === lower(x))) audio.push(x);
  }

  const video = t.video.slice();
  const probedVideoLabel = v?.codecName ? probeVideoLabel(v.codecName) : null;
  if (probedVideoLabel) {
    const fam = videoFamilyOf(probedVideoLabel);
    // Same rule as audio: within the family the most specific label in the NAME
    // wins (ffprobe reports "mpeg4" for Xvid, DivX and plain MPEG-4 alike, so
    // without this a release named DivX would be silently relabelled Xvid).
    // ACROSS families, though, the two cannot both describe one stream, and
    // printing them side by side produced a name with two video codecs — Soul's
    // Polish mp4 inherited HEVC from the remux it was dubbed from, next to the
    // probed x264. There the probe is the accurate one and the title's claim is
    // dropped. The single exception is a file that genuinely carries more than
    // one video stream (only the first is measured), where the title's second
    // codec is the only evidence of it.
    // One stream collapses every same-family title label into the refined base,
    // mirroring audio; keeping them would print "[DivX][Xvid]" for one stream.
    const multiStream = (v?.streamCount ?? 1) > 1;
    const kept = multiStream ? video.slice() : [];
    let base = probedVideoLabel;
    if (fam === "mpeg4asp") {
      const named = video.find((x) => videoFamilyOf(x) === fam);
      if (named) base = named.replace(/\s+\d\.\d$/, "");
    }
    // Avoid duplicating the same label twice: a name's codec might have been
    // merged in the same way, and without this the refined "base" was pushed
    // onto a list that already contained it (or something that canonicalizes to
    // it). Compare case-insensitively, so "HEVC" and "Hevc" don't duplicate.
    const lower = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    video.length = 0;
    if (!video.some((x) => lower(x) === lower(base))) video.push(base);
    for (const x of kept) if (!video.some((y) => lower(y) === lower(x))) video.push(x);
  }
  if (v?.bitDepth && Number(v.bitDepth) >= 10 && !video.some((x) => /10bit/i.test(x))) video.push("10bit");

  // HDR10+ is dynamic metadata layered ON the ST 2086 base layer, so within the
  // HDR10 family the title REFINES the probe rather than contradicting it:
  // ffprobe routinely reports only the base, leaving "[DV HDR10]" where the
  // release plainly said HDR10P, and the title is then the better evidence.
  // Across transfer functions it IS a conflict, and there the probe is the
  // accurate one. HLG is its own signal, mutually exclusive with PQ-based HDR10
  // and Dolby Vision alike, so a name claiming either on a stream the probe
  // measured as HLG loses. WCG/BT.2020 is a gamut rather than a transfer, so it
  // coexists with everything and is never dropped.
  const probeHdr = v?.hdr || [];
  const titleHdr = probeHdr.includes("HLG")
    ? t.hdr.filter((x) => !/^(DV|HDR10\+?)$/i.test(x))
    : t.hdr;
  const hdr = Array.from(new Set([...titleHdr, ...probeHdr]));
  // Real pixel height is the ground truth for resolution, so it OVERRIDES a title
  // claim rather than only filling a blank: Soul's Polish dub was named after the
  // 43.6 GB remux and still says "2160p", while the stream measures 720p in 1.9 GB.
  const resolution = probeResolution(v?.width, v?.height) ?? t.resolution;

  // "Remux" is a claim about provenance, but it makes checkable promises, and the
  // probe can refute them: a remux is a bit-exact copy of a disc's main track, so
  // it is never below 1080 and its main audio is always lossless. Measured 720p
  // with AAC 2.0 is a transcode no matter what the name claims. The label is
  // DROPPED rather than replaced — guessing Bluray/WEBDL from a contradiction
  // would be inventing provenance.
  const source = sourceRefutedByProbe(t.source, v, primary) ? null : t.source;

  // A Polish dub says nothing in its file NAME — the audio stream tag is the only
  // evidence, and it outranks the name: a file tagged [PL] with no Polish audio
  // is not a Polish dub. Streams with no usable code abstain, leaving the title.
  const probed = probeLanguage(probe);
  // A title that enumerates its languages ("[EN+FR+ES+DE+JA+KO+ZH+PL]") is both
  // true and more informative than what the streams can offer, so it survives.
  // A title that says only "MULTI" — or names ONE language, which tracks in
  // eight contradict — loses to the probe, which actually read the stream tags.
  const language = probed
    ? probed.multi
      ? t.language && t.language.includes("+") ? t.language : probed.lang
      : probed.lang
    : (t.language ?? null);

  // Frame rate is measurable, so the PROBE decides it, on the same rule the
  // resolution and codec merges follow: a name claiming HFR on a 25fps stream
  // loses, and a 50fps stream measured as high frame rate gains the flag even
  // when the name is silent. "HFR" is the conventional spelling and is what the
  // release round-trips against, so the measured value is reduced to it rather
  // than printed as "50fps" - which would read as a resolution-class claim.
  // > 30 matches the industry definition (50/60 vs 24/25/30); 30fps itself is not.
  const fps = v?.frameRate ?? null;
  const namedHfr = t.misc.some((m) => /^hfr$/i.test(m.trim()));
  const misc = t.misc.filter((m) => !/^hfr$/i.test(m.trim()));
  if (fps === null ? namedHfr : fps > 30) misc.push("HFR");

  return {
    ...t,
    language,
    resolution,
    source,
    audio,
    hdr,
    video,
    misc,
    tags: renderTags({ ...t, language, resolution, source, audio, hdr, video, misc }),
  };
}

/** Audio codecs that cannot come off a Blu-ray or UHD disc, so a file whose main
 *  track is one of them is not a remux whatever its name claims. */
const NON_DISC_AUDIO = /^(aac|mp3|opus|vorbis|flac|alac|amr|wmav\d?)$/i;

/** Does the measured evidence refute a "Remux" claim? A remux is a bit-exact
 *  copy of a disc's main track: never below 1080p, always lossless main audio.
 *  Anything else is a transcode that merely inherited the word. */
function sourceRefutedByProbe(source: string | null | undefined, v: ProbeVideoInfo | null, primary: ProbeAudioInfo | null): boolean {
  if (!source || String(source).toLowerCase() !== "remux") return false;
  // A remux is never below 1080, so a measured TIER under 1080 refutes it. This
  // tests the tier, not the raw height, for the same reason the resolution
  // classifier does: a 1920x800 or 3840x800 scope film is a letterboxed 1080p /
  // 2160p transfer, and a raw height test would have discarded the remux claim
  // on exactly the files a remux is supposed to be.
  const tier = probeResolution(v?.width, v?.height);
  if (tier && RES_RANK.indexOf(tier) < RES_RANK.indexOf("1080p")) return true;
  if (primary?.codecName && NON_DISC_AUDIO.test(String(primary.codecName))) return true;
  return false;
}

/** What the audio streams say about the release language.
 *  - `null`  → the streams carry no usable code, so the title is left to decide.
 *  - `{ lang: null }` → the evidence contradicts a language claim: a single
 *    English track is not a distinguishing tag AND not a Polish dub, whatever
 *    the file name claims. Ground truth beats the name.
 *  - `{ lang, multi: true }` → the release is MULTI-language.
 *  - `{ lang }` → use it.
 *
 *  A Polish dub carries nothing in its file NAME, so the stream tag is the only
 *  evidence. When tracks disagree the release is a dub, and the dub is what
 *  identifies it — "pol + eng" is a Polish release, so it is [PL], not [EN].
 *
 *  That only holds while there is ONE foreign language. A Blu-ray remux with
 *  en/fr/es/de/ja/ko/zh/pl tracks is multi-language, and picking the first
 *  foreign code in stream order just reports whichever language the encoder
 *  happened to list first (The Lion King was tagged [FRA] for having 8 tracks).
 *  No single language identifies a multi release, so say MULTI and keep any
 *  enumeration the title already gave ([EN+FR+ES+DE+JA+KO+ZH+PL] is strictly
 *  more informative than [MULTI]). */
function probeLanguage(probe: ProbeInfo | null): { lang: string | null; multi?: boolean } | null {
  const streams = probe?.audio || [];
  // `language` first, then the track's "title" tag — a lot of rips put the
  // language in one and leave the other empty, and both say the same thing.
  const codes = streams
    .map((a) => streamLanguageCode(a.language) || streamLanguageCode(a.title))
    .filter((c): c is string => !!c);
  if (!codes.length) return null;
  // `streamLanguageCode` already folded the ISO-639-2 codes through
  // LANG_ALIASES, so a usable code is two letters. Anything else is a language
  // we do not speak: abstain and let the title decide, rather than emit a label
  // the title parser could not read back on the next pass.
  const label = (code: string): string | null => (/^[a-z]{2}$/.test(code) ? code.toUpperCase() : null);
  // Matroska's own "mul" (mixed languages inside one track) is a multi signal
  // on its own, and it must not be read as a language called "MUL". The languages
  // inside such a track are unknown, so this is the one case that says MULTI.
  if (codes.some((c) => c === "mul" || c === "multi")) return { lang: "MULTI", multi: true };
  const distinct = Array.from(new Set(codes));
  if (distinct.length > 1) {
    const foreign = distinct.filter((c) => !isEnglishCode(c));
    // One foreign language beside English is the dub case that identifies the
    // release. Two or more means multi, where naming one would be arbitrary.
    if (foreign.length === 1) {
      const only = label(foreign[0]);
      return only ? { lang: only } : null;
    }
    // The streams DO name every language, so state them all in track order
    // ("EN+FR+ES+DE+JA+KO+ZH+PL") rather than a bare MULTI — same information a
    // Blu-ray rip prints in its own name, and it keeps a processed file and its
    // library twin on identical tags.
    const all = distinct.map(label).filter((c): c is string => !!c);
    return { lang: all.length > 1 ? all.join("+") : "MULTI", multi: true };
  }
  if (isEnglishCode(distinct[0])) return { lang: null };
  const single = label(distinct[0]);
  return single ? { lang: single } : null;
}

const isEnglishCode = (code: string): boolean => code === "en" || code === "eng";

/** Full language NAMES as they appear in stream track titles ("English
 *  Commentary", "Polish dub", "Français"). Deliberately NOT folded into
 *  LANG_ALIASES: that table is shared with the file-name parser, and "English"
 *  or "French" inside a film title ("The English Patient") is not a language
 *  tag. Track titles have no such ambiguity. */
const PROBE_LANG_NAMES: Record<string, string> = {
  ENGLISH: "EN",
  FRENCH: "FR",
  GERMAN: "DE",
  SPANISH: "ES",
  ITALIAN: "IT",
  DUTCH: "NL",
  PORTUGUESE: "PT",
  BRAZILIAN: "PT",
  RUSSIAN: "RU",
  UKRAINIAN: "UK",
  JAPANESE: "JA",
  KOREAN: "KO",
  CHINESE: "ZH",
  MANDARIN: "ZH",
  CZECH: "CZ",
  SLOVAK: "SK",
  HUNGARIAN: "HU",
  ROMANIAN: "RO",
  GREEK: "GR",
  TURKISH: "TR",
  SWEDISH: "SE",
  NORWEGIAN: "NO",
  DANISH: "DK",
  FINNISH: "FI",
  BULGARIAN: "BG",
  VIETNAMESE: "VI",
  THAI: "TH",
  HEBREW: "HE",
  ARABIC: "AR",
  HINDI: "HI",
  INDONESIAN: "ID",
};

/** The two-letter codes this kernel is willing to believe. Anything else — "HD",
 *  "VO", "DD", "AC" — is a channel/edition marker that happens to be two
 *  letters, and reading it as a language would invent a tag. */
const KNOWN_LANG_CODES = new Set(
  [...LANG_TAGS].filter((c) => /^[A-Z]{2}$/.test(c)).concat(Object.values(LANG_ALIASES)),
);

/** Normalise one stream language value to a bare ISO code, or null when it says
 *  nothing usable. Accepts the code itself ("pl", "pol"), a full name ("Polish",
 *  "English"), and a free-text track title — which is where a lot of rips put
 *  the language ("7.1 fr", "pl ac3 6ch 48 khz"), so every word is tried, not just
 *  the first. A DUB marker on its own ("dubbed") names no language and is
 *  dropped rather than guessed at. */
function streamLanguageCode(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "und" || value === "unknown") return null;
  const words = value.split(/[\s._+-]+/).filter(Boolean);
  for (const [i, word] of words.entries()) {
    if (DUB_MARKERS.has(word.toUpperCase())) continue;
    const up = word.toUpperCase();
    if (LANG_ALIASES[up]) return LANG_ALIASES[up].toLowerCase();
    if (PROBE_LANG_NAMES[up]) return PROBE_LANG_NAMES[up].toLowerCase();
    // A leading two/three-letter token is a real `language` tag, so an
    // unfamiliar 3-letter ISO code is worth reporting (and `probeLanguage`
    // abstains on it later). A LATER word must be a code we know, or a track
    // titled "5.1 DTS-HD Master Audio" would report "dts" as a language.
    if (i === 0 && /^[a-z]{2}$/.test(word)) return word;
    if (/^[a-z]{2}$/.test(word) && KNOWN_LANG_CODES.has(up)) return word;
    if (i === 0 && /^[a-z]{3}$/.test(word)) return word;
  }
  return null;
}

/** Strip end-of-name qualifiers that sit after the release group and would
 *  otherwise hide it. Only a collision suffix is peeled here (" (1)", "(2)"),
 *  and only when the parentheses hold bare digits — so "San Andreas (2015)" and
 *  an edition in parentheses are never touched. A trailing language word is NOT
 *  peeled blindly: it is real evidence for the language tag, so it is handled
 *  by the group retry below, which only consumes it when doing so actually
 *  uncovers a group. */
function peelTrailingQualifiers(base: string): string {
  let out = base;
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(/(?:\s*-\s*|\s*)\(\d{1,3}\)$/, "").replace(/\(\d{1,3}\)$/, "");
    out = out.replace(/[\s.\-]+$/, "");
    if (out === before) break;
  }
  return out;
}

/** The trailing word when it is a known language or dub marker (" - polish",
 *  " - Lektor"), else null. */
function trailingLanguageWord(base: string): { word: string; index: number } | null {
  const m = base.match(/[-.\s]([A-Za-z]{2,12})$/);
  if (!m || m.index === undefined) return null;
  const up = m[1].toUpperCase();
  return LANG_ALIASES[up] || DUB_WORDS.has(up) || DUB_MARKERS.has(up) || LANG_TAGS.has(up) ? { word: m[1], index: m.index } : null;
}

/** Escape a user-supplied vendor name for use inside a RegExp — a brand may
 *  legitimately contain "." or "+" (e.g. "Canal+"), which would otherwise
 *  compile into a pattern that matches far more than the name. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A language or dub word is real evidence about the audio, never a release
 *  group. The anchored group rule never met one (a trailing "- Polish" was
 *  peeled by `trailingLanguageWord` first), but it CAN now: a word that ends a
 *  paren is reachable, so "(Dual Audio - Polish)" would otherwise promote
 *  "Polish" to a group. */
function isLanguageishWord(word: string): boolean {
  const up = word.trim().toUpperCase();
  return !!LANG_ALIASES[up] || DUB_WORDS.has(up) || DUB_MARKERS.has(up) || LANG_TAGS.has(up);
}

/** An episode or season code is never a release group — it is a position, and
 *  this app writes it into the name it then has to re-read.
 *
 *  The canonical special template puts a SPACED dash before the marker
 *  ("Krecik i balonik - S00E01 [tags]"), and all three group rules accept
 *  `-\s*`, so `S00E01` was claimed as the group and re-rendered at the tail as
 *  `-S00E01` after the tags. The rename then never converged: the file was
 *  already correct on disk and every pass proposed to change it again. A bare
 *  season code is the same shape from a season pack ("Show - S01 [1080p]").
 *
 *  A release group is a name someone chose, and no one picks "S01E01", so the
 *  exclusion costs nothing real. Anchored on purpose — "S0X" inside a longer
 *  handle is not a code. The `S0xE03` spelling is included because
 *  parseEpisodeCode reads it as a real season-0 marker. */
function isEpisodeCodeWord(word: string): boolean {
  return /^s\d{1,2}e\d{1,3}$/i.test(word) || /^s0xe\d{1,3}$/i.test(word) || /^s\d{1,2}$/i.test(word);
}

/** A trailing release group, tolerating the bracket run that may close over it.
 *
 *  Polish rips put the group LAST inside the tag run and then close the bracket,
 *  sometimes with a vendor after it:
 *    "… (1080p NF Webrip x265 10bit EAC3 2.0 - WEM)[TAoE]"
 *  The old rule anchored at end-of-string, so that trailing run hid the group
 *  completely and the word fell through to the tokenizer as a stray "[WEM]" —
 *  which is not the same thing at all, and a rename could not converge.
 *
 *  The closer must follow the group DIRECTLY, with no space. That is the whole
 *  constraint: a tag run after a space is a separate group that the word is not
 *  inside, so "… - Title (1080p)" still does not promote "Title" to a group. */
const GROUP_TAIL = /-\s*([A-Za-z0-9][A-Za-z0-9-]{1,20})(?:\s*\)|\s*)(?:\[[^\]]*\])*$/;

/** The group word, and where the WORD starts and ends — the caller excises
 *  exactly `- WORD` and keeps whatever followed it. That is not bookkeeping: a
 *  closer and a vendor bracket sit AFTER the group ("- WEM)[TAoE]"), so slicing
 *  to the end of the match deleted the vendor before it could ever be read, and
 *  the whole watermark vanished from the name instead of rendering. */
function matchGroupTail(s: string): { word: string; start: number; end: number } | null {
  const m = s.match(GROUP_TAIL);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].indexOf(m[1]);
  const word = m[1].replace(/-+$/, "");
  return word ? { word, start, end: start + m[1].length } : null;
}

/** Fill the release facts a name cannot prove from a same-inode sibling's name.
 *
 *  A processed file and its library hardlink are the SAME bytes under two names,
 *  and the facts that only a name can carry — source, group, edition — are true
 *  of both. Naming each from its own name alone loses whatever the other
 *  happened to state: The Hobbit's Extended library file was named without
 *  "Remux" or the group, so its proposal silently dropped both and would have
 *  renamed the release group out of existence.
 *
 *  GAPS ARE FILLED, NEVER OVERRIDDEN: a name that already says Atmos, or names
 *  its own source or group, keeps it. Everything ffprobe measures — resolution,
 *  codecs, channels, bit depth, HDR, language — is recomputed per file and is
 *  never inherited, so this can only add release metadata, never stale it. */
export function inheritReleaseFacts(
  target: ReleaseTags,
  siblingBase: string | null | undefined,
  vendors?: readonly string[] | null,
  probe?: ProbeInfo | null,
): ReleaseTags {
  if (!siblingBase) return target;
  const sibling = parseReleaseTags(siblingBase.replace(/\.(mkv|mp4|avi|mov|ts|wmv|iso|m2ts|webm)$/i, ""), vendors);
  const out: ReleaseTags = { ...target, misc: [...target.misc], qualityMods: [...(target.qualityMods || [])] };
  let changed = false;
  if (!out.source && sibling.source) { out.source = sibling.source; changed = true; }
  // A provider is a NAME claim about where the source was ripped from, and
  // nothing measures it — so a twin's name fills the gap exactly like the group.
  // It qualifies the source rather than standing alone, so a file named by an arr
  // as a plain "WEB-DL" would otherwise silently lose the service.
  if (!out.provider && sibling.provider) { out.provider = sibling.provider; changed = true; }
  if (!out.group && sibling.group) { out.group = sibling.group; changed = true; }
  if (!out.vendor && sibling.vendor) { out.vendor = sibling.vendor; changed = true; }
  // Encode-quality modifiers are a NAME claim (nothing measures them), exactly
  // like the group, so a twin's name stating "Proper" fills the gap. But they
  // describe ONE encode rather than accumulating like editions do: a name that
  // states its own is kept whole, and the twin's set is only adopted when the
  // name is silent. Merging instead would invent "[Proper Repack]" - a repack is
  // not a proper release, and a pair that contradicts is worse than either alone.
  if (!out.qualityMods.length) {
    for (const q of sibling.qualityMods || []) {
      if (!out.qualityMods.includes(q)) { out.qualityMods.push(q); changed = true; }
    }
  }
  // Only EDITION labels are inherited. Misc also holds unrecognized bracket tags
  // preserved verbatim, and those belong to the file whose name carried them.
  for (const ed of sibling.misc.filter(isEditionLabel)) {
    if (!out.misc.some((m) => m.toLowerCase() === ed.toLowerCase())) { out.misc.push(ed); changed = true; }
  }
  if (changed) out.tags = renderTags(out);
  // Inheritance runs AFTER the probe reconciliation, so a "Remux" arriving from a
  // twin would sneak past it and re-label a transcode. Re-check here.
  if (probe && out.source) {
    const refuted = sourceRefutedByProbe(out.source, probe.video || null, probe.audio[0] || null);
    if (refuted) { out.source = null; out.tags = renderTags(out); }
  }
  return out;
}

/** EDITION_MULTI_RE is global, and a global regex carries lastIndex between
 *  .test() calls — so match against a fresh non-global copy. */
const EDITION_TEST_RE = new RegExp(EDITION_MULTI_RE.source, "i");
const isEditionLabel = (misc: string): boolean => EDITION_TEST_RE.test(misc);

/**
 * Extract the trailing release metadata from a filename base so it can survive
 * a canonical rename. Reads both bracketed ("[Bluray-1080p]", "[AC3 2.0]",
 * "[PL]", "[HDR10]") and loose dotted ("Dune.2021.1080p.WEB-DL.x265-GRP") forms,
 * plus a "-GROUP" tail. Unknown pieces are dropped, never guessed at — other
 * than preserving unrecognized short bracket tags verbatim.
 */
export function parseReleaseTags(baseName: string, vendors?: readonly string[] | null): ReleaseTags {
  // `?? DEFAULT_VENDORS` rather than a parameter default: a caller passing an
  // explicit null would otherwise skip the default and crash on `.length`.
  const vList = vendors ?? DEFAULT_VENDORS;
  const out: ReleaseTags = { tags: "", group: null, vendor: null, language: null, dubKind: null, source: null, provider: null, resolution: null, audio: [], hdr: [], video: [], misc: [], qualityMods: [] };
  let base = baseName.replace(/\.(mkv|mp4|avi|mov|ts|wmv|iso|m2ts|webm)$/i, "");

  // Editions ("International", "Extended", "Director's Cut", …) are preserved
  // as tags — and a bare "-International"-style tail that is one of them stops
  // being treated as a release group.
  const editions = collectEditions(base);

  // Tail qualifiers that sit AFTER the release group and break every tail rule,
  // because both the group regex and the vendor peel anchor at end-of-string:
  //   "…Atmos-FGT (1)"  a collision suffix from a previous rename
  //   "…Atmos-FGT - polish"  a language word trailing the group
  // Both are peeled only when positively recognized — "(1)" must be bare digits
  // so "San Andreas (2015)" and "(Director's Cut)" are never touched, and the
  // word must already be a known language/dub marker.
  base = peelTrailingQualifiers(base);

  // A vendor is the one piece that arrives as a BARE trailing word, with no
  // hyphen and no bracket ("… i stara szafa 2005 Bajeczki24"), because that is
  // how streaming rips brand themselves. Nothing else would read it: the group
  // rule only matches a "-WORD" tail, and the tokenizer drops unknown words. So
  // it is lifted out first, before either rule can misjudge it. Boundaries are
  // Unicode-aware so a Polish vendor name is not cut in half, and the name's own
  // spelling is kept.
  const vRe = vList.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${vList.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null;
  const vHit = vRe ? base.match(vRe) : null;
  if (vHit && vHit.index !== undefined) {
    out.vendor = vHit[2];
    // The match is the boundary char plus the name, so a BRACKETED vendor loses
    // only the name and leaves its own bracket behind ("…-WEM)[TAoE]" -> "…)"). A
    // stray "]" is not cosmetic: it is not a word, so no later tail rule can see
    // past it, and the release group hiding in front of it was dropped entirely —
    // while the vendor rendered fine, which is why it looked like a group bug.
    // Take the wrapping brackets with it, wherever they sit.
    const before = base.slice(0, vHit.index);
    const after = base.slice(vHit.index + vHit[0].length);
    const wrapped = before.endsWith("[") && after.startsWith("]");
    base = (wrapped ? before.slice(0, -1) + after.slice(1) : before + after).replace(/[-.\s]+$/g, "").replace(/\s{2,}/g, " ").trim();
  }

  // A trailing "-Group" is a release group whether or not it is ALLCAPS: real
  // groups are frequently mixed case and Polish ("-Alusia", "-FraMeSToR",
  // "-ELiTE", "-Zima", "-drzewa"). Shape cannot separate them from a title
  // ending in a hyphenated word, so the tag wins and only codec/edition words
  // are rejected — those are never a group. A "-Vendor" tail is not a group
  // even though "-Bajeczki24" would match the shape, so the vendor is peeled
  // off first: that is what makes the rename idempotent, since the canonical
  // form ends in one.
  if (out.vendor) {
    const tail = new RegExp(`[-.]${escapeRe(out.vendor)}$`, "i");
    if (tail.test(base)) base = base.replace(tail, "").replace(/[-.\s]+$/g, "").trim();
  }
  // A trailing language/dub word is evidence, not a group, so it is only
  // consumed when it is demonstrably hiding one: "…Atmos-FGT - polish" and
  // "…-GRP-polish" both end in a marker that the anchored group regex would
  // otherwise either miss (spaced) or misread as the group itself (hyphenated).
  // When nothing is found behind it the word stays in the name and the tokenizer
  // reads it as the language it is — which is the only reason to touch it at all.
  const langWord = trailingLanguageWord(base);
  // A group may itself be hyphenated ("AS76-FT"), and the canonical form ENDS in
  // one. With the old single-segment class the round-trip re-read "-AS76-FT" as
  // the group "FT", so every later pass would shorten it again and the rename
  // would never converge - the same failure mode as the vendor tail. The last
  // hyphen is the separator; everything before it is the group.
  const grp = langWord ? null : matchGroupTail(base);
  if (grp && !looksLikeCodec(grp.word) && !EDITION_SINGLE.has(grp.word.toLowerCase()) && !isPlaceholderWord(grp.word) && !isLanguageishWord(grp.word) && !isEpisodeCodeWord(grp.word)) {
    out.group = grp.word;
    base = (base.slice(0, grp.start).replace(/[-.\s]+$/g, "") + base.slice(grp.end)).trim();
  } else if (langWord) {
    const trimmed = base.slice(0, langWord.index).replace(/[-.\s]+$/g, "");
    const retry = matchGroupTail(trimmed);
    if (retry && !looksLikeCodec(retry.word) && !EDITION_SINGLE.has(retry.word.toLowerCase()) && !isPlaceholderWord(retry.word) && !isLanguageishWord(retry.word) && !isEpisodeCodeWord(retry.word)) {
      out.group = retry.word;
      // Same precedence as the bracket path above: a dub marker names the audio
      // SOURCE, not a language, and must be caught before the LANG_TAGS check —
      // DUB/DUBBED/DUBBING are members of LANG_TAGS, so testing tags first turned
      // a trailing "- Dubbing" into the bogus language "[DUBBING]" (the very
      // rendering the bracket path's guard exists to prevent). A "Lektor" tail,
      // by contrast, DOES carry its language, so it must set both.
      const up = langWord.word.toUpperCase();
      const alias = LANG_ALIASES[up];
      if (alias) {
        out.language = alias;
        if (LEKTOR_WORDS.has(up)) out.dubKind = "LEKTOR";
        else if (DUB_WORDS.has(up)) out.dubKind = "DUB";
      } else if (DUB_MARKERS.has(up)) {
        out.dubKind = "DUB";
      } else if (LANG_TAGS.has(up)) {
        out.language = up;
      }
      base = (trimmed.slice(0, retry.start).replace(/[-.\s]+$/g, "") + trimmed.slice(retry.end)).trim();
    }
  }

  const misc: string[] = [];
  // "2160p" is an explicit claim; "4K"/"UHD" is a class that only fills a gap.
  let sawNumericRes = false;
  // Where out.audio stood when the current bracket began. Tokens inside one
  // bracket belong together, so a bare "Atmos" may only claim a carrier named in
  // the same bracket — that is what makes "[EAC3 Atmos 5.1]" round-trip while
  // still refusing to jump across "[DTS] [Atmos]".
  let audioMark = 0;
  const tryToken = (tok: string, fromBracket: boolean) => {
    const at = tok.trim();
    if (!at) return;
    if (EDITION_SINGLE.has(at.toLowerCase())) return;
    // Streaming service, checked before anything can misread it. Matched EXACTLY,
    // case included: release groups write these all-caps ("WEB-DL NF", "HMAX
    // WEBRip"), so a lowercase "nf" is title or group text rather than a provider,
    // and a false provider is worse than a missing one — the source is still
    // stated either way. Consuming it here also stops the unknown-word drop from
    // discarding it. Read from both the bracket pass and the loose tail, so a
    // re-parsed canonical "[WEBDL-2160p NF]" round-trips.
    const prov = PROVIDERS.get(at);
    if (prov) {
      // First one wins, so a name carrying two keeps the one the source came from
      // rather than whichever token the tokenizer reached last.
      if (!out.provider) out.provider = prov;
      return;
    }
    // Polish releases are marked "Lektor"/"Polski" rather than by a country
    // code, so those words ARE the language. Resolved before LANG_TAGS so they
    // are not also left behind in the trailing misc tags.
    const up = at.toUpperCase();
    const alias = LANG_ALIASES[up];
    if (alias) {
      out.language = alias;
      // "Lektor"/"Nauka" name the dubbing studio, so they say the audio is NOT the
      // original track on top of saying the language — but a lektor is a voiceover
      // rather than a dub, so it keeps its own tag.
      if (LEKTOR_WORDS.has(up)) out.dubKind = "LEKTOR";
      else if (DUB_WORDS.has(up)) out.dubKind = "DUB";
      return;
    }
    // "PLDUB", "PL-DUB", "PL.DUB" — the country code glued to a dub marker.
    // Split on any of the usual separators, or none at all.
    const dubbed = at.toUpperCase().match(/^([A-Z]{2})[-_.]?(?:DUB|DUBBED|DUBBING)$/);
    if (dubbed) {
      out.language = dubbed[1];
      out.dubKind = "DUB";
      return;
    }
    if (DUB_MARKERS.has(up)) {
      // A bare "DUB"/"DUBBED"/"DUBBING" names the audio SOURCE, not a language,
      // so it must never become one ("[Dubbing]" alone was rendering as
      // `[DUBBING]`) — it only marks the dub.
      out.dubKind = "DUB";
      return;
    }
    // "EN+FR+ES+DE+JA+KO+ZH+PL", "PL+EN" — a multi-language release enumerates
    // its audio tracks with "+". Every part has to be a known code, so codec or
    // resolution lists ("x264+x265", "1080p+720p") can never be mistaken for
    // one. The enumeration is the honest description of a multi release and is
    // the one form more informative than a bare "[MULTI]", so it is kept whole.
    const parts = at.toUpperCase().split("+").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => LANG_TAGS.has(p) || LANG_ALIASES[p])) {
      const codes = parts.map((p) => LANG_ALIASES[p] || p);
      out.dubKind = out.dubKind || (codes.some((c) => DUB_MARKERS.has(c)) ? "DUB" : null);
      out.language = codes.filter((c) => !DUB_MARKERS.has(c)).join("+") || "MULTI";
      return;
    }
    // A bare language CODE is evidence only where evidence is written: inside
    // brackets, or as its own uppercase release token. The loose tail has no
    // brackets to scope it, so EVERY word in the name reaches here — including
    // the episode title, which the tokenizer cannot tell from a tag run. A
    // two-letter code collides with ordinary English constantly: "They Call It
    // Doom" rendered [IT] (Italian) on a release that states no language at all,
    // and any episode titled "No Way Out" would be [NO] (Norwegian). A false
    // language is worse than a missing one, and a title says it as `It`, never as
    // the all-caps `IT` a group writes — the same case test PROVIDERS uses to
    // keep a lowercase "nf" out of the source. So a loose token must be exactly
    // its uppercase form, while a bracket keeps accepting any case: "[pl]" is
    // still a bracketed claim, and the canonical form is always written
    // uppercase, so a re-parse round-trips either way.
    if (LANG_TAGS.has(up) && at.length <= 12 && (fromBracket || at === up)) {
      out.language = up;
      return;
    }
    // A bare channel number ("7.1", "2.0") right after an audio token appends
    // to that track ("TrueHD Atmos" + "7.1" → "TrueHD Atmos 7.1"). It must land
    // on a CODEC: "Atmos" is a mixing format, not a layout, so letting "5.1"
    // attach to a standalone "[Atmos]" rendered a meaningless "[Atmos 5.1]" —
    // which is what a title saying "[EAC3 Atmos 5.1]" produced. Attach to the
    // nearest real codec, or drop the number when the name states no codec.
    if (/^\d\.\d$/.test(at) && out.audio.length) {
      const idx = lastAudioCodecIndex(out.audio);
      if (idx < 0) return;
      const last = out.audio[idx];
      if (!last.includes(at)) out.audio[idx] = `${last} ${at}`;
      return;
    }
    const srcM = at.match(SOURCE_RE);
    const resM = at.match(RES_RE);
    const resWord = RES_WORDS[up.replace(/[-_.]/g, "")] || null;
    if (srcM) {
      const next = normalizeSource(srcM[1]);
      // A bare "web" is the UMBRELLA for WEBDL/WEBRip, and it is the only source
      // token that is also ordinary English prose. An episode title reading
      // "Tangled Web" matched it and overwrote the name's OWN [WEBDL-720p] with
      // [WEB-720p] — and where the name stated no source at all it invented one
      // ("Like a Rock!" parsed WEBDL, "Tangled Nets" parsed WEBDL, "Tangled Web"
      // parsed WEB). So the generic form has to LOOK like a release tag before it
      // counts: bracketed, or release-cased. That is the rule the language codes
      // already follow below ("It"/"No" in a title are words; "IT"/"NO" are tags)
      // and the one PROVIDERS matches case-sensitively above — the discriminator
      // this codebase already uses for title text versus release facts.
      //
      // The specific forms never need the guard: SOURCE_RE lists `web-?dl` and
      // `web-?rip` ahead of `web`, so they win the alternation and are matched
      // instead — a lowercase "web-dl" is still a source, only the bare word is
      // ambiguous. Not upgrading is the correct outcome: once WEBDL is stated the
      // umbrella adds nothing, which is the same shape as a bare "HDR" being
      // dropped once a specific HDR10/DV flag is present.
      const bareWeb = next === "WEB";
      if (!bareWeb || fromBracket || at === up) out.source = next;
    }
    if (resM) {
      // An explicit pixel count is the most specific claim there is, so it wins
      // over any word form ("4K" must not overwrite a stated "1080p").
      out.resolution = `${resM[1]}p`;
      sawNumericRes = true;
    } else if (resWord && !sawNumericRes) {
      // Between word forms keep the highest tier, so "8K.UHD" does not end up
      // naming an 8K file as 2160p just because "UHD" came last.
      const cur = out.resolution;
      if (!cur || parseInt(resWord, 10) >= parseInt(cur, 10)) out.resolution = resWord;
    }
    const audio = parseAudioToken(at);
    if (audio) {
      if (audio === "Atmos") {
        // Atmos is a MIXING FORMAT that rides a carrier codec, and the carrier is
        // named right beside it: streaming Atmos is E-AC3 (Netflix/Disney+/Max),
        // disc Atmos is TrueHD. So the codec in the SAME bracket is the legal
        // target, and it makes "[EAC3 Atmos 5.1]" round-trip as itself.
        //
        // A bare "[Atmos]" in its own bracket must NOT attach to an arbitrary
        // family: matching any family grabbed whichever entry sat first, so
        // Soul's DTS track claimed it and rendered a non-existent
        // [DTS-HD MA Atmos] beside a correct [TrueHD Atmos 7.1]. TrueHD stays
        // the one cross-bracket fallback (it is the only disc carrier), and
        // with no carrier at all it stays a standalone tag.
        const sameBracket = out.audio.findIndex((a, i) => i >= audioMark && !/^atmos\b/i.test(a));
        const idx =
          sameBracket >= 0
            ? sameBracket
            : out.audio.findIndex((a) => /^TrueHD(\s|$)/i.test(a));
        if (idx >= 0 && !/atmos/i.test(out.audio[idx])) {
          // Insert BEFORE any channel number so the entry reads "TrueHD Atmos 7.1",
          // the canonical order, not "TrueHD 7.1 Atmos".
          const m = out.audio[idx].match(/^(.*?)\s+(\d\.\d)$/);
          out.audio[idx] = m ? `${m[1]} Atmos ${m[2]}` : `${out.audio[idx]} Atmos`;
        } else if (!out.audio.some((a) => /atmos/i.test(a))) out.audio.push("Atmos");
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
    if (!srcM && !resM && !resWord && !audio && !video) {
      // "HFR" (High Frame Rate) claims 50/60fps rather than the usual 24/25/30.
      // It rides as its own bracket beside "[10bit]" — both are properties of the
      // picture rather than of where it came from. Read from the loose dotted tail
      // as well as from brackets, because ".AAC2.0.HFR.H.264-RAWR" is the shape the
      // UK TV releases use and an unrecognised LOOSE word is dropped outright (only
      // a bracketed unknown is preserved verbatim), so without this the flag simply
      // vanished from the name.
      if (/^hfr$/i.test(at)) {
        if (!misc.includes("HFR")) misc.push("HFR");
        return;
      }
      // HDR flags (DV, HDR10Plus, HDR10, HLG, ...) are recognized from loose
      // dotted words AND brackets. Unknown short bracket tags are preserved
      // verbatim (except "[Unknown]"/"[Group]"/"[NoGrp]", which are dropped).
      // Everything else is dropped — the kernel never guesses at words it
      // doesn't know.
      const flag = hdrFlagOf(at);
      if (flag) {
        if (!out.hdr.includes(flag)) out.hdr.push(flag);
        return;
      }
      if (fromBracket && /^[A-Z][A-Za-z0-9.+-]{0,12}$/.test(at)) {
        // Placeholders ("[Unknown]", "[Group]", "[NoGrp]") say "not stated", so
        // they are dropped outright — neither a tag nor a group. See
        // PLACEHOLDER_WORDS for why the group case is not merely cosmetic.
        if (!isPlaceholderWord(at)) misc.push(at);
      }
    }
  };

  // Only SQUARE brackets carry release tags. Parentheses hold disambiguators —
  // "(Inna historia)", "(2019)" — and reading those as tags emitted junk like
  // "[Inna]" onto otherwise clean names.
  for (const m of base.matchAll(/\[([^\][]+)\]/g)) {
    // A group written INSIDE the bracket, after the tags: "[...H265.AC3-AS76-FT]".
    // The anchored tail rule only ever sees the end of the name, so a bracket
    // followed by more brackets ("[...AS76-FT] [Dubbing PL] [Alusia]") hid the
    // group completely and the rename dropped the release group out of
    // existence. It is the same "-WORD" shape the tail rule accepts, read in the
    // one position that rule was blind to.
    if (!out.group) {
      // The tail rule is `/-(WORD)$/`, but a bracketed group may itself be
      // hyphenated ("H265.AC3-AS76-FT") - there the LAST hyphen is the separator
      // and everything before it is the group, so allow internal hyphens. The
      // class stays strict so a trailing year or a resolution cannot qualify.
      const inner = m[1].match(/-\s*([A-Za-z0-9][A-Za-z0-9-]{1,20})$/);
      const cand = inner ? inner[1].replace(/-+$/, "") : null;
      // "[imdbid-tt13622970]" is not a group: a bare IMDb id is our own id tag,
      // and the widened class above would otherwise read it as one.
      if (cand && /^tt\d{6,9}$/i.test(cand)) continue;
      if (cand && !looksLikeCodec(cand) && !EDITION_SINGLE.has(cand.toLowerCase()) && !isPlaceholderWord(cand) && !isLanguageishWord(cand) && !isEpisodeCodeWord(cand)) {
        out.group = cand;
        // Peel it out of the bracket so the tokenizer does not ALSO read it as
        // an unknown tag, which would print a second [AS76] bracket. The group
        // sits before the closing bracket, so the "]" is kept rather than
        // consumed — dropping it would leave the bracket pass nothing to close.
        const stripped = m[0].replace(/-\s*[A-Za-z0-9][A-Za-z0-9-]{1,20}(\])?$/, "$1");
        base = base.slice(0, m.index) + stripped + base.slice(m.index + m[0].length);
        m[0] = stripped;
        // The tokenizer below reads m[1], the bracket's ORIGINAL content, so
        // fixing m[0] alone left the group in place and it was tokenised as an
        // unknown word — printing "[WEM]" right beside the "-WEM" it had just
        // claimed. A hyphenated group hid this ("AC3-AS76-FT" is consumed as an
        // audio codec), which is why only the spaced form showed it.
        m[1] = m[1].replace(/-\s*[A-Za-z0-9][A-Za-z0-9-]{1,20}\s*$/, "");
      }
    }
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
    audioMark = out.audio.length;
    // Split on whitespace, and on a dot that is NOT between digits, so
    // "[UHD.BluRay]" becomes two recognizable tags while channel numbers
    // ("[AC3 2.0]", "[DD+5.1]") stay in one piece and never get torn apart.
    // A multi-word MISC phrase can straddle the split ("[10Bit SDR UPSCALING]"),
    // so adjacent pieces are re-joined before each is classified - otherwise
    // the whole-bracket lookup above never sees "SDR UPSCALING" as a unit.
    const pieces = m[1].split(/(?<!\d)\.(?!\d)|\s+/);
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].trim()) continue;
      const pair = MISC_PHRASES[`${pieces[i]} ${pieces[i + 1] || ""}`.trim().toLowerCase()];
      if (pair) {
        if (!misc.includes(pair)) misc.push(pair);
        i++;
        continue;
      }
      tryToken(pieces[i], true);
    }
  }

  // A PARENTHESISED run of tags is as real as a bracketed one. Polish releases in
  // particular wrap the whole encode in parens — "Arriving in Paradise (1080p NF
  // Webrip x265 10bit EAC3 2.0 - WEM)" — and neither pass could see it: the
  // bracket pass is squares-only, and the loose tail strips [...] and (...)
  // alike before splitting. So the source, the provider and the video codec were
  // all dropped, and the canonical name kept only what ffprobe measured
  // ("[1080p][EAC3 2.0][HEVC][10bit]", WEB-DL and NF simply gone).
  //
  // Parentheses are still NOT read wholesale, because that is why they were
  // excluded: they also hold disambiguators — "(Inna historia)", "(2019)",
  // "(2011)", "(1)" — which emitted junk like "[Inna]". So a paren is tokenized
  // only when it actually states a release tag, and prose, an edition or a bare
  // year is left alone (editions have their own pass, which does read parens).
  const PAREN_TAG_RE =
    /\b\d{3,4}[pi]\b|blu-?ray|remux|web-?dl|web-?rip|hdtv|bd-?rip|dvd-?rip|\bx26[45]\b|h\.?26[45]|\bhevc\b|\bavc\b|\bav1\b|\bvp9\b|\bxvid\b|\bdivx\b|true-?hd|dts-?hd|\bdts\b|e-?ac3|\beac3\b|\bac3\b|\baac\b|\bflac\b|\batmos\b|10-?bit|8-?bit|\bhdr10?\b|\bdv\b/i;
  for (const m of base.matchAll(/\(([^()]+)\)/g)) {
    if (!PAREN_TAG_RE.test(m[1])) continue;
    // Same shape as the square-bracket pass. A paren can carry the release group
    // the same way a bracket can ("... EAC3 2.0 - WEM)"), and left as an unknown
    // token it printed a stray "[WEM]" beside the name's other stray bracket.
    // The group tail is cut from the content before splitting, rather than peeled
    // out of `base` as the bracket pass does — nothing downstream re-reads the
    // parens, so there is no second pass to keep consistent.
    let content = m[1];
          if (!out.group) {
            // `-\s*` and the language guard, both matching the tail rule above.
            // Rips write "- WEM" as often as "-WEM", and without the space this
            // rule could not read the group at all while the tail rule could —
            // two rules for one job that disagreed about the same name.
            const inner = content.match(/-\s*([A-Za-z0-9][A-Za-z0-9-]{1,20})\s*$/);
            const cand = inner ? inner[1].replace(/-+$/, "") : null;
            if (cand && !looksLikeCodec(cand) && !EDITION_SINGLE.has(cand.toLowerCase()) && !isPlaceholderWord(cand) && !isLanguageishWord(cand) && !isEpisodeCodeWord(cand)) {
              out.group = cand;
              content = content.replace(/-\s*[A-Za-z0-9][A-Za-z0-9-]{1,20}\s*$/, "");
            }
          }
    const phrase = MISC_PHRASES[content.trim().toLowerCase()];
    if (phrase) {
      if (!misc.includes(phrase)) misc.push(phrase);
      continue;
    }
    audioMark = out.audio.length;
    const pieces = content.split(/(?<!\d)\.(?!\d)|\s+/);
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].trim()) continue;
      const pair = MISC_PHRASES[`${pieces[i]} ${pieces[i + 1] || ""}`.trim().toLowerCase()];
      if (pair) {
        if (!misc.includes(pair)) misc.push(pair);
        i++;
        continue;
      }
      tryToken(pieces[i], true);
    }
  }
  // Loose dotted/separated release tail. Re-join known multi-word compounds
  // ("WEB" "DL", "BD" "RIP", "BLU" "RAY") so "1080p.WEB-DL.x265" classifies.
  // A protected placeholder keeps channel numbers ("DD+5.1", "7.1") intact so
  // the split never tears the "5.1" apart from its codec. Only a digit that does
  // NOT follow another digit is protected: "2021.2K" is a year then a 2K class,
  // not a decimal, and fusing them hid the resolution entirely.
  const keepNums = base.replace(/(?<!\d)(\d)\.(\d)/g, "$1\x00$2");
  const looseTokens = keepNums.replace(/[\[({][^\])}]*[\])}]/g, " ").split(/[.\s_]+/).filter((t) => t).map((t) => t.replace(/\x00/g, "."));
  for (let i = 0; i < looseTokens.length; i++) {
    const t = looseTokens[i];
    // The loose tail has NO bracket to scope it, so a dotted tail like
    // "DTS-HD.MA.TrueHD.7.1.Atmos" must not let a bare "Atmos" claim the DTS that
    // happens to sit earlier in the same run. Each loose token is its own group,
    // which sends "Atmos" to the cross-bracket TrueHD fallback — the pairing that
    // is actually correct. Leaving the mark at its previous value made every
    // earlier entry "same bracket" and handed Atmos to DTS.
    audioMark = out.audio.length;
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

  // Order-independent TrueHD fallback. A bare "[Atmos]" can be tokenized BEFORE
  // its carrier — "[Atmos]" is bracketed (so it is read in the bracket pass)
  // while "DTS-HD.MA.TrueHD.7.1" is a loose dotted tail read afterwards. The
  // in-tokenizer rule could not see a TrueHD that had not been seen yet, so
  // "...TrueHD.7.1.[Atmos]" rendered a detached "[Atmos]". Re-run the one legal
  // cross-bracket pairing now that every token has been read. Only TrueHD, and
  // only onto an entry that does not already carry the flag.
  const strayAtmos = out.audio.findIndex((a) => /^atmos$/i.test(a.trim()));
  if (strayAtmos >= 0) {
    const thd = out.audio.findIndex((a) => /^TrueHD(\s|$)/i.test(a));
    if (thd >= 0) {
      const m = out.audio[thd].match(/^(.*?)\s+(\d\.\d)$/);
      out.audio[thd] = m ? `${m[1]} Atmos ${m[2]}` : `${out.audio[thd]} Atmos`;
      out.audio.splice(strayAtmos, 1);
    }
  }

  // Split encode-quality modifiers out of misc before they render: they belong
  // to the resolution group, not in a bracket of their own. Collected AFTER the
  // bracket tokenizer because that is where they currently land (an unrecognized
  // square-bracket word), and matching whole words only - "properly" is not a
  // release tag and must not be truncated into one.
  const qualityMods: string[] = [];
  const keptMisc: string[] = [];
  for (const m of misc) {
    const canon = QUALITY_MODIFIERS.get(m.trim().toLowerCase());
    if (canon) {
      if (!qualityMods.includes(canon)) qualityMods.push(canon);
    } else {
      keptMisc.push(m);
    }
  }

  out.misc = [...editions, ...keptMisc];
  out.qualityMods = qualityMods;
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
  const multi = fileBase.match(/(?<![A-Za-z0-9])[sS](\d{1,2})\s*[eE](\d{1,3})\s*[-‐‑‒–—―]\s*[eE]?(\d{1,3})\b/);
  if (multi) {
    const season = parseInt(multi[1], 10);
    const episode = parseInt(multi[2], 10);
    const episodeEnd = parseInt(multi[3], 10);
    // A span that wide is not a multi-episode pack, it is a stray year or a
    // different number entirely ("S01E01-2019"). Only treat it as a range when
    // the episodes are genuinely close together.
    if (Number.isFinite(season) && Number.isFinite(episode) && Number.isFinite(episodeEnd) && episodeEnd > episode && episodeEnd - episode <= 50) {
      return { season, episode, episodeEnd };
    }
  }
  // "S0XE03" is a season-0 special marker used by Polish scene releases, not a
  // typo — read it as S00E03 so the code and the title after it are both found.
  const s0x = fileBase.match(/(?<![A-Za-z0-9])[sS]0[xX][\s._-]*[eE](\d{1,3})\b/);
  if (s0x) {
    const episode = parseInt(s0x[1], 10);
    if (Number.isFinite(episode)) return { season: 0, episode };
  }
  const m = fileBase.match(/(?<![A-Za-z0-9])[sS](\d{1,2})\s*[eE](\d{1,3})\b/);
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
  /** Set for a multi-episode file ("S01E01-02"). {Episode} then renders the
   *  whole span, so the default template yields "S01E01-02" with no edit. */
  episodeEnd?: number | null;
  episodeTitle?: string | null;
  airDate?: string | null;
  episodeYear?: string | null;
  tags?: string;
  group?: string | null;
  vendor?: string | null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "01", or "01-02" for a multi-episode file. A bare {Episode} therefore spans
 *  the whole range, so "{Title} - S{Season:02}E{Episode:02}" keeps working
 *  untouched for both single and multi-episode files. */
function episodeToken(p: CanonicalFilePieces): string {
  if (p.episode === null || p.episode === undefined) return "";
  const first = pad2(p.episode);
  if (p.episodeEnd === null || p.episodeEnd === undefined || p.episodeEnd <= p.episode) return first;
  return `${first}-${pad2(p.episodeEnd)}`;
}

const fileVars = (p: CanonicalFilePieces, conf: NamingConf): Record<string, string> => ({
  Title: p.title,
  Year: p.year ? String(p.year) : "",
  ImdbId: p.imdbId ? p.imdbId.replace(/^tt/, "") : "",
  TvdbId: p.tvdbId !== null && p.tvdbId !== undefined ? String(p.tvdbId) : "",
  Season: p.season !== null && p.season !== undefined ? String(p.season) : "",
  Episode: episodeToken(p),
  EpisodeTitle: (p.episodeTitle || "").trim(),
  EpisodeEnd: p.episodeEnd ? pad2(p.episodeEnd) : "",
  EpisodeRange: p.episodeEnd ? `S${pad2(p.season as number)}E${pad2(p.episode as number)}-E${pad2(p.episodeEnd)}` : "",
  AirDate: (p.airDate || "").trim(),
  EpisodeYear: (p.episodeYear || "").trim(),
  // S00 specials get their whole "S00E03" marker from one token so it can never
  // half-render (a padded "00" with no episode) when the number is unknown.
  SpecialCode: p.season === 0 && p.episode ? `S${String(0).padStart(2, "0")}E${String(p.episode).padStart(2, "0")}` : "",
  Tags: p.tags || "",
  Group: p.group ? `-${p.group}` : "",
  Vendor: p.vendor ? `-${p.vendor}` : "",
});

/** A vendor belongs at the very end, which is where these rips put it and where
 *  it round-trips. A stored template from before {Vendor} existed still gets it
 *  appended, so enabling the list works without anyone editing a template; a
 *  template that does reference the token renders it itself and is left alone. */
function renderFileTemplate(template: string, vars: Record<string, string>, p: CanonicalFilePieces): string {
  const out = renderNamingTemplate(template, vars);
  if (vars.Vendor && !template.includes("{Vendor}")) {
    // The vendor continues the same zero-space run {Group} uses, so it glues on
    // directly. Only when NEITHER tag nor group rendered is the template's own
    // " - " separator left dangling, and gluing onto that would double the dash.
    const content = `${p.tags || ""}${p.group || ""}`.trim();
    if (content) return `${out}${vars.Vendor}`;
    const trimmed = out.replace(/[\s\-–—:]+$/, "");
    return trimmed ? `${trimmed} ${vars.Vendor}` : vars.Vendor.slice(1);
  }
  return out;
}

/** Movie file / S00 special: "Title (YYYY) [imdbid-tt####] - [tags]-GROUP". */
export function canonicalMovieFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || !p.year || !p.imdbId) return null;
  return sanitizeSegment(renderFileTemplate(conf.movie_file, fileVars(p, conf), p));
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
  return sanitizeSegment(tidyTemplate(renderFileTemplate(conf.special_file, fileVars(p, conf), p)));
}

/** Numbered episode: "Show - S01E01 - Name [tags]-GROUP". Episode title optional. */
export function canonicalEpisodeFile(conf: NamingConf, p: CanonicalFilePieces): string | null {
  if (!p.title || typeof p.season !== "number" || typeof p.episode !== "number") return null;
  const out = renderFileTemplate(conf.episode_file, fileVars(p, conf), p);
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
    // A candidate that IS the source file means an earlier pass already landed
    // here, so returning it is what makes this idempotent. Without the inode
    // test a second Fix Names run over a multi-version folder finds its own "-2"
    // occupied and escalates to "-3", then "-4", one pass at a time — and since
    // the bare name is always held by a DIFFERENT file, nothing else stops it.
    if (srcIno && srcIno > 0) {
      try {
        if (fs.statSync(cand).ino === srcIno) return cand;
      } catch {}
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}