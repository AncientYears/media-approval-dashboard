/**
 * Parse torrent/release names to extract season, episode, and quality info.
 * Handles formats like:
 *   LEGO Ninjago Dragons Rising S02E12 ...
 *   Show Name S02E01E02E03 ...
 *   Show Name S02E01-E12 ...
 *   Show Name Season 2 ...
 *   Show Name S02 ...
 */

export function parseQualityFromName(name: string): string {
  const lower = name.toLowerCase();
  let source = "";
  let resolution = "";

  if (lower.includes("remux")) source = "Remux";
  else if (lower.includes("web-dl") || lower.includes("webdl")) source = "WEBDL";
  else if (lower.includes("webrip") || lower.includes("web-rip")) source = "WEBRip";
  else if (lower.includes("bluray") || lower.includes("bdrip") || lower.includes("blu-ray")) source = "Bluray";
  else if (lower.includes("hdtv") || lower.includes("hdrip") || lower.includes("hd-rip")) source = "HDTV";
  else if (lower.includes("dvdrip") || lower.includes("dvd-rip")) source = "DVD";
  else if (lower.includes("cam") || lower.includes("telesync")) source = "CAM";
  else if (lower.includes("scr") || lower.includes("screener")) source = "SCR";
  else source = "Bluray";

  if (lower.includes("2160p") || lower.includes("4k") || lower.includes("uhd")) resolution = "2160p";
  else if (lower.includes("1080p")) resolution = "1080p";
  else if (lower.includes("720p")) resolution = "720p";
  else if (lower.includes("480p")) resolution = "480p";
  else resolution = "1080p";

  if (source === "Remux") return `Remux-${resolution}`;
  if (source === "CAM" || source === "SCR") return source;
  if (source === "DVD") return "DVD";
  return `${source}-${resolution}`;
}

export interface ParsedTorrent {
  season: number | null;
  episodes: number[];
  episodeRange: string | null;
}

export function parseTorrentName(name: string): ParsedTorrent {
  const result: ParsedTorrent = { season: null, episodes: [], episodeRange: null };
  const upper = name.toUpperCase();

  // Pattern: S02E12E13E14 or S02E12, E13, E14
  const seasonMatch = upper.match(/\bS(\d{1,2})(?:\b|E\d)/);
  if (seasonMatch) {
    result.season = parseInt(seasonMatch[1], 10);
  }

  // Pattern: S02E01E02E03 (multiple episodes)
  const multiEpMatch = upper.match(/\bS\d{1,2}E(\d{1,3})(?:E(\d{1,3}))+/g);
  if (multiEpMatch) {
    const epNums: number[] = [];
    for (const m of multiEpMatch) {
      const nums = m.match(/E(\d{1,3})/g);
      if (nums) {
        for (const n of nums) {
          epNums.push(parseInt(n.slice(1), 10));
        }
      }
    }
    result.episodes = [...new Set(epNums)].sort((a, b) => a - b);
  } else {
    // Pattern: S02E01-E12 (range)
    const rangeMatch = upper.match(/\bS(\d{1,2})E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[2], 10);
      const end = parseInt(rangeMatch[3], 10);
      for (let i = start; i <= end; i++) {
        result.episodes.push(i);
      }
      result.episodeRange = `${rangeMatch[2]}-${rangeMatch[3]}`;
    } else {
      // Pattern: single S02E12
      const singleMatch = upper.match(/\bS\d{1,2}E(\d{1,3})\b/);
      if (singleMatch) {
        result.episodes.push(parseInt(singleMatch[1], 10));
      }
    }
  }

  // Pattern: "Season 2" without S##E##
  if (result.season === null) {
    const seasonWord = upper.match(/\bSEASON\s+(\d{1,2})\b/);
    if (seasonWord) {
      result.season = parseInt(seasonWord[1], 10);
    }
  }

  return result;
}

/**
 * Get a display string for parsed episodes.
 * e.g. "S02E12", "S02E01-E12", "S02E01E02E03"
 */
export function formatEpisodes(parsed: ParsedTorrent): string | null {
  if (parsed.season === null) return null;
  const s = `S${String(parsed.season).padStart(2, "0")}`;

  if (parsed.episodes.length === 0) return s;
  if (parsed.episodes.length === 1) return `${s}E${String(parsed.episodes[0]).padStart(2, "0")}`;

  // Check if it's a contiguous range
  if (parsed.episodeRange) {
    return `${s}E${parsed.episodeRange}`;
  }

  // Check if contiguous
  const sorted = [...parsed.episodes].sort((a, b) => a - b);
  const isContiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  if (isContiguous && sorted.length > 1) {
    return `${s}E${String(sorted[0]).padStart(2, "0")}-E${String(sorted[sorted.length - 1]).padStart(2, "0")}`;
  }

  return `${s}${sorted.map((e) => `E${String(e).padStart(2, "0")}`).join("")}`;
}

/**
 * Get a display string for the season card pill.
 * e.g. "S02 | 5/12 EP" or "S02 | 1 EP"
 */
export function formatSeasonPill(season: number, episodeCount: number | null, coveredEpisodes: number[]): string {
  const s = `S${String(season).padStart(2, "0")}`;
  if (episodeCount && episodeCount > 0) {
    return `${s} | ${coveredEpisodes.length}/${episodeCount} EP`;
  }
  if (coveredEpisodes.length > 0) {
    return `${s} | ${coveredEpisodes.length} EP`;
  }
  return `${s} | pending`;
}
