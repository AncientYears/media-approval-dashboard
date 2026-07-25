import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchFranchise, fetchReleases, fetchTorrentStatuses, approveRelease } from "../api";

const POLL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_SEARCH_ALL || "0") * 1000;

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export default function FranchiseDetail() {
  const { sonarrId } = useParams<{ sonarrId: string }>();
  const navigate = useNavigate();
  const [franchise, setFranchise] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<any>(null);
  const [searchingAll, setSearchingAll] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const autoSearchDone = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadFranchise = useCallback(async () => {
    if (!sonarrId) return;
    try {
      const data = await fetchFranchise(Number(sonarrId));
      setFranchise(data);
      setError(null);
    } catch {
      setError("Failed to load franchise");
    } finally {
      setLoading(false);
    }
  }, [sonarrId]);

  useEffect(() => {
    setLoading(true);
    setSelectedSeason(null);
    autoSearchDone.current = false;
    loadFranchise();
  }, [loadFranchise]);

  const runSearchStream = useCallback(async (force: boolean, silent = false) => {
    if (!franchise?.sonarr_id) return;
    if (!silent) setSearchingAll(true);
    if (!silent) setSearchProgress("Searching...");
    try {
      const resp = await fetch(`/api/requests/managed/${franchise.sonarr_id}/search-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (data.message) setSearchProgress(data.message);
            if (eventType === "found" && data.season != null) {
              setFranchise((prev: any) => {
                if (!prev) return prev;
                const seasons = prev.seasons.map((s: any) => {
                  if (s.season === data.season) {
                    return {
                      ...s,
                      release_count: data.release_count ?? s.release_count,
                      total_size_mb: data.total_size_mb ?? s.total_size_mb,
                      status: data.status ?? s.status,
                    };
                  }
                  return s;
                });
                return {
                  ...prev,
                  seasons,
                  total_size_mb: seasons.reduce((sum: number, s: any) => sum + (s.total_size_mb || 0), 0),
                  total_releases: seasons.reduce((sum: number, s: any) => sum + (s.release_count || 0), 0),
                };
              });
            }
            if (data.totalFound != null) {
              const msg = `Done — ${data.totalFound} release(s), ${data.seasons || 0} season(s)${data.skipped ? `, ${data.skipped} skipped` : ""}`;
              if (!silent) {
                setSearchProgress(msg);
                setTimeout(() => setSearchProgress(""), 3000);
              }
            }
          } else if (line.trim() === "") {
            eventType = "";
          }
        }
      }
    } catch {
      if (!silent) {
        setSearchProgress("Search failed");
        setTimeout(() => setSearchProgress(""), 3000);
      }
    }
    if (!silent) setSearchingAll(false);
    await loadFranchise();
  }, [franchise?.sonarr_id, loadFranchise]);

  useEffect(() => {
    if (loading || !franchise || autoSearchDone.current) return;
    autoSearchDone.current = true;
    runSearchStream(false, true);
  }, [loading, franchise, runSearchStream]);

  useEffect(() => {
    if (POLL_MS <= 0) return;
    pollTimerRef.current = setInterval(() => {
      if (!searchingAll) runSearchStream(false, true);
    }, POLL_MS);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [POLL_MS, searchingAll, runSearchStream]);

  if (loading) return <div className="container"><p>Loading...</p></div>;
  if (error) return <div className="container error"><p>{error}</p></div>;
  if (!franchise) return <div className="container"><p>Not found</p></div>;

  if (selectedSeason) {
    return (
      <SeasonDetail
        season={selectedSeason}
        franchise={franchise}
        onBack={() => setSelectedSeason(null)}
      />
    );
  }

  return (
    <div className="container">
      <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")} style={{ marginBottom: 12 }}>
        &larr; Dashboard
      </button>

      <h2>{franchise.title} <span className="type-suffix">- Series</span></h2>
      <p className="request-meta">
        {franchise.total_releases} release{franchise.total_releases !== 1 ? "s" : ""} · {formatSize(franchise.total_size_mb)}
      </p>

      <div className="request-actions" style={{ marginBottom: 16 }}>
        <button className="btn btn-primary btn-tiny" onClick={() => runSearchStream(true)} disabled={searchingAll}>
          {searchingAll ? <><span className="spinner" /> {searchProgress || "Searching..."}</> : "Search All Seasons"}
        </button>
      </div>

      {searchProgress && (
        <div className="search-progress">
          <span>{searchProgress}</span>
        </div>
      )}

      <div className="franchise-seasons-list">
        {franchise.seasons.map((season: any) => {
          const hasReleases = season.total_candidates > 0;
          const hasTorrents = season.status === "DOWNLOADING" || season.status === "SEEDING";
          const isSearching = season.status === "SEARCHING";
          return (
            <div key={season.season} className="franchise-season-row" onClick={() => setSelectedSeason(season)}>
              <div className="fr-season-left">
                <span className="season-label">S{String(season.season).padStart(2, "0")}</span>
                <span className={`season-status ${hasReleases ? "has-content" : "empty"}`}>
                  {season.total_candidates > 0 ? `${season.total_candidates} releases` : "no releases"}
                </span>
                {isSearching && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px" }}>searching</span>}
                {hasTorrents && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px", background: season.status === "SEEDING" ? "#2d6a4f" : "#1d6099" }}>{season.status === "SEEDING" ? "SEEDING" : "DOWNLOADING"}</span>}
              </div>
              <div className="fr-season-right">
                <span className="rtag">{formatSize(season.total_size_mb)}</span>
                <span className="fr-arrow">&rsaquo;</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeasonDetail({ season, franchise, onBack }: {
  season: any;
  franchise: any;
  onBack: () => void;
}) {
  const [releases, setReleases] = useState<any[]>([]);
  const [request, setRequest] = useState<any>(null);
  const [torrentStatuses, setTorrentStatuses] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"app_score" | "size_mb" | "seeders">("app_score");

  const loadData = useCallback(async () => {
    try {
      const data = await fetchReleases(season.request_id);
      setRequest(data);
      setReleases(data.releases || []);
      setSearchTerm((prev) => prev || data.title || "");

      if (data.status === "DOWNLOADING" || data.status === "SEEDING") {
        try {
          const ts = await fetchTorrentStatuses(season.request_id);
          setTorrentStatuses(Array.isArray(ts) ? ts : []);
        } catch {
          setTorrentStatuses([]);
        }
      }
    } catch {
      // ignore
    }
  }, [season.request_id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearch = async () => {
    setSearching(true);
    setSearchProgress("Searching...");
    try {
      const resp = await fetch(`/api/requests/${season.request_id}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchTerm: searchTerm.trim() || undefined }),
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (data.message) setSearchProgress(data.message);
          }
        }
      }
    } catch {
      setSearchProgress("Search failed");
      setTimeout(() => setSearchProgress(""), 2000);
    }
    setSearching(false);
    await loadData();
  };

  const handleApprove = async (releaseId: number) => {
    setApprovingId(releaseId);
    try {
      await approveRelease(season.request_id, releaseId);
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const data = await fetchReleases(season.request_id);
        setRequest(data);
        setReleases(data.releases || []);
        if (attempts >= 10) clearInterval(poll);
      }, 3000);
    } finally {
      setApprovingId(null);
    }
  };

  const sorted = [...releases].sort((a: any, b: any) => {
    if (sortBy === "app_score") return (b.app_score || 0) - (a.app_score || 0);
    if (sortBy === "size_mb") return (b.size_mb || 0) - (a.size_mb || 0);
    if (sortBy === "seeders") return ((b.seeders ?? 0) - (a.seeders ?? 0));
    return 0;
  });

  const hasActiveTorrents = request?.status === "DOWNLOADING" || request?.status === "SEEDING";

  return (
    <div className="container">
      <div className="detail-topbar">
        <button className="btn btn-secondary btn-tiny" onClick={onBack}>&larr; {franchise.title}</button>
        <div className="detail-title">
          <span className="detail-title-text">{franchise.title}</span>
          <span className="rtag">S{String(season.season).padStart(2, "0")}</span>
        </div>
        <input
          className="search-term-input"
          type="text"
          placeholder="Search term (e.g. S02E05 1080p)..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
        />
        <button className="btn btn-primary btn-tiny" onClick={handleSearch} disabled={searching}>
          {searching ? <span className="spinner" /> : "Search"}
        </button>
      </div>

      {searchProgress && (
        <div className="search-progress">
          <span className="spinner" />
          <span>{searchProgress}</span>
        </div>
      )}

      {hasActiveTorrents && (
        <div className="dashboard-section" style={{ marginBottom: 12 }}>
          <h4>Active Torrents</h4>
          {torrentStatuses.length > 0 ? (
            torrentStatuses.map((ts: any) => (
              <div key={ts.release_id || ts.hash} className="franchise-release">
                <span className={`status-badge status-badge-sm qb-${ts.state}`}>{ts.state}</span>
                <span className="fr-release-title">{ts.title || ts.name}</span>
                <span className="rtag">{ts.progress != null ? `${Math.round(ts.progress)}%` : ""}</span>
                <span className="rtag">{ts.num_seeds}s / {ts.num_leechs}l</span>
              </div>
            ))
          ) : (
            <p style={{ opacity: 0.5, fontSize: 13 }}>Checking torrents...</p>
          )}
        </div>
      )}

      <div className="dashboard-section">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h4 style={{ margin: 0 }}>Releases — {releases.length}</h4>
          <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <button className={`btn btn-tiny ${sortBy === "app_score" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("app_score")}>Score</button>
            <button className={`btn btn-tiny ${sortBy === "size_mb" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("size_mb")}>Size</button>
            <button className={`btn btn-tiny ${sortBy === "seeders" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("seeders")}>Seeders</button>
          </div>
        </div>

        {sorted.length === 0 ? (
          <p style={{ opacity: 0.5, fontSize: 13 }}>No releases found. Click Search above.</p>
        ) : (
          <div className="franchise-releases">
            {sorted.map((r: any) => (
              <div key={r.id} className="franchise-release" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {r.approved && <span className="rtag" style={{ background: "#2d6a4f" }}>APPROVED</span>}
                {r.torrent_hash && !r.approved && <span className="rtag" style={{ background: "#1d6099" }}>DL</span>}
                <span className="fr-release-title" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.info_url ? (
                    <a href={r.info_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{r.title}</a>
                  ) : r.title}
                </span>
                <span className="rtag">{r.quality || r.radarr_quality}</span>
                <span className="rtag">{formatSize(r.size_mb)}</span>
                {r.seeders != null && <span className="rtag">{r.seeders}s/{r.leechers ?? 0}l</span>}
                {r.release_group && <span className="rtag">{r.release_group}</span>}
                <span className="rtag" style={{ fontWeight: 600 }}>{r.app_score}/20</span>
                {!r.approved && (
                  <button
                    className="btn btn-primary btn-tiny"
                    onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }}
                    disabled={approvingId !== null}
                  >
                    {approvingId === r.id ? "Approving..." : "Approve"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
