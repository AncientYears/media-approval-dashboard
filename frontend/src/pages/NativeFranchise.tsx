import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchNativeFranchise, fetchNativeSeasonEpisodes, fetchRequestEpisodes, refreshRequestMetadata, refreshNativeSeasonMetadata, setFranchiseLanguage, getEpisodeOrders, setFranchiseEpisodeOrder, fixNativeIdentity, getNativeIdentityCandidates, retitleSeries, ensureNativeSeason, LANGUAGES } from "../api";
import { useToast } from "../components/Toast";
import FixNamesModal from "../components/FixNamesModal";

export default function NativeFranchise() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [franchise, setFranchise] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [episodes, setEpisodes] = useState<Record<number, any>>({});
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [language, setLanguage] = useState<string>("");
  // Episode ORDER: the show's TMDB episode groups (production order, Disney+,
  // Netflix …) and the one in force. Empty groups = the show has no
  // alternatives (or TMDB can't say), so no second select is offered.
  const [orderGroups, setOrderGroups] = useState<any[]>([]);
  const [order, setOrder] = useState<string | null>(null);
  const [fixTarget, setFixTarget] = useState<{ id: number; season?: number } | null>(null);
  const [ensuring, setEnsuring] = useState<number | null>(null);
  const [fixingIdentity, setFixingIdentity] = useState(false);
  const [identityPicker, setIdentityPicker] = useState<{ reason: string; candidates: any[] } | null>(null);
  const [identitySearch, setIdentitySearch] = useState("");
  const [searchingIdentity, setSearchingIdentity] = useState(false);
  const [retitlingId, setRetitlingId] = useState<number | null>(null);

  const reloadFranchise = () => {
    setFranchise(null);
    return fetchNativeFranchise(Number(id))
      .then((data) => {
        setFranchise(data);
        setLanguage(data.language || "");
        loadOrders(data);
      })
      .catch((e: any) => setError(e.message));
  };

  /** Load this show's episode ORDER options. The pick is per franchise, but the
   *  endpoints take any season's request id, so the first row that has one is
   *  the seed (injected S00 rows have `request_id: null` and sort first). */
  const loadOrders = async (fr: any) => {
    const seedId = fr?.seasons?.find((s: any) => s.request_id != null)?.request_id;
    if (seedId == null) {
      setOrderGroups([]);
      setOrder(null);
      return;
    }
    try {
      const data = await getEpisodeOrders(seedId);
      setOrderGroups(data?.groups || []);
      setOrder(data?.current || null);
    } catch {
      // A failed listing just hides the selector — the order in force (if any)
      // keeps applying server-side.
      setOrderGroups([]);
      setOrder(null);
    }
  };

  const handleFixIdentity = async () => {
    setFixingIdentity(true);
    try {
      const res = await fixNativeIdentity(Number(id));
      if (res.fixed) {
        toast(`Identity fixed: ${res.old_key} → ${res.new_key}`, "success");
        reloadFranchise();
      } else {
        toast(res.reason === "unresolved on TMDB" ? "Could not resolve show on TMDB (server offline / no API key?)" : "Identity already canonical", "info");
      }
    } catch (e: any) {
      toast(e.response?.data?.error || e.message || "Fix identity failed", "error");
    } finally {
      setFixingIdentity(false);
    }
  };

  const handleOpenReattach = async (term?: string) => {
    const seedId = franchise?.seasons?.find((s: any) => s.request_id != null)?.request_id;
    if (!seedId) return;
    setSearchingIdentity(true);
    try {
      const res = await getNativeIdentityCandidates(seedId, term);
      setIdentitySearch(term || "");
      setIdentityPicker({
        reason: `Current identity: ${res.current_key || "(none)"} — searched "${term || res.query || ""}"`,
        candidates: res.candidates || [],
      });
    } catch (e: any) {
      toast(e.response?.data?.error || e.message || "Could not load candidates", "error");
    } finally {
      setSearchingIdentity(false);
    }
  };

  const handleRetitle = async (tmdbId: number) => {
    const seedId = franchise?.seasons?.find((s: any) => s.request_id != null)?.request_id;
    if (!seedId) return;
    setRetitlingId(tmdbId);
    try {
      const res = await retitleSeries(seedId, tmdbId);
      setIdentityPicker(null);
      toast(`Re-attached as ${res.new_key}`, "success");
      reloadFranchise();
    } catch (e: any) {
      toast(e.response?.data?.error || e.message || "Re-attach failed", "error");
    } finally {
      setRetitlingId(null);
    }
  };

  const loadEpisodes = async (season: any) => {
    if (episodes[season.season]) return;
    try {
      const data =
        season.request_id != null
          ? await fetchRequestEpisodes(season.request_id)
          : await fetchNativeSeasonEpisodes(Number(id), season.season);
      setEpisodes((prev) => ({ ...prev, [season.season]: data }));
    } catch {}
  };

  useEffect(() => {
    setFranchise(null);
    setEpisodes({});
    setExpanded(new Set());
    setError(null);
    fetchNativeFranchise(Number(id))
      .then((data) => {
        setFranchise(data);
        setLanguage(data.language || "");
        loadOrders(data);
        const open = searchParams.get("open");
        if (open != null) {
          const season = data.seasons?.find((s: any) => String(s.season) === open);
          if (season) {
            setExpanded(new Set([season.season]));
            loadEpisodes(season);
          }
        }
      })
      .catch((e: any) => setError(e.message));
  }, [id]);

  const toggle = async (season: any) => {
    const next = new Set(expanded);
    if (next.has(season.season)) {
      next.delete(season.season);
    } else {
      next.add(season.season);
      await loadEpisodes(season);
    }
    setExpanded(next);
  };

  const handleRefresh = async (season: any) => {
    setRefreshing(season.season);
    try {
      let data: any;
      if (season.request_id != null) {
        await refreshRequestMetadata(season.request_id);
        data = await fetchRequestEpisodes(season.request_id);
      } else {
        await refreshNativeSeasonMetadata(Number(id), season.season);
        data = await fetchNativeSeasonEpisodes(Number(id), season.season);
      }
      setEpisodes((prev) => ({ ...prev, [season.season]: data }));
      toast("Metadata refreshed", "success");
    } catch (e: any) {
      toast(e?.response?.data?.error || "Metadata unavailable (no TMDB key or server offline?)", "error");
    }
    setRefreshing(null);
  };

  const handleOpenReleases = async (season: any) => {
    if (season.request_id != null) {
      navigate(`/requests/${season.request_id}`, { state: { back: `/native/${id}` } });
      return;
    }
    setEnsuring(season.season);
    try {
      const data = await ensureNativeSeason(Number(id), season.season);
      if (data?.request_id) navigate(`/requests/${data.request_id}`, { state: { back: `/native/${id}` } });
    } catch {
      toast("Could not open releases for this season", "error");
    }
    setEnsuring(null);
  };

  const handleLanguage = async (value: string) => {
    const seedId = franchise?.seasons?.find((s: any) => s.request_id != null)?.request_id;
    if (!seedId) return;
    const prev = language;
    setLanguage(value);
    try {
      await setFranchiseLanguage(seedId, value || null);
    } catch (e: any) {
      setLanguage(prev);
      toast(e?.response?.data?.error || "Could not set language", "error");
      return;
    }
    // The pref is saved; everything below is cosmetic on top of it, so it must
    // not sit in the same try — a season failing to re-fetch used to undo a
    // save that had already succeeded and leave the UI disagreeing with the DB.
    for (const s of franchise.seasons) {
      if (!expanded.has(s.season) || !episodes[s.season]) continue;
      try {
        if (s.request_id != null) await refreshRequestMetadata(s.request_id).catch(() => null);
        const data =
          s.request_id != null
            ? await fetchRequestEpisodes(s.request_id)
            : await fetchNativeSeasonEpisodes(Number(id), s.season);
        setEpisodes((ep) => ({ ...ep, [s.season]: data }));
      } catch {
        // keep the old titles rather than failing the whole language change
      }
    }
    setFranchise({ ...franchise, language: value || null });
    toast(value ? `Language: ${value}` : "Using default language", "success");
  };

  const handleOrder = async (value: string) => {
    const seedId = franchise?.seasons?.find((s: any) => s.request_id != null)?.request_id;
    if (!seedId) return;
    const prev = order;
    setOrder(value || null);
    try {
      await setFranchiseEpisodeOrder(seedId, value || null);
    } catch (e: any) {
      setOrder(prev);
      toast(e?.response?.data?.error || "Could not set episode order", "error");
      return;
    }
    // Same shape as handleLanguage: the pref is saved above (and the backend
    // dropped every cached season for this key), so re-fetching the expanded
    // grids below is cosmetic on top of it and must not undo the save.
    for (const s of franchise.seasons) {
      if (!expanded.has(s.season) || !episodes[s.season]) continue;
      try {
        if (s.request_id != null) await refreshRequestMetadata(s.request_id).catch(() => null);
        const data =
          s.request_id != null
            ? await fetchRequestEpisodes(s.request_id)
            : await fetchNativeSeasonEpisodes(Number(id), s.season);
        setEpisodes((ep) => ({ ...ep, [s.season]: data }));
      } catch {
        // keep the old titles rather than failing the whole order change
      }
    }
    toast(value ? "Episode order changed — grids renumber under it" : "Using default aired order", "success");
  };

  if (error) {
    return (
      <div className="detail-topbar">
        <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")}>Back</button>
        <span className="detail-title-text">Series not found (no library_key)</span>
      </div>
    );
  }

  if (!franchise) {
    return <div className="detail-topbar"><span className="detail-title-text">Loading franchise…</span></div>;
  }

  return (
    <>
      <div className="detail-topbar">
        <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")}>Back</button>
        <div className="detail-title">
          <span className="detail-title-text">{franchise.title}</span>
          <span className="type-suffix">- Series</span>
          <span
            className="rtag"
            style={{ marginLeft: 8, cursor: "pointer" }}
            title="library_key — stable franchise identity used to group seasons. Click to copy."
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(franchise.library_key).catch(() => {});
              toast("library_key: stable identity grouping this franchise's seasons. Copied to clipboard.", "info");
            }}
          >{franchise.library_key}</span>
        </div>
        <select
          className="lang-select"
          value={language}
          onChange={(e) => handleLanguage(e.target.value)}
          title="TMDB language for episode titles (per franchise; default = TMDB_LANGUAGE or en-US)"
          style={{ marginLeft: "auto", fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0" }}
        >
          <option value="">Default language</option>
          {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        {orderGroups.length > 0 && (
          <select
            className="lang-select"
            value={order || ""}
            onChange={(e) => handleOrder(e.target.value)}
            title="Episode order — which numbering TMDB reports for this show's episodes. Only complete, official orders are listed (aired, production …); streaming platform snapshots are hidden because releases never follow them. Releases follow production order; changing it renumbers the grids and everything Fix Names derives from them."
            style={{ marginLeft: 8, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0" }}
          >
            <option value="">Aired order (default)</option>
            {orderGroups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        <button
          className="btn btn-secondary btn-tiny"
          style={{ marginLeft: 8 }}
          title={`Re-resolve this franchise on TMDB and rewrite its library_key to a clean \`series:<tvdbId>:<year>\` (anchored on the TVDB id the folder names embed, so it no longer rides a localized title slug). Fixes junk slugs like "...-264-al3x" and zero years. Migrates requests, TMDB cache, language pref and the identity layer.`}
          onClick={handleFixIdentity}
          disabled={fixingIdentity}
        >{fixingIdentity ? "Fixing…" : "Fix identity"}</button>
        <button
          className="btn btn-secondary btn-tiny"
          style={{ marginLeft: 4 }}
          title="Search TMDB for this series and pick the right show by hand. Use this when the stored title is localized/mangled even though the key looks fine — card matching reads the title, so only a re-attach can fix it."
          onClick={() => handleOpenReattach()}
          disabled={fixingIdentity}
        >Re-attach</button>
      </div>

      <div className="franchise-seasons-list">
        {franchise.seasons.map((season: any) => {
          const isExpanded = expanded.has(season.season);
          const epCount = season.episode_count || 0;
          const coveredCount = season.covered_episodes?.length || 0;
          const missingCount = epCount > 0 ? epCount - coveredCount : 0;
          const data = episodes[season.season];

          return (
            <div key={season.season} className="franchise-season-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="franchise-season-header" style={{ display: "flex", cursor: "pointer", alignItems: "center" }} onClick={() => toggle(season)}>
                <div className="fr-season-left">
                  <span className={`season-label ${season.season === 0 ? "season-special" : ""}`}>{season.season === 0 ? "Special" : `S${String(season.season).padStart(2, "0")}`}</span>
                  {season.season === 0 ? (
                    season.file_count > 0 || epCount > 0 ? (
                      <>
                        <span className="ep-badge ep-filled" style={{ fontSize: 9 }}>{season.file_count} file{season.file_count === 1 ? "" : "s"}</span>
                        <span className="ep-badge ep-missed" style={{ fontSize: 9 }}>numbered {coveredCount}/{epCount}</span>
                      </>
                    ) : (
                      <span className="season-status empty">no episodes</span>
                    )
                  ) : coveredCount > 0 ? (
                    <>
                      <span className="ep-badge ep-filled" style={{ fontSize: 9 }}>{coveredCount}{epCount > 0 ? `/${epCount}` : ""}</span>
                      {missingCount > 0 && <span className="ep-badge ep-missed" style={{ fontSize: 9 }}>{missingCount} missing</span>}
                    </>
                  ) : (
                    <span className="season-status empty">no episodes</span>
                  )}
                </div>
                <div className="fr-season-right" style={{ gap: 6 }}>
                  <button className="btn btn-secondary btn-tiny" onClick={(e) => { e.stopPropagation(); handleRefresh(season); }} disabled={refreshing === season.season}>
                    {refreshing === season.season ? "Refreshing..." : "Refresh Metadata"}
                  </button>
                  <button className="btn btn-secondary btn-tiny" onClick={(e) => { e.stopPropagation(); setFixTarget({ id: season.request_id ?? Number(id), season: season.request_id != null ? undefined : season.season }); }} title="Standardize this season's file/folder names">
                    Fix Names
                  </button>
                  <button className="btn btn-secondary btn-tiny" onClick={(e) => { e.stopPropagation(); handleOpenReleases(season); }} disabled={ensuring === season.season} title={season.request_id != null ? undefined : "No request row yet - creating one for this season"}>
                    {ensuring === season.season ? "Opening..." : "Open Releases"}
                  </button>
                  <span className="fr-arrow">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                </div>
              </div>

              {isExpanded && data && (
                <div className="season-expanded-content">
                  <div className="episode-list">
                    {data.episodes.map((ep: any) => (
                      <div key={ep.episode_number} className={`episode-row ${ep.present ? "ep-covered" : "ep-missing-row"}`}>
                        <span className="ep-num">E{String(ep.episode_number).padStart(2, "0")}</span>
                        <span className="ep-title">{ep.name || `Episode ${ep.episode_number}`}</span>
                        {ep.present ? (
                          <span className="ep-badge ep-filled">FILLED</span>
                        ) : (
                          <span className="ep-badge ep-missed">MISSING</span>
                        )}
                      </div>
                    ))}
                    {(data.extras || []).map((x: any, i: number) => (
                      <div key={`extra-${i}`} className="episode-row ep-covered">
                        <span className="ep-num">SPECIAL</span>
                        <span className="ep-title">{x.name}</span>
                        <span className="ep-badge ep-filled">FILLED</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {isExpanded && !data && <div className="season-expanded-content">Loading episodes…</div>}
            </div>
          );
        })}
      </div>
      {identityPicker && (
        <div className="modal-overlay" onClick={() => setIdentityPicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>Re-attach to the correct series</span>
              <button className="modal-close" onClick={() => setIdentityPicker(null)}>&times;</button>
            </div>
            <div className="modal-body" style={{ maxHeight: 460, overflowY: "auto" }}>
              <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)" }}>
                {identityPicker.reason}. Picking one rewrites this franchise's title and{" "}
                <code>library_key</code> across every season to that show.
              </p>
              {/* TMDB indexes a show under its ORIGINAL name, so a localized card
                  title can be unsearchable no matter how we spell it. Searching by
                  the show's real name is the only way to reach it. */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleOpenReattach(identitySearch.trim() || undefined);
                }}
                style={{ display: "flex", gap: 6, marginBottom: 10 }}
              >
                <input
                  value={identitySearch}
                  onChange={(e) => setIdentitySearch(e.target.value)}
                  placeholder="Search TMDB by another name…"
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    background: "var(--card-bg, #1e293b)",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    color: "#e2e8f0",
                    fontSize: 13,
                  }}
                />
                <button
                  type="submit"
                  disabled={searchingIdentity || identitySearch.trim().length < 2}
                  style={{
                    padding: "6px 12px",
                    background: "#334155",
                    border: "1px solid #475569",
                    borderRadius: 6,
                    color: "#e2e8f0",
                    cursor: searchingIdentity ? "wait" : "pointer",
                    opacity: identitySearch.trim().length < 2 ? 0.5 : 1,
                  }}
                >
                  {searchingIdentity ? "Searching…" : "Search"}
                </button>
              </form>
              {identityPicker.candidates.length === 0 ? (
                <div style={{ padding: 16, color: "var(--text-muted)" }}>
                  No candidates found on TMDB. Try the show&apos;s original-language title above.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {identityPicker.candidates.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => handleRetitle(c.id)}
                      disabled={retitlingId !== null}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        textAlign: "left",
                        background: "var(--card-bg, #1e293b)",
                        border: "1px solid #334155",
                        borderRadius: 6,
                        color: "#e2e8f0",
                        cursor: retitlingId !== null ? "wait" : "pointer",
                        opacity: retitlingId !== null && retitlingId !== c.id ? 0.5 : 1,
                      }}
                    >
                      {c.poster && (
                        <img
                          src={`https://image.tmdb.org/t/p/w92${c.poster}`}
                          alt=""
                          style={{ width: 46, height: 69, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                        />
                      )}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 13 }}>{c.title}</span>
                        {c.overview && (
                          <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {c.overview}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
                        {retitlingId === c.id ? "Re-attaching…" : c.year || "?"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {fixTarget && (
        <FixNamesModal
          requestId={fixTarget.id}
          season={fixTarget.season}
          title={franchise.title}
          onClose={() => setFixTarget(null)}
          onApplied={async () => {
            const data = await fetchNativeFranchise(Number(id));
            setFranchise(data);
            setLanguage(data.language || "");
            loadOrders(data);
          }}
        />
      )}
    </>
  );
}