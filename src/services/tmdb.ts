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
/** Best-effort own identity for an S00 special. TMDB files most series specials
 *  as standalone movies rather than under the show's seasons, so the show's
 *  IMDb id can never be reused for them. Searches the on-disk title as a movie
 *  and returns null when nothing convincing matches — the caller then keeps the
 *  on-disk title instead of guessing. */
export async function resolveSpecialIdentity(title: string, language?: string): Promise<{ tmdbId: number; imdbId: string | null; title: string; year: number | null } | null> {
  const q = title.replace(/[[({][^\])}]*[\])}]/g, " ").replace(/\s+/g, " ").trim();
  if (!q || q.length < 3) return null;
  let hits: Array<{ id: number; title: string; year: number | null }> = [];
  const locale = language && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ? language : null;
  // A scene release names the special in its own language ("Fretka kontra
  // Wszecświat"), which shares no words with the English TMDB title, so search
  // the release locale first (its hit carries the localized title), then the
  // default locale as a backstop.
  for (const lang of locale ? [locale, undefined] : [undefined]) {
    try {
      for (const hit of await searchTMDB(q, "movie", lang)) {
        if (!hits.some((h) => h.id === hit.id)) hits.push(hit);
      }
    } catch {}
  }
  if (!hits.length) return null;
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3),
    );
  const want = words(q);
  if (!want.size) return null;
  const matches = (hit: { title: string }) => {
    // Require real word overlap, else a loose search returns an unrelated film.
    const got = words(hit.title);
    let overlap = 0;
    for (const w of want) if (got.has(w)) overlap++;
    return overlap > 0 && overlap / want.size >= 0.5;
  };
  const accept = async (hit: { id: number; title: string; year: number | null }) => {
    let imdbId: string | null = null;
    try {
      imdbId = (await fetchExternalIds("movie", hit.id))?.imdbId || null;
    } catch {}
    return { tmdbId: hit.id, imdbId, title: hit.title, year: hit.year };
  };
  for (const hit of hits) {
    if (matches(hit)) return accept(hit);
  }
  // No shared words: TMDB matched the translated query but returned the title in
  // another locale ("Fretka kontra Wszechświat" → the film titled "Candace
  // Against the Universe"). When a specific multi-word query produces exactly
  // one film, trust TMDB's ranking. A looser query ("Original Pitch") returns
  // several and is still rejected, so it falls through to the series' S00 list.
  if (hits.length === 1 && want.size >= 2) return accept(hits[0]);
  return null;
}

export async function searchTMDB(
  query: string,
  mediaType: "movie" | "series",
  language?: string,
): Promise<Array<{ id: number; title: string; year: number | null; overview: string; poster: string | null }>> {
  const key = apiKey();
  if (!key) return [];
  const q = query.replace(/[\[(]\d{4}[\])]/g, "").trim() || query;
  const path = mediaType === "movie" ? "/search/movie" : "/search/tv";
  const data = await tmdbGet<any>(`${path}?query=${encodeURIComponent(q)}&page=1&language=${language || process.env.TMDB_LANGUAGE || "en-US"}`);
  if (!data?.results?.length) return [];
  return data.results.slice(0, 10).map((r: any) => {
    const date = r.release_date || r.first_air_date || "";
    const year = date ? parseInt(String(date).slice(0, 4), 10) : null;
    return {
      id: r.id,
      title: r.title || r.name || "",
      year: Number.isFinite(year) ? year : null,
      overview: (r.overview || "").slice(0, 200),
      poster: r.poster_path || null,
    };
  });
}

/** Resolve title + year for a TMDB id (movie or series) — used by the Seerr
 * webhook so its requests share the Discover library_key identity. Returns
 * null when the API key is unset or the lookup fails. */
