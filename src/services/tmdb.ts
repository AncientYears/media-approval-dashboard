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
  language: string;
  episodes: EpisodeMeta[];
}

function apiKey(): string {
  return process.env.TMDB_API_KEY || "";
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
async function resolveShowId(libraryKey: string, title: string, language: string): Promise<{ id: number; via: string } | null> {
  const ext = extractExternalId(libraryKey);
  if (ext) {
    const data = await tmdbGet<any>(`/find/${encodeURIComponent(ext.id)}?external_source=${ext.source}&language=${language}`);
    const hit = data?.tv_results?.[0];
    if (hit?.id) return { id: hit.id, via: ext.source };
  }
  const year = libraryKeyYear(libraryKey);
  const query = `/search/tv?query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ""}&language=${language}`;
  const data = await tmdbGet<any>(query);
  const hit = data?.results?.[0];
  if (hit?.id) return { id: hit.id, via: "search" };
  // A slug's year is best-effort — retry yearless before giving up so a show
  // stored under a wrong/zero year still resolves (pills + episode names).
  if (year) {
    const retry = await tmdbGet<any>(`/search/tv?query=${encodeURIComponent(title)}&language=${language}`);
    const retryHit = retry?.results?.[0];
    if (retryHit?.id) return { id: retryHit.id, via: "search" };
  }
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
  opts: { language?: string | null; force?: boolean } = {},
): Promise<SeasonMeta | null> {
  const language = opts.language || process.env.TMDB_LANGUAGE || "en-US";
  const force = !!opts.force;
  const cacheRow = db
    .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ?")
    .get(libraryKey, season) as any;
  let cached: SeasonMeta | null = null;
  if (cacheRow && !force) {
    try {
      cached = JSON.parse(cacheRow.payload) as SeasonMeta;
    } catch {}
  }
  if (cached && cached.language === language) return cached;

  const key = apiKey();
  if (!key) return cached;
  const show = await resolveShowId(libraryKey, title, language);
  if (!show) {
    if (!cacheRow) console.warn(`[TMDB] no show match for ${libraryKey} "${title}"`);
    return cached;
  }
  const data = await tmdbGet<any>(`/tv/${show.id}/season/${season}?language=${language}`);
  if (!data?.episodes) return cached;

  // Where the requested language has no translation, TMDB leaves the original
  // name — except some episodes bottom out as "Episode N" placeholders. Overlay
  // the en-US names so we never show a placeholder when a real English title
  // exists (e.g. Polish shows with partially-translated specials).
  let fallbackNames: Map<number, string> | null = null;
  if (language !== "en-US") {
    const en = await tmdbGet<any>(`/tv/${show.id}/season/${season}?language=en-US`);
    if (en?.episodes) {
      fallbackNames = new Map(
        en.episodes
          .filter((e: any) => typeof e.name === "string" && e.name.trim())
          .map((e: any) => [e.episode_number, e.name]),
      );
    }
  }
  const isPlaceholder = (name: string) => /^(Episode|Odcinek|Folge|Épisode|Episodio|Episódio)\s+\d+$/i.test(name.trim());

  const meta: SeasonMeta = {
    tmdb_show_id: show.id,
    show_name: typeof data.name === "string" ? data.name : title,
    resolvedVia: show.via,
    language,
    episodes: data.episodes.map((e: any) => {
      const preferred = typeof e.name === "string" ? e.name.trim() : "";
      let name = preferred;
      if ((!name || isPlaceholder(name)) && fallbackNames) {
        const fb = fallbackNames.get(e.episode_number);
        if (fb && fb !== name) name = fb;
      }
      return {
        episode_number: e.episode_number,
        name,
        air_date: e.air_date ? String(e.air_date) : null,
      };
    }),
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