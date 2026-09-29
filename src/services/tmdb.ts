import axios from "axios";
import type { Database } from "better-sqlite3";

const BASE = "https://api.themoviedb.org/3";

export interface EpisodeMeta {
  episode_number: number;
  name: string;
  air_date: string | null;
}

export interface SeasonMeta {
  tmdb_show_id: number;
  show_name: string;
  resolvedVia: string;
  episodes: EpisodeMeta[];
}

function apiKey(): string {
  return process.env.TMDB_API_KEY || "";
}

function lang(): string {
  return process.env.TMDB_LANGUAGE || "en-US";
}

function extractExternalId(libraryKey: string): { source: "tvdb_id" | "imdb_id"; id: string } | null {
  const parts = libraryKey.split(":");
  const ident = parts[1] ?? "";
  if (/^\d+$/.test(ident)) return { source: "tvdb_id", id: ident };
  if (/^tt\d+$/i.test(ident)) return { source: "imdb_id", id: ident };
  return null;
}

function libraryKeyYear(libraryKey: string): number | null {
  const y = parseInt(libraryKey.split(":")[2] ?? "", 10);
  return Number.isFinite(y) ? y : null;
}

async function tmdbGet<T>(path: string): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await axios.get<T>(`${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${key}`);
    return res.data;
  } catch (err: any) {
    console.error(`[TMDB] request failed ${path}: ${err.stack || err.message}`);
    return null;
  }
}

/** Resolve a library_key (+ fallback title) to a TMDB show id. */
async function resolveShowId(libraryKey: string, title: string): Promise<{ id: number; via: string } | null> {
  const ext = extractExternalId(libraryKey);
  if (ext) {
    const data = await tmdbGet<any>(`/find/${encodeURIComponent(ext.id)}?external_source=${ext.source}&language=${lang()}`);
    const hit = data?.tv_results?.[0];
    if (hit?.id) return { id: hit.id, via: ext.source };
  }
  const year = libraryKeyYear(libraryKey);
  const query = `/search/tv?query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ""}&language=${lang()}`;
  const data = await tmdbGet<any>(query);
  const hit = data?.results?.[0];
  if (hit?.id) return { id: hit.id, via: "search" };
  return null;
}

/**
 * Fetch a season's episode list from TMDB, cached in tmdb_season_cache so the
 * app works offline after the first successful lookup. Returns null when no
 * API key, nothing cached, and the network can't be reached.
 */
export async function fetchTMDBSeason(
  db: Database,
  libraryKey: string,
  season: number,
  title: string,
  force = false,
): Promise<SeasonMeta | null> {
  const cacheRow = db
    .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ?")
    .get(libraryKey, season) as any;
  if (cacheRow && !force) {
    try {
      return JSON.parse(cacheRow.payload) as SeasonMeta;
    } catch {}
  }

  const key = apiKey();
  if (!key) return null;
  const show = await resolveShowId(libraryKey, title);
  if (!show) {
    if (!cacheRow) console.warn(`[TMDB] no show match for ${libraryKey} "${title}"`);
    return null;
  }
  const data = await tmdbGet<any>(`/tv/${show.id}/season/${season}?language=${lang()}`);
  if (!data?.episodes) return null;

  const meta: SeasonMeta = {
    tmdb_show_id: show.id,
    show_name: typeof data.name === "string" ? data.name : title,
    resolvedVia: show.via,
    episodes: data.episodes.map((e: any) => ({
      episode_number: e.episode_number,
      name: typeof e.name === "string" ? e.name : "",
      air_date: e.air_date ? String(e.air_date) : null,
    })),
  };
  db.prepare("INSERT OR REPLACE INTO tmdb_season_cache (library_key, season, tmdb_show_id, show_name, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    libraryKey,
    season,
    show.id,
    meta.show_name,
    JSON.stringify(meta),
    new Date().toISOString(),
  );
  return meta;
}