export async function fetchTMDBById(
  mediaType: "movie" | "series",
  tmdbId: number,
  language?: string,
): Promise<{ id: number; title: string; year: number | null } | null> {
  const path = mediaType === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const data = await tmdbGet<any>(`${path}?language=${language || process.env.TMDB_LANGUAGE || "en-US"}`);
  if (!data?.id) return null;
  const date = data.release_date || data.first_air_date || "";
  const year = date ? parseInt(String(date).slice(0, 4), 10) : null;
  return {
    id: data.id,
    title: String(data.title || data.name || "").trim(),
    year: Number.isFinite(year) ? year : null,
  };
}

/** Season list for a TMDB series, used by the Discover season selector. */
export async function fetchTMDBTVSeasons(
  tmdbId: number,
  language?: string,
): Promise<Array<{ season_number: number; name: string; episode_count: number }>> {
  const data = await tmdbGet<any>(`/tv/${tmdbId}?language=${language || process.env.TMDB_LANGUAGE || "en-US"}`);
  if (!data?.seasons?.length) return [];
  return data.seasons
    .filter((s: any) => typeof s.season_number === "number" && s.season_number >= 0)
    .map((s: any) => ({
      season_number: s.season_number,
      name: s.name || `Season ${s.season_number}`,
      episode_count: s.episode_count || 0,
    }));
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
  // The cache is keyed by language too, so a Polish fetch never clobbers the
  // English one (they used to share a row and flip-flop on every refresh).
  const cacheRow = db
    .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ? AND language = ?")
    .get(libraryKey, season, language) as any;
  let cached: SeasonMeta | null = null;
  if (cacheRow) {
    try {
      cached = JSON.parse(cacheRow.payload) as SeasonMeta;
    } catch {}
  }
  if (cached && !force) return cached;

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
  db.prepare("INSERT OR REPLACE INTO tmdb_season_cache (library_key, season, language, tmdb_show_id, show_name, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    libraryKey,
    season,
    language,
    show.id,
    meta.show_name,
    JSON.stringify(meta),
    new Date().toISOString(),
  );
  return meta;
}

/**
 * Resolve an UNNUMBERED special to a number in the show's own S00 list.
 *
 * Most providers do NOT file a Christmas special in season 0 — they number it
 * `E0` of the season it leads into. IMDb's `S12.E0` is "Christmas Special 2022"
 * (aired 25 Dec 2022), and scene releases follow that convention exactly:
 * `...S12E00.Christmas.Special.2022...`. TMDB excludes it from the season's own
 * episode count too — which is why a season that imported 9 files reads 8/8
 * once the special moves to S00 — but it does list these under season 0, with
 * an air date. That air date is the only evidence that says WHICH special a
 * file is, so an unnumbered file is matched against it instead of being left as
 * a slot marker with no number at all.
 *
 * Two independent ways in, tried in order of how directly the release states
 * them:
 *  - a year the release spells out ("Christmas Special 2022" -> the 2022 entry);
 *  - the season the file leads into ("S11E00" -> the one entry airing after S10
 *    finished and before S11 began). The direction matters: these specials air in
 *    the Christmas gap at the END of the previous season's run, so a file marked
 *    `S12E00` is bounded by seasons 11 and 12, NOT 12 and 13.
 * Either must yield exactly ONE entry. Zero or several returns null, so the
 * caller keeps the on-disk title rather than committing to a guess — a wrong
 * number is worse than no number, since it would then claim an identity the file
 * does not have.
 */
