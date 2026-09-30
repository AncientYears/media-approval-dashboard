import { useEffect, useState } from "react";
import { discover, discoverRequest, discoverTVSeasons } from "../api";

interface DiscoverResult {
  type: "movie" | "series";
  id: number;
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
}

interface SeasonOption {
  season_number: number;
  name: string;
  episode_count: number;
}

function posterUrl(poster: string | null): string | null {
  if (!poster) return null;
  return `https://image.tmdb.org/t/p/w92${poster}`;
}

export default function DiscoverModal({
  onClose,
  onRequested,
}: {
  onClose: () => void;
  onRequested: (requestId: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DiscoverResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [seasons, setSeasons] = useState<Record<number, SeasonOption[]>>({});
  const [selSeason, setSelSeason] = useState<Record<number, number>>({});
  const [requesting, setRequesting] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function runSearch() {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setError("");
    setResults([]);
    setMessage("");
    try {
      const data = await discover(term);
      setResults(data.results || []);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Search failed");
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    const seriesIds = results.filter((r) => r.type === "series").map((r) => r.id);
    for (const tmdbId of seriesIds) {
      if (seasons[tmdbId] !== undefined) continue;
      discoverTVSeasons(tmdbId)
        .then((data) => {
          const opts: SeasonOption[] = (data.seasons || []).filter((s: any) => s.season_number > 0);
          if (opts.length > 0) {
            setSeasons((prev) => ({ ...prev, [tmdbId]: opts }));
            setSelSeason((prev) => (prev[tmdbId] !== undefined ? prev : { ...prev, [tmdbId]: opts[opts.length - 1].season_number }));
          } else {
            setSeasons((prev) => ({ ...prev, [tmdbId]: [] }));
          }
        })
        .catch(() => {
          setSeasons((prev) => ({ ...prev, [tmdbId]: [] }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  async function submitRequest(r: DiscoverResult) {
    setRequesting(`${r.type}:${r.id}`);
    setMessage("");
    try {
      const payload = r.type === "series"
        ? { type: r.type, tmdbId: r.id, title: r.title, year: r.year, season: selSeason[r.id] }
        : { type: r.type, tmdbId: r.id, title: r.title, year: r.year };
      const data = await discoverRequest(payload);
      setMessage(`Requested "${data.title}"${data.existed ? " (already tracked)" : ""} — opening request…`);
      setTimeout(() => onRequested(data.request_id), 600);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Request failed");
      setRequesting(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box discover-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Discover & Request</h3>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            Search TMDB for movies and shows you want. Requesting creates a native request on the dashboard — then use
            the Search / Approve flow to grab it via Prowlarr.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="e.g. True Detective"
              className="download-dirs-input"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={runSearch} disabled={searching || !q.trim()}>
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          {error && <div className="modal-line" style={{ color: "#f87171" }}>{error}</div>}
          {message && <div className="modal-line" style={{ color: "#10b981" }}>{message}</div>}
          {results.length === 0 && !searching && (
            <div className="modal-line" style={{ color: "#94a3b8" }}>
              No results yet{error ? "" : " — type a title above."}
            </div>
          )}
          <div className="discover-results">
            {results.map((r) => {
              const poster = posterUrl(r.poster);
              return (
                <div key={`${r.type}:${r.id}`} className="discover-item">
                  <div className="discover-poster">
                    {poster ? (
                      <img src={poster} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : null}
                  </div>
                  <div className="discover-info">
                    <div className="discover-title">
                      <span className="badge" style={{ background: r.type === "movie" ? "#3b82f6" : "#8b5cf6" }}>{r.type}</span>
                      <span style={{ fontWeight: 600 }}>{r.title}</span>
                      {r.year ? <span style={{ color: "#94a3b8", marginLeft: 6 }}>({r.year})</span> : null}
                    </div>
                    {r.overview ? <div className="discover-overview">{r.overview}</div> : null}
                    <div className="discover-actions">
                      {r.type === "series" && seasons[r.id] !== undefined && seasons[r.id].length > 0 ? (
                        <select
                          className="download-dirs-input"
                          style={{ width: "auto" }}
                          value={selSeason[r.id] ?? seasons[r.id][0].season_number}
                          onChange={(e) => setSelSeason((prev) => ({ ...prev, [r.id]: Number(e.target.value) }))}
                        >
                          {[...seasons[r.id]].sort((a, b) => a.season_number - b.season_number).map((s) => (
                            <option key={s.season_number} value={s.season_number}>
                              {s.name === `Season ${s.season_number}` || s.name === "Season" ? `S${String(s.season_number).padStart(2, "0")}` : `${s.name} (S${String(s.season_number).padStart(2, "0")})`}
                            </option>
                          ))}
                        </select>
                      ) : r.type === "series" ? (
                        <span style={{ color: "#f59e0b", fontSize: 12 }}>loading seasons…</span>
                      ) : null}
                      <button
                        className="btn btn-primary btn-tiny"
                        disabled={requesting !== null || (r.type === "series" && seasons[r.id] === undefined)}
                        onClick={() => submitRequest(r)}
                      >
                        {requesting === `${r.type}:${r.id}` ? "Requesting…" : "Request"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}