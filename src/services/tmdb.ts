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
  /** The episode ORDER this row was fetched under — a TMDB episode-group id,
   *  or null for the default aired order. A payload carrying another order
   *  answers a different question (its numbers belong to that order), so it
   *  is never served as a cache hit for the pref in force now. */
  episode_group_id?: string | null;
  /** Whether a row fetched while an order was in force has been RECONCILED
   *  against it — the aired-endpoint fallback drops episodes the order filed
   *  in a numbered season (see fetchTMDBSeason). Both fetch paths mark the
   *  row they write: the group path marks immediately (the group IS the
   *  order), the fallback marks only when the group detail was readable. An
   *  unmarked order row is a cache MISS on the next read and is dropped at
   *  boot, because the SQL-direct readers (pill denominators, season
   *  injections) never call fetchTMDBSeason and would keep serving the
   *  phantom unreconciled list. */
  order_pruned?: boolean;
  episodes: EpisodeMeta[];
}

/** A franchise's selected episode ORDER (a TMDB episode group) and the show it
 *  was picked from. Both must be present to be usable — a group id without its
 *  show can't be checked against the show the key resolves to now. */
export interface EpisodeOrderPref {
  id: string;
  show_id: number | null;
}

export interface EpisodeGroupInfo {
  id: string;
  name: string;
  type: number;
  description: string;
  group_count: number;
  episode_count: number;
}

function apiKey(): string {
  return process.env.TMDB_API_KEY || "";
}

/** True when a TMDB lookup can actually run. Lets a caller tell "this show has
 *  no such season" (a normal answer — plenty of shows have no S00) apart from
 *  "TMDB was never configured", which is the only real failure. */
export function isTmdbConfigured(): boolean {
  return !!apiKey();
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
    // 404 is an ANSWER, not a fault: a season the show does not have (S00 for
    // most series) comes back as one, and dumping the stack for it read like a
    // crash in the logs when the caller simply proceeds with no metadata.
    if (err?.response?.status === 404) console.warn(`[TMDB] no such resource ${path}`);
    else console.error(`[TMDB] request failed ${path}: ${err.stack || err.message}`);
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
 * A franchise's episode ORDER preference — a TMDB episode-group id (production
 * order, Disney+, Netflix …) plus the show it was picked from, or null when
 * the default aired order is in force. The show id travels with the group id
 * because a group belongs to exactly one show: if the key is later re-attached
 * to a different one, the pair no longer describes anything real and must not
 * be applied (the caller validates it against the resolved show).
 */
export function franchiseEpisodeOrder(db: Database, libraryKey: string): EpisodeOrderPref | null {
  try {
    const row = db
      .prepare("SELECT episode_group_id, episode_group_show_id FROM tmdb_franchise_prefs WHERE library_key = ?")
      .get(libraryKey) as any;
    if (!row?.episode_group_id) return null;
    return { id: String(row.episode_group_id), show_id: row.episode_group_show_id ?? null };
  } catch {
    return null;
  }
}

/** The episode GROUPS (alternative episode orders) a show has on TMDB.
 *  Returns `{ show_id: null, groups: [] }` when TMDB is unconfigured or the
 *  show can't be resolved — both are answers, not failures. */
export async function fetchEpisodeGroups(
  db: Database,
  libraryKey: string,
  title: string,
  language?: string | null,
): Promise<{ show_id: number | null; groups: EpisodeGroupInfo[] }> {
  const lang = language || process.env.TMDB_LANGUAGE || "en-US";
  if (!apiKey()) return { show_id: null, groups: [] };
  // The season cache already knows which show this key resolved to — reuse it
  // instead of searching, so a mangled title can't mint a second identity here.
  let showId = cachedShowIdForKey(db, libraryKey);
  if (!showId) {
    const show = await resolveShowIdentity(libraryKey, title, lang);
    showId = show?.id ?? null;
  }
  if (!showId) return { show_id: null, groups: [] };
  const data = await tmdbGet<any>(`/tv/${showId}/episode_groups?language=${lang}`);
  const groups: EpisodeGroupInfo[] = (data?.results || []).map((g: any) => ({
    id: String(g.id),
    name: String(g.name || ""),
    type: Number(g.type) || 0,
    description: String(g.description || ""),
    group_count: Number(g.group_count) || 0,
    episode_count: Number(g.episode_count) || 0,
  }));
  return { show_id: showId, groups };
}

