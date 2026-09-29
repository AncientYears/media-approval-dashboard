import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchNativeFranchise, fetchRequestEpisodes, refreshRequestMetadata, setFranchiseLanguage } from "../api";
import { useToast } from "../components/Toast";

const LANGUAGES = ["pl-PL", "en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ru-RU", "uk-UA", "cs-CZ", "sk-SK", "hu-HU", "nl-NL", "sv-SE", "no-NO", "da-DK", "fi-FI", "ro-RO", "tr-TR", "el-GR", "he-IL", "ja-JP", "ko-KR", "zh-CN", "ar-SA"];

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

  const loadEpisodes = async (season: any) => {
    if (episodes[season.season]) return;
    try {
      const data = await fetchRequestEpisodes(season.request_id);
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
      await refreshRequestMetadata(season.request_id);
      const data = await fetchRequestEpisodes(season.request_id);
      setEpisodes((prev) => ({ ...prev, [season.season]: data }));
      toast("Metadata refreshed", "success");
    } catch {
      toast("Metadata unavailable (no TMDB key or server offline?)", "error");
    }
    setRefreshing(null);
  };

  const handleLanguage = async (value: string) => {
    const seedId = franchise?.seasons?.[0]?.request_id;
    if (!seedId) return;
    const prev = language;
    setLanguage(value);
    try {
      await setFranchiseLanguage(seedId, value || null);
      for (const s of franchise.seasons) {
        if (expanded.has(s.season) && episodes[s.season]) {
          await refreshRequestMetadata(s.request_id);
          const data = await fetchRequestEpisodes(s.request_id);
          setEpisodes((ep) => ({ ...ep, [s.season]: data }));
        }
      }
      setFranchise({ ...franchise, language: value || null });
      toast(value ? `Language: ${value}` : "Using default language", "success");
    } catch {
      setLanguage(prev);
      toast("Could not set language", "error");
    }
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
          <span className="rtag" style={{ marginLeft: 8 }} title="library_key — stable franchise identity (series:&lt;tvdb|imdb|slug&gt;:&lt;year&gt;) used to group seasons without Sonarr">{franchise.library_key}</span>
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
                  {coveredCount > 0 ? (
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
                  <button className="btn btn-secondary btn-tiny" onClick={(e) => { e.stopPropagation(); navigate(`/requests/${season.request_id}`); }}>
                    Open Releases
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
    </>
  );
}