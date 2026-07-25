import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchFranchise, fetchTorrentStatuses } from "../api";

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
  const [seasonTorrents, setSeasonTorrents] = useState<Record<number, any[]>>({});
  const [episodeSearch, setEpisodeSearch] = useState("");
  const [episodeSearching, setEpisodeSearching] = useState(false);
  const autoSearchDone = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadFranchise = useCallback(async () => {
    if (!sonarrId) return;
    try {
      const data = await fetchFranchise(Number(sonarrId));
      setFranchise(data);
      setError(null);

      const torrents: Record<number, any[]> = {};
      for (const season of data.seasons) {
        if (season.release_count > 0) {
          try {
            const ts = await fetchTorrentStatuses(season.request_id);
            torrents[season.season] = Array.isArray(ts) ? ts : [];
          } catch {
            torrents[season.season] = [];
          }
        }
      }
      setSeasonTorrents(torrents);
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

  const runSearchStream = useCallback(async (force: boolean) => {
    if (!franchise?.sonarr_id) return;
    setSearchingAll(true);
    setSearchProgress("Searching...");

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
              setSearchProgress(`Done — ${data.totalFound} release(s), ${data.seasons || 0} season(s)${data.skipped ? `, ${data.skipped} skipped` : ""}`);
              setTimeout(() => setSearchProgress(""), 3000);
            }
          } else if (line.trim() === "") {
            eventType = "";
          }
        }
      }
    } catch {
      setSearchProgress("Search failed");
      setTimeout(() => setSearchProgress(""), 3000);
    }

    setSearchingAll(false);
    await loadFranchise();
  }, [franchise?.sonarr_id, loadFranchise]);

  useEffect(() => {
    if (loading || !franchise || autoSearchDone.current) return;
    autoSearchDone.current = true;
    runSearchStream(false);
  }, [loading, franchise, runSearchStream]);

  useEffect(() => {
    if (POLL_MS <= 0) return;
    pollTimerRef.current = setInterval(() => {
      if (!searchingAll) runSearchStream(false);
    }, POLL_MS);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [POLL_MS, searchingAll, runSearchStream]);

  const handleEpisodeSearch = async () => {
    if (!selectedSeason || !episodeSearch.trim()) return;
    setEpisodeSearching(true);
    try {
      const resp = await fetch(`/api/requests/${selectedSeason.request_id}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchTerm: episodeSearch.trim() }),
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
      // ignore
    }
    await loadFranchise();
    setEpisodeSearching(false);
    setEpisodeSearch("");
  };

  if (loading) return <div className="container"><p>Loading...</p></div>;
  if (error) return <div className="container error"><p>{error}</p></div>;
  if (!franchise) return <div className="container"><p>Not found</p></div>;

  const selectedTorrents = selectedSeason ? (seasonTorrents[selectedSeason.season] || []) : [];

  if (selectedSeason) {
    return (
      <div className="container">
        <button className="btn btn-secondary btn-tiny" onClick={() => setSelectedSeason(null)} style={{ marginBottom: 12 }}>
          &larr; {franchise.title}
        </button>

        <h2>{franchise.title} — Season {String(selectedSeason.season).padStart(2, "0")}</h2>
        <p className="request-meta">
          {selectedSeason.release_count} release{selectedSeason.release_count !== 1 ? "s" : ""} · {formatSize(selectedSeason.total_size_mb)}
          {selectedSeason.episode_count > 0 && <> · {selectedSeason.covered_episodes?.length || 0}/{selectedSeason.episode_count} EP</>}
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
          <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${selectedSeason.request_id}`)}>
            Full Search &amp; Manage
          </button>
          <input
            className="search-input"
            placeholder='Search episode (e.g. S02E05 1080p)'
            value={episodeSearch}
            onChange={(e) => setEpisodeSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleEpisodeSearch()}
            disabled={episodeSearching}
            style={{ flex: 1, maxWidth: 400 }}
          />
          <button className="btn btn-primary btn-tiny" onClick={handleEpisodeSearch} disabled={episodeSearching || !episodeSearch.trim()}>
            {episodeSearching ? "Searching..." : "Search"}
          </button>
        </div>

        {searchProgress && <div className="search-progress"><span>{searchProgress}</span></div>}

        {selectedSeason.status === "DOWNLOADING" || selectedSeason.status === "SEEDING" ? (
          <div className="dashboard-section">
            <h4>Active Torrents</h4>
            {selectedTorrents.length > 0 ? (
              selectedTorrents.map((ts: any) => (
                <div key={ts.release_id || ts.hash} className="franchise-release">
                  <span className={`status-badge status-badge-sm qb-${ts.state}`}>{ts.state}</span>
                  <span className="fr-release-title">{ts.title || ts.name}</span>
                  <span className="rtag">{ts.progress != null ? `${Math.round(ts.progress)}%` : ""}</span>
                  <span className="rtag">{ts.num_seeds}s / {ts.num_leechs}l</span>
                </div>
              ))
            ) : (
              <p style={{ opacity: 0.5, fontSize: 13 }}>Torrent status loading...</p>
            )}
          </div>
        ) : null}

        <div className="dashboard-section">
          <h4>Releases</h4>
          {selectedSeason.releases?.length > 0 ? (
            <div className="franchise-releases">
              {selectedSeason.releases.map((r: any) => (
                <div key={r.id} className="franchise-release">
                  {r.torrent_hash ? <span className="rtag" style={{ background: "#2d6a4f" }}>DL</span> : null}
                  <span className="fr-release-title">{r.title}</span>
                  {r.parsed_episodes && <span className="rtag">{r.parsed_episodes}</span>}
                  <span className="rtag">{r.quality}</span>
                  <span className="rtag">{formatSize(r.size_mb)}</span>
                  {r.release_group && <span className="rtag">{r.release_group}</span>}
                  {r.seeders != null && <span className="rtag">{r.seeders}s</span>}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ opacity: 0.5, fontSize: 13 }}>No releases yet</p>
          )}
        </div>
      </div>
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
          const covered = season.covered_episodes?.length || 0;
          const total = season.episode_count;
          const label = total ? `${covered}/${total} EP` : covered > 0 ? `${covered} EP` : "pending";
          const hasTorrents = season.status === "DOWNLOADING" || season.status === "SEEDING";
          const isSearching = season.status === "SEARCHING";
          return (
            <div key={season.season} className="franchise-season-row" onClick={() => setSelectedSeason(season)}>
              <div className="fr-season-left">
                <span className="season-label">S{String(season.season).padStart(2, "0")}</span>
                <span className={`season-status ${covered > 0 ? "has-content" : "empty"}`}>{label}</span>
                {isSearching && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px" }}>...</span>}
                {hasTorrents && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px" }}>{season.status === "SEEDING" ? "SEED" : "DL"}</span>}
              </div>
              <div className="fr-season-right">
                <span className="rtag">{season.release_count}r · {formatSize(season.total_size_mb)}</span>
                <span className="fr-arrow">&rsaquo;</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
