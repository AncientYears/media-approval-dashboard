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

export interface ResolvedShow {
  id: number;
  name: string;
  year: number | null;
  via: string;
}

/** Resolve a library_key (+ fallback title) to a TMDB show id + year. */
export async function resolveShowIdentity(libraryKey: string, title: string, language: string): Promise<ResolvedShow | null> {
  const ext = extractExternalId(libraryKey);
  if (ext) {
    const data = await tmdbGet<any>(`/find/${encodeURIComponent(ext.id)}?external_source=${ext.source}&language=${language}`);
    const hit = data?.tv_results?.[0];
    if (hit?.id) {
      const yr = hit.first_air_date ? parseInt(String(hit.first_air_date).slice(0, 4), 10) : null;
      return { id: hit.id, name: hit.name || title, year: Number.isFinite(yr) ? yr : null, via: ext.source };
    }
  }
  const year = libraryKeyYear(libraryKey);
  const q = title.replace(/[\[(]\d{4}[\])]/g, "").trim() || title;
  const query = `/search/tv?query=${encodeURIComponent(q)}${year ? `&first_air_date_year=${year}` : ""}&language=${language}`;
  const data = await tmdbGet<any>(query);
  const hit = data?.results?.[0];
  if (hit?.id) {
    const yr = hit.first_air_date ? parseInt(String(hit.first_air_date).slice(0, 4), 10) : null;
    return { id: hit.id, name: hit.name || title, year: Number.isFinite(yr) ? yr : null, via: "search" };
  }
  // A slug's year is best-effort — retry yearless before giving up so a show
  // stored under a wrong/zero year still resolves (pills + episode names).
  if (year) {
    const retry = await tmdbGet<any>(`/search/tv?query=${encodeURIComponent(q)}&language=${language}`);
    const retryHit = retry?.results?.[0];
    if (retryHit?.id) {
      const yr = retryHit.first_air_date ? parseInt(String(retryHit.first_air_date).slice(0, 4), 10) : null;
      return { id: retryHit.id, name: retryHit.name || title, year: Number.isFinite(yr) ? yr : null, via: "search" };
    }
  }
  return null;
}

/** Back-compat: resolve to just the show id. */
export async function resolveShowId(libraryKey: string, title: string, language: string): Promise<{ id: number; via: string } | null> {
  const s = await resolveShowIdentity(libraryKey, title, language);
  return s ? { id: s.id, via: s.via } : null;
}

/**
 * Keyword search against TMDB, used to pre-fill `unmatched_torrents` candidates
 * when Radarr/Sonarr are unavailable (arr-less request creation). Returns
 * candidate-like objects the unmatched panel can offer the user.
 */
export async function searchTMDB(
  query: string,
  mediaType: "movie" | "series",
): Promise<Array<{ id: number; title: string; year: number | null; overview: string }>> {
  const key = apiKey();
  if (!key) return [];
  const q = query.replace(/[\[(]\d{4}[\])]/g, "").trim() || query;
  const path = mediaType === "movie" ? "/search/movie" : "/search/tv";
  const data = await tmdbGet<any>(`${path}?query=${encodeURIComponent(q)}&page=1&language=${process.env.TMDB_LANGUAGE || "en-US"}`);
  if (!data?.results?.length) return [];
  return data.results.slice(0, 10).map((r: any) => {
    const date = r.release_date || r.first_air_date || "";
    const year = date ? parseInt(String(date).slice(0, 4), 10) : null;
    return {
      id: r.id,
      title: r.title || r.name || "",
      year: Number.isFinite(year) ? year : null,
      overview: (r.overview || "").slice(0, 200),
    };
  });
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
  opts: { language?: string | null; force?: boolean; altTitle?: string | null } = {},
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
  let show = await resolveShowId(libraryKey, title, language);
  // Locally-mangled row titles ("Ninjago: Dragon Rising") fail TMDB search
  // while the on-disk processed folder holds the real name ("LEGO Ninjago:
  // Dragons Rising") — retry with that alt title before giving up.
  if (!show && opts.altTitle && opts.altTitle.trim() && opts.altTitle !== title) {
    show = await resolveShowId(libraryKey, opts.altTitle.trim(), language);
  }
  if (!show) {
    if (!cacheRow) console.warn(`[TMDB] no show match for ${libraryKey} "${title}"${opts.altTitle ? ` (alt: "${opts.altTitle}")` : ""}`);
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