/** Which sub-group of an episode group holds season `season`? Groups are one
 *  season each, named "Season 1"/"Specials" with `order` matching the season
 *  number — the name is read first (a group's `order` can skip), then `order`
 *  as the fallback, and null means this order has no such season: S00 is the
 *  usual case, and the caller falls back to the aired endpoint for it rather
 *  than failing, since a show's specials live outside any alternative order. */
function groupSeasonSub(groups: any, season: number): any | null {
  if (!Array.isArray(groups) || !groups.length) return null;
  const seasonOf = (name: string): number | null => {
    const m = String(name || "").match(/season[^\d]*(\d{1,2})/i);
    if (m) return parseInt(m[1], 10);
    if (/special/i.test(name)) return 0;
    return null;
  };
  const byName = groups.find((g: any) => seasonOf(g?.name) === season);
  if (byName) return byName;
  return groups.find((g: any) => Number(g?.order) === season) || null;
}

/** Build one season's episode list from a TMDB episode GROUP — the alternative
 *  order (production, Disney+, Netflix …) — instead of the aired-order season
 *  endpoint. The group keeps each episode's AIRED number in `episode_number`
 *  and its position in the group in `order`, so the selected order is the
 *  position: episodes are renumbered `order + 1`. Language is honoured by the
 *  endpoint itself, with the en-US names overlaid by episode id where a
 *  translation bottoms out as a slot placeholder ("Episode 1"). Returns null
 *  when the order has no such season (or the group id is dead). */
async function seasonFromEpisodeGroup(
  groupId: string,
  season: number,
  language: string,
  show: ResolvedShow,
  showName: string,
): Promise<SeasonMeta | null> {
  const path = `/tv/episode_group/${encodeURIComponent(groupId)}?language=${language}`;
  const data = await tmdbGet<any>(path);
  const sub = groupSeasonSub(data?.groups, season);
  if (!sub || !Array.isArray(sub.episodes) || !sub.episodes.length) return null;
  let fallback: Map<string, string> | null = null;
  if (language !== "en-US") {
    const en = await tmdbGet<any>(`/tv/episode_group/${encodeURIComponent(groupId)}?language=en-US`);
    const enSub = en ? groupSeasonSub(en.groups, season) : null;
    if (enSub && Array.isArray(enSub.episodes)) {
      fallback = new Map(
        enSub.episodes
          .filter((e: any) => typeof e.name === "string" && e.name.trim())
          .map((e: any) => [String(e.id), (e.name as string).trim()]),
      );
    }
  }
  const episodes: EpisodeMeta[] = sub.episodes.map((e: any, i: number) => {
    let name = typeof e.name === "string" ? e.name.trim() : "";
    if ((!name || SLOT_TITLE.test(name)) && fallback) {
      const fb = fallback.get(String(e.id));
      if (fb && fb !== name) name = fb;
    }
    return {
      episode_number: typeof e.order === "number" && e.order >= 0 ? e.order + 1 : i + 1,
      name,
      air_date: e.air_date ? String(e.air_date) : null,
    };
  });
  return {
    tmdb_show_id: show.id,
    show_name: showName,
    resolvedVia: show.via,
    language,
    episode_group_id: groupId,
    order_pruned: true,
    episodes,
  };
}

/** Lowercased, apostrophes deleted, everything else collapsed to single spaces
 *  — a local mirror of routes' `normalizeTitleForCompare` (routes imports THIS
 *  module; the import cannot run the other way). Apostrophes are deleted, not
 *  swept to a space: they are the only difference between "Scrooges Pet" and
 *  "Scrooge's Pet", and a space would split the word so the two would stop
 *  comparing as the same episode. */