export async function findSpecialByAirDate(
  db: Database,
  libraryKey: string,
  showTitle: string,
  opts: { year?: number | null; beforeSeason?: number | null; lang?: string | null } = {},
): Promise<EpisodeMeta | null> {
  const language = opts.lang ?? null;
  const dated = (eps: EpisodeMeta[]) => eps.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.air_date || ""));
  const specials = dated((await fetchTMDBSeason(db, libraryKey, 0, showTitle, { language }))?.episodes ?? []);
  if (!specials.length) return null;

  const year = opts.year;
  if (year && Number.isFinite(year)) {
    const hits = specials.filter((e) => (e.air_date as string).slice(0, 4) === String(year));
    if (hits.length === 1) return hits[0];
  }

  const before = opts.beforeSeason;
  if (before != null && Number.isFinite(before)) {
    const [prior, own] = await Promise.all([
      fetchTMDBSeason(db, libraryKey, before - 1, showTitle, { language }),
      fetchTMDBSeason(db, libraryKey, before, showTitle, { language }),
    ]);
    const priorEnd = dated(prior?.episodes ?? []).map((e) => e.air_date as string).sort().pop();
    const ownStart = dated(own?.episodes ?? []).map((e) => e.air_date as string).sort()[0];
    // Both bounds are required. Without them the window is half-open, and every
    // special on the far side of the missing season would qualify — several hits,
    // which is a refusal anyway, but only by accident of the data.
    if (priorEnd && ownStart && priorEnd < ownStart) {
      const inWindow = specials.filter((e) => {
        const d = e.air_date as string;
        return d > priorEnd && d < ownStart;
      });
      if (inWindow.length === 1) return inWindow[0];
    }
  }
  return null;
}

/** Movie mirror of `resolveShowIdentity` — same ID/year-less-retry behaviour,
 * but against /search/movie (movies carry no seasons, so the series resolver
 * does not apply). Uses the library_key's embedded imdb id when present. */
export async function resolveMovieIdentity(libraryKey: string, title: string, language: string): Promise<ResolvedShow | null> {
  const ext = extractExternalId(libraryKey);
  if (ext) {
    const data = await tmdbGet<any>(`/find/${encodeURIComponent(ext.id)}?external_source=${ext.source}&language=${language}`);
    const hit = data?.movie_results?.[0];
    if (hit?.id) {
      const yr = hit.release_date ? parseInt(String(hit.release_date).slice(0, 4), 10) : null;
      return { id: hit.id, name: hit.title || title, year: Number.isFinite(yr) ? yr : null, via: ext.source };
    }
  }
  const year = libraryKeyYear(libraryKey);
  const q = title.replace(/[\[(]\d{4}[\])]/g, "").trim() || title;
  const query = `/search/movie?query=${encodeURIComponent(q)}${year ? `&year=${year}` : ""}&language=${language}`;
  const data = await tmdbGet<any>(query);
  const hit = data?.results?.[0];
  if (hit?.id) {
    const yr = hit.release_date ? parseInt(String(hit.release_date).slice(0, 4), 10) : null;
    return { id: hit.id, name: hit.title || title, year: Number.isFinite(yr) ? yr : null, via: "search" };
  }
  if (year) {
    const retry = await tmdbGet<any>(`/search/movie?query=${encodeURIComponent(q)}&language=${language}`);
    const retryHit = retry?.results?.[0];
    if (retryHit?.id) {
      const yr = retryHit.release_date ? parseInt(String(retryHit.release_date).slice(0, 4), 10) : null;
      return { id: retryHit.id, name: retryHit.title || title, year: Number.isFinite(yr) ? yr : null, via: "search" };
    }
  }
  return null;
}

/** TMDB /external_ids for a title: the tvdbid (series dirs) / imdbid (movie +
 * series special files, movie dirs) the canonical names embed. */
export async function fetchExternalIds(
  mediaType: "movie" | "series",
  tmdbId: number,
  language?: string,
): Promise<{ imdbId: string | null; tvdbId: string | null } | null> {
  // TMDB's path segment for series is "tv", not our internal "series" — asking
  // for /series/{id}/external_ids 404s, which is why series identity could never
  // resolve through TMDB and always fell back to parsing an on-disk folder.
  const segment = mediaType === "series" ? "tv" : "movie";
  const data = await tmdbGet<any>(`/${segment}/${tmdbId}/external_ids?language=${language || process.env.TMDB_LANGUAGE || "en-US"}`);
  if (!data) return null;
  return {
    imdbId: data.imdb_id ? String(data.imdb_id) : null,
    tvdbId: data.tvdb_id ? String(data.tvdb_id) : null,
  };
}