function normTitleKey(s: string): string {
  return s.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Every episode the active order holds OUTSIDE `skipSeason`, keyed by
 *  normalized title with the air dates it aired on. A null return means the
 *  group detail could not be read (dead id, TMDB outage) — the caller then
 *  skips reconciliation entirely and writes the row UNMARKED so the next read
 *  tries again, rather than filtering against nothing. `skipSeason` is the
 *  season being fetched: when the group LACKS it the fetch fell back to the
 *  aired endpoint, but a transient failure inside `seasonFromEpisodeGroup`
 *  can produce the same fallback while the group actually holds the season —
 *  without the skip, the group's own entries would match the aired rows and
 *  empty the season out. */
async function orderRelocatedEpisodes(
  groupId: string,
  language: string,
  skipSeason: number,
): Promise<Map<string, Set<string>> | null> {
  try {
    const detail = await tmdbGet<any>(`/tv/episode_group/${encodeURIComponent(groupId)}?language=${language}`);
    const subs = detail?.groups;
    if (!Array.isArray(subs) || !subs.length) return null;
    const map = new Map<string, Set<string>>();
    for (const sub of subs) {
      const name = String(sub?.name || "");
      const m = name.match(/season[^\d]*(\d{1,2})/i);
      const s = m ? parseInt(m[1], 10) : /special/i.test(name) ? 0 : Number(sub?.order);
      if (!Number.isFinite(s) || s === skipSeason) continue;
      for (const e of Array.isArray(sub?.episodes) ? sub.episodes : []) {
        const key = normTitleKey(String(e?.name || ""));
        const date = e?.air_date ? String(e.air_date) : "";
        if (!key || !date) continue;
        let set = map.get(key);
        if (!set) map.set(key, (set = new Set()));
        set.add(date);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** Whether an aired-endpoint row is an episode the active order FILED IN ANOTHER
 *  SEASON. Matched on normalized title AND air date, so an unrelated same-named
 *  special (remakes, re-titled recaps) survives — only the pair identifies one
 *  episode. A slot title ("Episode 2" / "Odcinek 2") states nothing, so a
 *  slot-titled row is decided by its air date alone; a non-slot row never
 *  matches a slot-titled group entry (titles are compared within one language,
 *  so both sides come from the same translation table and the asymmetric case
 *  does not arise in practice). */
function relocatedByOrder(relocated: Map<string, Set<string>>, e: any): boolean {
  const date = e?.air_date ? String(e.air_date) : "";
  if (!date) return false;
  const raw = typeof e?.name === "string" ? e.name : "";
  const key = normTitleKey(raw);
  if (key && !SLOT_TITLE.test(raw)) return relocated.get(key)?.has(date) ?? false;
  for (const dates of relocated.values()) if (dates.has(date)) return true;
  return false;
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
  // A selected episode ORDER renumbers the same episodes, so a payload written
  // under one order answers a different question than the pref asks for now:
  // only a payload carrying the SAME order (or none, when none is selected)
  // may be served from cache.
  const order = franchiseEpisodeOrder(db, libraryKey);
  let rowGroup: string | null = order?.id ?? null;
  // The cache is keyed by language too, so a Polish fetch never clobbers the
  // English one (they used to share a row and flip-flop on every refresh).
  const cacheRow = db
    .prepare("SELECT payload FROM tmdb_season_cache WHERE library_key = ? AND season = ? AND language = ?")
    .get(libraryKey, season, language) as any;
  let cached: SeasonMeta | null = null;
  if (cacheRow) {
    try {
      const payload = JSON.parse(cacheRow.payload) as SeasonMeta;
      // Same order AND already reconciled against it: a row fetched under an
      // order but written before the reconciliation existed (or during a
      // group-detail outage) still lists an order-relocated special as a
      // missing S00 entry — treat it as a miss so the next read rewrites it.
      const sameOrder = (payload.episode_group_id ?? null) === rowGroup;
      const reconciled = rowGroup == null || payload.order_pruned === true;
      if (sameOrder && reconciled) cached = payload;
    } catch {}
  }
  if (cached && !force) return cached;

  const key = apiKey();
  if (!key) return cached;
  let show = await resolveShowIdentity(libraryKey, title, language);
  // Locally-mangled row titles ("Ninjago: Dragon Rising") fail TMDB search
  // while the on-disk processed folder holds the real name ("LEGO Ninjago:
  // Dragons Rising") — retry with that alt title before giving up.
  if (!show && opts.altTitle && opts.altTitle.trim() && opts.altTitle !== title) {
    show = await resolveShowIdentity(libraryKey, opts.altTitle.trim(), language);
  }
  if (!show) {
    if (!cacheRow) console.warn(`[TMDB] no show match for ${libraryKey} "${title}"${opts.altTitle ? ` (alt: "${opts.altTitle}")` : ""}`);
    return cached;
  }
  // An episode ORDER belongs to the show it was picked from. A key can be
  // re-attached to a DIFFERENT show underneath it, and taking that show's
  // "Season 1" at face value would print the other show's titles under this
  // one's numbers — so a mismatched pref is dropped, together with its cache
  // rows: they were fetched under the order that just died, and
  // episodeTitleFromCache reads them without ever consulting the pref.
  if (order && (order.show_id == null || order.show_id !== show.id)) {
    rowGroup = null;
    try {
      db.prepare("UPDATE tmdb_franchise_prefs SET episode_group_id = NULL, episode_group_show_id = NULL WHERE library_key = ?").run(libraryKey);
      db.prepare("DELETE FROM tmdb_season_cache WHERE library_key = ?").run(libraryKey);
    } catch (err: any) {
      console.error(`[TMDB] could not drop the stale episode order for ${libraryKey}: ${err.message}`);
    }
  }
  // The selected order's own season list, when it has this season — S00
  // usually isn't part of any alternative order, and the aired endpoint below
  // is the honest answer for it, not a failure.
  if (rowGroup) {
    const gmeta = await seasonFromEpisodeGroup(rowGroup, season, language, show, show.name || title);
    if (gmeta) {
      saveSeasonCache(db, libraryKey, season, language, gmeta);
      return gmeta;
    }
  }
  const data = await tmdbGet<any>(`/tv/${show.id}/season/${season}?language=${language}`);
  if (!data?.episodes) return cached;

  // The selected order lacks this season (S00 is the usual case), so the aired
  // endpoint answers — but the aired list can hold episodes the order FILED IN
  // A NUMBERED SEASON. Phineas and Ferb's Disney+ order files "The O.W.C.A.
  // Files" in S4 while aired S00 still lists it: unfiltered, the S00 grid and
  // the Specials pill call it a missing special forever while the same episode
  // fills S4E48 in the next tab. Drop rows the order relocates elsewhere; a
  // null `relocated` (group detail unreadable) skips the filter and marks the
  // row unreconciled, so it is refetched next read instead of served as a hit.
  let relocated: Map<string, Set<string>> | null = null;
  if (rowGroup) relocated = await orderRelocatedEpisodes(rowGroup, language, season);
  const airedEpisodes: any[] = (Array.isArray(data.episodes) ? data.episodes : []).filter(
    (e: any) => !relocated || !relocatedByOrder(relocated, e),
  );

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
    // Recorded under the pref in force, even when this season fell back to the
    // aired endpoint (an S00 in a production-order franchise): the row was
    // computed under that pref, so it must compare equal to it later.
    episode_group_id: rowGroup,
    // Reconciled when there is no order in force (nothing to reconcile against)
    // or the filter above actually ran; unmarked rows are refetched next read.
    order_pruned: !rowGroup || relocated !== null,
    episodes: airedEpisodes.map((e: any) => {
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
  saveSeasonCache(db, libraryKey, season, language, meta);
  return meta;
}

/** Persist a fetched season under (library_key, season, language). The payload
 *  carries the episode order it was fetched under, so a later read can tell it
 *  apart from a row written under another one. Not wrapped in a catch: a
 *  failed cache write must surface, not be swallowed. */
function saveSeasonCache(db: Database, libraryKey: string, season: number, language: string, meta: SeasonMeta): void {
  db.prepare("INSERT OR REPLACE INTO tmdb_season_cache (library_key, season, language, tmdb_show_id, show_name, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    libraryKey,
    season,
    language,
    meta.tmdb_show_id,
    meta.show_name,
    JSON.stringify(meta),
    new Date().toISOString(),
  );
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