export interface ExternalIds {
  tmdbId: number;
  imdbId: string | null;
  tvdbId: string | null;
  title: string;
  year: number | null;
}

/**
 * Resolve a request's TMDB identity + external ids for canonical naming,
 * cached in `tmdb_external_ids`. Returns null when TMDB is unset, nothing can
 * be resolved, or the title simply has no ids — callers then fall back to the
 * raw basename (never rename blind). A cached all-null row is treated as a
 * negative cache so unresolved titles do not hammer TMDB on every move.
 */
/** Why a naming identity lookup came back empty — one short, actionable
 * sentence for the Fix Names row note (never an internal step dump). */
export interface NamingDiag {
  reason?: string;
}

export async function resolveExternalIds(
  db: Database,
  libraryKey: string,
  mediaType: "movie" | "series",
  title: string,
  language: string,
  opts?: { ignoreCache?: boolean; diag?: NamingDiag },
): Promise<ExternalIds | null> {
  const fail = (reason: string): null => {
    opts?.diag && (opts.diag.reason = reason);
    return null;
  };
  if (!apiKey()) return fail("TMDB is not configured (TMDB_API_KEY unset)");
  try {
    const cached = db.prepare("SELECT * FROM tmdb_external_ids WHERE library_key = ?").get(libraryKey) as any;
    if (cached && !(opts?.ignoreCache && !cached.imdb_id && !cached.tvdb_id)) {
      if (!cached.imdb_id && !cached.tvdb_id) return fail("TMDB has no IMDb/TVDB id for this title");
      return {
        tmdbId: cached.tmdb_id || 0,
        imdbId: cached.imdb_id || null,
        tvdbId: cached.tvdb_id ? String(cached.tvdb_id) : null,
        title: cached.title || title,
        year: cached.year ?? null,
      };
    }
  } catch {}
  // Deterministic identity first: if this key's seasons were already fetched,
  // reuse that show id instead of searching by title. A mangled stored title
  // ("Ninjago: Dragon Rising") can otherwise miss, or worse, match a different
  // show in the same franchise.
  if (mediaType === "series") {
    const knownId = cachedShowIdForKey(db, libraryKey);
    if (knownId) {
      const ext = await fetchExternalIds("series", knownId, language);
      const show = await tmdbGet<any>(`/tv/${knownId}?language=${language}`);
      if (ext) {
        const yr = show?.first_air_date ? parseInt(String(show.first_air_date).slice(0, 4), 10) : null;
        const out: ExternalIds = {
          tmdbId: knownId,
          imdbId: ext.imdbId,
          tvdbId: ext.tvdbId,
          title: (show?.name as string) || title,
          year: Number.isFinite(yr) ? yr : null,
        };
        if (!out.imdbId && !out.tvdbId) return fail("TMDB has no IMDb/TVDB id for this show");
        try {
          db.prepare(
            "INSERT OR REPLACE INTO tmdb_external_ids (library_key, media_type, tmdb_id, imdb_id, tvdb_id, title, year, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
          ).run(libraryKey, mediaType, out.tmdbId, out.imdbId, out.tvdbId, out.title, out.year ?? null);
        } catch {}
        return out;
      }
      return fail("TMDB request failed while reading this show's ids");
    }
  }
  const show =
    mediaType === "series"
      ? await resolveShowIdentity(libraryKey, title, language)
      : await resolveMovieIdentity(libraryKey, title, language);
  if (!show?.id) return fail(`no TMDB match for "${title}"`);
  const ext = await fetchExternalIds(mediaType, show.id, language);
  if (!ext) return fail("TMDB request failed while reading this title's ids");
  const out: ExternalIds = {
    tmdbId: show.id,
    imdbId: ext.imdbId,
    tvdbId: ext.tvdbId,
    title: show.name || title,
    year: show.year,
  };
  // Persist even when no ids exist — an all-null row acts as a negative cache so
  // an unresolvable title does not hammer TMDB on every subsequent move.
  try {
    db.prepare(
      "INSERT OR REPLACE INTO tmdb_external_ids (library_key, media_type, tmdb_id, imdb_id, tvdb_id, title, year, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(libraryKey, mediaType, out.tmdbId, out.imdbId, out.tvdbId, out.title, out.year ?? null);
  } catch {}
  if (!out.imdbId && !out.tvdbId) return fail("TMDB has no IMDb/TVDB id for this title");
  return out;
}

/** Read-only lookup of a numbered episode's name from tmdb_season_cache — used
 * to fill {EpisodeTitle} on the write path without hitting the network. The
 * cache is per-language, so a caller with a franchise preference must pass it
 * (or the row is looked up in the default language). */
/** Per-episode air date (YYYY-MM-DD) from the cached season payload, or null.
 *  A show's folder year is its *first* season's year, so seasons that air years
 *  later (S04 in 2026 for a 2023 show) can only be dated per episode. */
export function episodeAirDateFromCache(
  db: Database,
  libraryKey: string,
  season: number,
  episode: number,
  language?: string | null,
): string | null {
  const lang = language || process.env.TMDB_LANGUAGE || "en-US";
  try {
    const row = db
      .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ? AND language = ?")
      .get(libraryKey, season, lang) as any;
    if (!row) return null;
    const meta = JSON.parse(row.payload) as SeasonMeta;
    const raw = meta.episodes?.find((e) => e.episode_number === episode)?.air_date;
    return raw ? String(raw).trim() : null;
  } catch {
    return null;
  }
}

/** An episode named for its SLOT rather than its content ("Episode 1"). This is
 *  what a provider ships when an episode has no real name, and for some seasons
 *  it genuinely IS the title — Death in Paradise S14/S15 are "Episode 1".."8" on
 *  Disney+ and on TMDB. So it is real evidence, not junk, and naming accepts it
 *  as a last resort (see `episodeTitleFor`). Callers that COMPARE two titles
 *  must not, or every placeholder would read as the same episode. */
const SLOT_TITLE = /^(Episode|Odcinek|Folge|Épisode|Episodio|Episódio)\s+\d+$/i;

export function episodeTitleFromCache(
  db: Database,
  libraryKey: string,
  season: number,
  episode: number,
  language?: string | null,
  opts?: { allowPlaceholder?: boolean },
): string | null {
  const lang = language || process.env.TMDB_LANGUAGE || "en-US";
  try {
    const row = db
      .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ? AND language = ?")
      .get(libraryKey, season, lang) as any;
    if (!row) return null;
    const meta = JSON.parse(row.payload) as SeasonMeta;
    const ep = meta.episodes?.find((e) => e.episode_number === episode);
    const name = ep?.name?.trim();
    if (!name) return null;
    if (SLOT_TITLE.test(name) && !opts?.allowPlaceholder) return null;
    return name;
  } catch {
    return null;
  }
}

/** The TMDB show id already resolved for a library_key, if any season of it has
 * been cached. Used as a deterministic identity source for naming: the episode
 * titles on screen come from this show, so the canonical dir should too — no
 * title search (and no risk of matching the wrong Ninjago). */
export function cachedShowIdForKey(db: Database, libraryKey: string): number | null {
  try {
    const row = db
      .prepare("SELECT tmdb_show_id FROM tmdb_season_cache WHERE library_key = ? AND tmdb_show_id IS NOT NULL ORDER BY fetched_at DESC LIMIT 1")
      .get(libraryKey) as any;
    return row?.tmdb_show_id ?? null;
  } catch {
    return null;
  }
}