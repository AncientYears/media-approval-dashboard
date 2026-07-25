import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchFranchise, fetchReleases, fetchTorrentStatuses, fetchFranchiseTorrentStatuses, approveRelease, pauseTorrent, resumeTorrent, dismissRequest, moveToLibrary, removeFromLibrary, processToLibrary } from "../api";

const SEARCH_MODES = ["season", "episodes"] as const;
type SearchMode = typeof SEARCH_MODES[number];

const POLL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_SEARCH_ALL || "0") * 1000;

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function parseAudioCodec(title: string): string[] {
  const t = title.replace(/[.\-]/g, " ").toUpperCase();
  const codecs: string[] = [];
  if (t.includes("TRUEHD ATMOS") || t.includes("TRUEHDATMOS")) codecs.push("TrueHD Atmos");
  else if (t.includes("TRUEHD")) codecs.push("TrueHD");
  if (t.includes("DTS X") || t.includes("DTS-X") || t.includes("DTSX")) codecs.push("DTS:X");
  else if (t.includes("DTS HD MA") || t.includes("DTS-HD MA") || t.includes("DTSHDMA")) codecs.push("DTS-HD MA");
  else if (t.includes("DTS HD") || t.includes("DTS-HD") || t.includes("DTSHD")) codecs.push("DTS-HD");
  else if (t.includes("DTS")) codecs.push("DTS");
  if (t.includes("ATMOS") && !codecs.some(c => c.includes("Atmos"))) codecs.push("Atmos");
  if (t.includes("DDP") || t.includes("EAC3") || t.includes("E-AC-3")) codecs.push("DD+");
  else if (t.includes("DD 5") || t.includes("AC3") || t.includes("AC-3")) codecs.push("DD");
  if (t.includes("AAC")) codecs.push("AAC");
  if (t.includes("FLAC")) codecs.push("FLAC");
  return codecs;
}

function parseAudioChannels(title: string): string {
  const m = title.match(/\b(\d\.\d)\b/);
  return m ? m[1] : "";
}

function ScoreBar({ value, max, className }: { value: number; max: number; className?: string }) {
  return (
    <div className="ed-bar">
      <div className={`ed-fill ${className || ""}`} style={{ width: `${(value / max) * 100}%` }} />
    </div>
  );
}

function Breakdown({ r }: { r: any }) {
  const qs = (() => {
    const q = (r.radarr_quality || "").toUpperCase();
    if (q.includes("REMUX-2160") || q.includes("REMUX2160")) return 10;
    if (q.includes("BLURAY-2160")) return 9;
    if (q.includes("WEB-DL-2160") || q.includes("WEBDL-2160")) return 8;
    if (q.includes("REMUX-1080") || q.includes("REMUX1080")) return 6;
    if (q.includes("BLURAY-1080")) return 5;
    if (q.includes("WEB-DL-1080") || q.includes("WEBDL-1080")) return 4;
    if (q.includes("1080")) return 4;
    if (q.includes("720")) return 1;
    return 0;
  })();
  const cf = r.radarr_custom_formats?.length || 0;
  const cfBonus = Math.min(5, cf);
  const sizeBonus = r.size_mb >= 1000 && r.size_mb <= 15000 ? 3 : r.size_mb >= 500 && r.size_mb <= 25000 ? 2 : r.size_mb > 0 ? 1 : 0;
  const rankBonus = r.radarr_rank === 1 ? 2 : r.radarr_rank <= 3 ? 1 : 0;

  const audioCodec = parseAudioCodec(r.title);
  const audioChannels = parseAudioChannels(r.title);

  return (
    <div className="expanded-detail">
      <div className="ed-grid">
        <div className="ed-item"><span>Quality</span><ScoreBar value={qs} max={10} /><span>{qs}/10</span><span className="ed-sub">{r.radarr_quality}</span></div>
        <div className="ed-item"><span>CF</span><ScoreBar value={cf} max={5} className="cf-fill" /><span>{cf}</span><span className="ed-sub">+{cfBonus}pts</span></div>
        <div className="ed-item"><span>Size</span><ScoreBar value={sizeBonus} max={3} className="size-fill" /><span>{formatSize(r.size_mb)}</span><span className="ed-sub">+{sizeBonus}pts</span></div>
        <div className="ed-item"><span>Rank</span><ScoreBar value={rankBonus} max={2} className="rank-fill" /><span>#{r.radarr_rank || "-"}</span><span className="ed-sub">+{rankBonus}pts</span></div>
      </div>
      {(audioCodec.length > 0 || audioChannels || r.edition || r.protocol || r.seeders != null || r.release_group) && (
        <div className="cf-list stream-info">
          {audioCodec.map(c => <span key={c} className="format-tag">{c}</span>)}
          {audioChannels && <span className="format-tag">{audioChannels}</span>}
          {r.edition && <span className="format-tag">{r.edition}</span>}
          {r.protocol && <span className="format-tag">{r.protocol === "torrent" ? "Torrent" : "Usenet"}</span>}
          {r.seeders != null && <span className="format-tag tag-seeders">{r.seeders} Seeders</span>}
          {r.leechers != null && <span className="format-tag tag-leechers">{r.leechers} Leechers</span>}
          {r.release_group && <span className="format-tag">{r.release_group}</span>}
        </div>
      )}
      {cf > 0 && r.radarr_custom_formats && (
        <div className="cf-list">
          {r.radarr_custom_formats.map((f: string) => <span key={f} className="format-tag">{f}</span>)}
        </div>
      )}
    </div>
  );
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
  const [searchTerm, setSearchTerm] = useState("");
  const [franchiseTorrents, setFranchiseTorrents] = useState<any[]>([]);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());
  const autoSearchDone = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const loadFranchiseTorrents = useCallback(async () => {
    if (!sonarrId) return;
    try {
      const ts = await fetchFranchiseTorrentStatuses(Number(sonarrId));
      setFranchiseTorrents(Array.isArray(ts) ? ts : []);
    } catch {
      setFranchiseTorrents([]);
    }
  }, [sonarrId]);

  useEffect(() => {
    setLoading(true);
    setSelectedSeason(null);
    autoSearchDone.current = false;
    loadFranchise();
  }, [loadFranchise]);

  useEffect(() => {
    if (!franchise) return;
    loadFranchiseTorrents();
    statusPollRef.current = setInterval(loadFranchiseTorrents, 3000);
    return () => { if (statusPollRef.current) clearInterval(statusPollRef.current); };
  }, [franchise, loadFranchiseTorrents]);

  useEffect(() => {
    if (franchise && !searchTerm) {
      setSearchTerm(franchise.title || "");
    }
  }, [franchise, searchTerm]);

  const runSearchStream = useCallback(async (force: boolean, silent = false) => {
    if (!franchise?.sonarr_id) return;
    if (!silent) setSearchingAll(true);
    if (!silent) setSearchProgress("Searching...");
    try {
      const resp = await fetch(`/api/requests/managed/${franchise.sonarr_id}/search-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force, searchTerm: searchTerm.trim() || undefined }),
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
            if (data.message && !silent) setSearchProgress(data.message);
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
            if (data.totalFound != null && !silent) {
              const msg = `Done — ${data.totalFound} release(s), ${data.seasons || 0} season(s)${data.skipped ? `, ${data.skipped} skipped` : ""}`;
              setSearchProgress(msg);
              setTimeout(() => setSearchProgress(""), 3000);
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
  }, [franchise?.sonarr_id, searchTerm, loadFranchise]);

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

  const handlePause = async (releaseId?: number) => {
    await pauseTorrent(undefined, releaseId);
    loadFranchiseTorrents();
  };

  const handleResume = async (releaseId?: number) => {
    await resumeTorrent(undefined, releaseId);
    loadFranchiseTorrents();
  };

  const handleCopyPath = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

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

      <div className="detail-topbar" style={{ marginBottom: 12 }}>
        <input
          className="search-term-input"
          type="text"
          placeholder="Search term (e.g. 1080p, S01, Complete)..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runSearchStream(true); }}
          style={{ flex: 1 }}
        />
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
          const isExpanded = expandedSeasons.has(season.season);
          const seasonTorrents = franchiseTorrents.filter((t) => t.found && t.season === season.season);
          const epCount = season.episode_count || 0;
          const covered = new Set<number>(season.covered_episodes || []);
          const epGrid = epCount > 0 ? Array.from({ length: epCount }, (_, i) => i + 1) : [];

          return (
            <div key={season.season} className="franchise-season-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", cursor: "pointer", alignItems: "center" }} onClick={() => {
                if (isExpanded) { const next = new Set(expandedSeasons); next.delete(season.season); setExpandedSeasons(next); }
                else { const next = new Set(expandedSeasons); next.add(season.season); setExpandedSeasons(next); }
              }}>
                <div className="fr-season-left">
                  <span className="season-label">S{String(season.season).padStart(2, "0")}</span>
                  <span className={`season-status ${hasReleases ? "has-content" : "empty"}`}>
                    {epCount > 0 ? `${covered.size}/${epCount} episodes` : season.total_candidates > 0 ? `${season.total_candidates} releases` : "no releases"}
                  </span>
                  {isSearching && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px" }}>searching</span>}
                  {hasTorrents && <span className="rtag" style={{ fontSize: 10, padding: "2px 5px", background: season.status === "SEEDING" ? "#2d6a4f" : "#1d6099" }}>{season.status === "SEEDING" ? "SEEDING" : "DOWNLOADING"}</span>}
                  {seasonTorrents.length > 0 && seasonTorrents.some((t: any) => t.progress < 100) && (
                    <span className="rtag" style={{ fontSize: 10, padding: "2px 5px", background: "#1d6099" }}>
                      {seasonTorrents.filter((t: any) => t.progress < 100).reduce((s: number, t: any) => Math.max(s, t.progress), 0)}%
                    </span>
                  )}
                </div>
                <div className="fr-season-right">
                  <span className="rtag">{formatSize(season.total_size_mb)}</span>
                  <button className="btn btn-primary btn-tiny" onClick={(e) => { e.stopPropagation(); setSelectedSeason(season); }} style={{ marginRight: 4 }}>
                    Open Season &rsaquo;
                  </button>
                  <span className="fr-arrow">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                </div>
              </div>
              {isExpanded && (
                <div className="season-expanded-content">
                  {epGrid.length > 0 && (
                    <div className="episode-grid-section">
                      <div className="episode-grid-header">
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Episodes</span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{covered.size}/{epCount} have</span>
                      </div>
                      <div className="episode-grid">
                        {epGrid.map((ep) => (
                          <span key={ep} className={`ep-cell ${covered.has(ep) ? "ep-have" : "ep-missing"}`}>
                            {String(ep).padStart(2, "0")}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {seasonTorrents.length > 0 && (
                    <div className="season-torrents-section">
                      {seasonTorrents.map((ts: any) => (
                        <div key={ts.release_id} className="season-torrent-row">
                          <div className="approved-release-info">
                            <span className={`status-badge status-badge-sm qb-${ts.state}`}>{ts.state}</span>
                            <span className="approved-title" title={ts.title} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{ts.title}</span>
                            {ts.progress < 100 && <span style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{ts.progress}%</span>}
                          </div>
                          {ts.progress < 100 && (
                            <div className="torrent-progress-bar" style={{ marginTop: 4 }}>
                              <div className="torrent-progress-fill" style={{ width: `${ts.progress}%` }} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
  const [approvedReleases, setApprovedReleases] = useState<any[]>([]);

  const [torrentStatuses, setTorrentStatuses] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState("");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"app_score" | "size_mb" | "seeders">("app_score");
  const [filterEpisode, setFilterEpisode] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [moveResults, setMoveResults] = useState<Record<number, any>>({});
  const [moving, setMoving] = useState<number | null>(null);
  const [removeConfirmId, setRemoveConfirmId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "list">("table");
  const [searchMode, setSearchMode] = useState<SearchMode>("season");
  const [processing, setProcessing] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await fetchReleases(season.request_id);
      setReleases(data.releases || []);
      setApprovedReleases(data.approved_releases || []);
      setSearchTerm((prev) => prev || data.title || "");
    } catch {
      // ignore
    }
  }, [season.request_id]);

  const hasAnyTorrent = approvedReleases.some((r: any) => r.torrent_hash);

  const loadTorrentStatuses = useCallback(async () => {
    if (!hasAnyTorrent) { setTorrentStatuses([]); return; }
    try {
      const ts = await fetchTorrentStatuses(season.request_id);
      setTorrentStatuses(Array.isArray(ts) ? ts : []);
    } catch {
      setTorrentStatuses([]);
    }
  }, [season.request_id, hasAnyTorrent]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadTorrentStatuses(); }, [loadTorrentStatuses]);

  useEffect(() => {
    if (!hasAnyTorrent) return;
    const interval = setInterval(loadTorrentStatuses, 3000);
    return () => clearInterval(interval);
  }, [hasAnyTorrent, loadTorrentStatuses]);

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
        setReleases(data.releases || []);
        setApprovedReleases(data.approved_releases || []);
        if (attempts >= 10) clearInterval(poll);
      }, 3000);
    } finally {
      setApprovingId(null);
    }
  };

  const handlePause = async (releaseId?: number) => {
    await pauseTorrent(season.request_id, releaseId);
    loadTorrentStatuses();
  };

  const handleResume = async (releaseId?: number) => {
    await resumeTorrent(season.request_id, releaseId);
    loadTorrentStatuses();
  };

  const handleDismiss = async (releaseId: number) => {
    await dismissRequest(season.request_id, releaseId);
    await loadData();
    setTorrentStatuses([]);
  };

  const handleCopyPath = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  const handleMoveToLibrary = async (releaseId: number) => {
    setMoving(releaseId);
    try {
      const result = await moveToLibrary(season.request_id);
      setMoveResults((prev) => ({ ...prev, [releaseId]: result }));
      if (!result.alreadyExists) loadTorrentStatuses();
    } catch (err: any) {
      setMoveResults((prev) => ({ ...prev, [releaseId]: { error: err?.response?.data?.error || err.message } }));
    } finally {
      setMoving(null);
    }
  };

  const handleProcess = async (releaseId: number) => {
    setProcessing(releaseId);
    try {
      const result = await processToLibrary(season.request_id);
      setMoveResults((prev) => ({ ...prev, [releaseId]: result }));
      loadTorrentStatuses();
    } catch (err: any) {
      setMoveResults((prev) => ({ ...prev, [releaseId]: { error: err?.response?.data?.error || err.message } }));
    } finally {
      setProcessing(null);
    }
  };

  const handleRemoveFromLibrary = async (releaseId: number) => {
    if (removeConfirmId !== releaseId) { setRemoveConfirmId(releaseId); return; }
    try {
      await removeFromLibrary(season.request_id);
      setRemoveConfirmId(null);
      setMoveResults((prev) => ({ ...prev, [releaseId]: null }));
      loadTorrentStatuses();
    } catch (err: any) {
      setRemoveConfirmId(null);
    }
  };

  const filtered = releases
    .filter((r: any) => {
      if (!filterEpisode) return true;
      if (!r.parsed_episodes) return false;
      return r.parsed_episodes.toUpperCase().includes(filterEpisode.toUpperCase());
    })
    .sort((a: any, b: any) => {
      if (sortBy === "app_score") return (b.app_score || 0) - (a.app_score || 0);
      if (sortBy === "size_mb") return (b.size_mb || 0) - (a.size_mb || 0);
      if (sortBy === "seeders") return ((b.seeders ?? 0) - (a.seeders ?? 0));
      return 0;
    });

  const uniqueEpisodes = new Set<string>();
  for (const r of releases) {
    if (r.parsed_episodes) {
      const matches = r.parsed_episodes.match(/E\d{1,3}/g);
      if (matches) matches.forEach((m: string) => uniqueEpisodes.add(m));
    }
  }
  const episodeOptions = Array.from(uniqueEpisodes).sort();

  const tsByRelease = new Map<number, any>();
  for (const ts of torrentStatuses) {
    if (ts.release_id) tsByRelease.set(ts.release_id, ts);
  }

  return (
    <div className="container">
      {approvedReleases.length > 0 && approvedReleases.map((ar: any) => {
        const ts = tsByRelease.get(ar.id);
        const mr = moveResults[ar.id];
        const isMoving = moving === ar.id;
        const isRemoveConfirm = removeConfirmId === ar.id;

        if (!ar.torrent_hash) return null;
        if (ts && !ts.found) return null;

        return (
          <div key={ar.id} className="torrent-panel">
            <div className="approved-release-info">
              <span className="approved-label">Installed</span>
              <span className="approved-title" title={ar.title}>
                {ar.info_url ? <a href={ar.info_url} target="_blank" rel="noopener noreferrer">{ar.title}</a> : ar.title}
              </span>
              <span className="rtag">{ar.radarr_quality || ar.quality}</span>
              <span className="rtag">{formatSize(ar.size_mb)}</span>
              {ts?.found && <span className={`status-badge status-badge-sm qb-${ts.state}`}>{ts.state}</span>}
            </div>
            {ts?.found ? (
              <>
                <div className="torrent-progress-bar">
                  <div className="torrent-progress-fill" style={{ width: `${ts.progress}%` }} />
                </div>
                <div className="torrent-stats-grid">
                  <div className="ts-item ts-primary">
                    <span className="ts-value">{ts.progress}%</span>
                  </div>
                  {ts.state === "downloading" && (
                    <div className="ts-item ts-speed">
                      <span className="ts-icon">↓</span>
                      <span className="ts-value">{(ts.dlspeed / 1024 / 1024).toFixed(1)} MB/s</span>
                    </div>
                  )}
                  {ts.state === "downloading" && ts.eta > 0 && ts.eta < 8640000 && (
                    <div className="ts-item">
                      <span className="ts-label">ETA</span>
                      <span className="ts-value">{formatDuration(ts.eta)}</span>
                    </div>
                  )}
                  <div className="ts-item ts-speed">
                    <span className="ts-icon">↑</span>
                    <span className="ts-value">{(ts.upspeed / 1024 / 1024).toFixed(1)} MB/s</span>
                  </div>
                  <div className="ts-item">
                    <span className="ts-label">Ratio</span>
                    <span className="ts-value">{ts.ratio.toFixed(2)}</span>
                  </div>
                  <div className="ts-item">
                    <span className="ts-label">Uploaded</span>
                    <span className="ts-value">{formatBytes(ts.uploaded || 0)}</span>
                  </div>
                  <div className="ts-item">
                    <span className="ts-label">Peers</span>
                    <span className="ts-value"><span className="ts-seed">{ts.num_seeds}</span>/<span className="ts-leech">{ts.num_leechs + ts.num_seeds}</span></span>
                  </div>
                  {ts.completion_on > 0 && (ts.state === "uploading" || ts.state === "stalledUP" || ts.state === "forcedUP" || ts.state === "queuedUP" || ts.state === "pausedUP") && (
                    <div className="ts-item">
                      <span className="ts-label">Seeding</span>
                      <span className="ts-value">{formatDuration(ts.seeding_time || 0)}</span>
                    </div>
                  )}
                  {ts.progress === 100 && (
                    <div className="ts-item ts-actions">
                      {ts.state === "stalledUP" || ts.state === "uploading" || ts.state === "forcedUP" || ts.state === "queuedUP" ? (
                        <button className="btn btn-secondary btn-tiny" onClick={() => handlePause(ar.id)}>Pause</button>
                      ) : (
                        <button className="btn btn-secondary btn-tiny" onClick={() => handleResume(ar.id)}>Resume</button>
                      )}
                    </div>
                  )}
                </div>
                {ts.progress === 100 && (
                  <div className="torrent-paths">
                    <div className="torrent-path-row">
                      <span className="path-label">Source:</span>
                      <span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(ts.content_path)}>{ts.content_path}</span>
                      <button className="btn btn-danger btn-tiny" onClick={() => handleDismiss(ar.id)}>Delete</button>
                    </div>
                    <div className="torrent-path-row">
                      <span className="path-label">Library:</span>
                      {ts.in_library ? (
                        <>
                          <span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(ts.library_path)}>{ts.library_path}</span>
                          <button className={`btn btn-tiny ${isRemoveConfirm ? "btn-danger" : "btn-library-ok"}`} onClick={() => handleRemoveFromLibrary(ar.id)}>
                            {isRemoveConfirm ? "Remove?" : "In Library"}
                          </button>
                        </>
                      ) : mr?.source ? (
                        <span className="move-result"><span>Hardlinked →</span><span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(mr.destination)}>{mr.destination}</span></span>
                      ) : mr?.error ? (
                        <span className="move-error">{mr.error}</span>
                      ) : (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button className="btn btn-primary btn-tiny" onClick={() => handleMoveToLibrary(ar.id)} disabled={isMoving}>
                            {isMoving ? "Moving..." : "Move to Library"}
                          </button>
                          <button className="btn btn-secondary btn-tiny" onClick={() => handleProcess(ar.id)} disabled={processing !== null}>
                            {processing === ar.id ? "Processing..." : "Process"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="torrent-meta"><span>Waiting for qBittorrent...</span></div>
            )}
          </div>
        );
      })}

      <div className="detail-topbar">
        <button className="btn btn-secondary btn-tiny" onClick={onBack}>&larr; {franchise.title}</button>
        <div className="detail-title">
          <span className="detail-title-text">{franchise.title}</span>
          <span className="rtag">S{String(season.season).padStart(2, "0")}</span>
        </div>
        <div className="search-mode-toggle">
          {SEARCH_MODES.map((m) => (
            <button key={m} className={`btn btn-tiny ${searchMode === m ? "btn-primary" : "btn-secondary"}`} onClick={() => setSearchMode(m)}>
              {m === "season" ? "Season" : "Episodes"}
            </button>
          ))}
        </div>
        <input
          className="search-term-input"
          type="text"
          placeholder={searchMode === "season" ? "Search season pack..." : "e.g. S02E05 1080p..."}
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

      <div className="release-toolbar">
        <div className="toolbar-filters">
          {episodeOptions.length > 0 && (
            <select value={filterEpisode} onChange={(e) => setFilterEpisode(e.target.value)}>
              <option value="">All episodes</option>
              {episodeOptions.map((ep) => <option key={ep} value={ep}>{ep}</option>)}
            </select>
          )}
        </div>
        <div className="toolbar-right">
          <span className="release-count">{filtered.length}/{releases.length}</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button className={`btn btn-tiny ${sortBy === "app_score" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("app_score")}>Score</button>
            <button className={`btn btn-tiny ${sortBy === "size_mb" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("size_mb")}>Size</button>
            <button className={`btn btn-tiny ${sortBy === "seeders" ? "btn-primary" : "btn-secondary"}`} onClick={() => setSortBy("seeders")}>Seeders</button>
          </div>
          <div className="view-toggle">
            <button className={`vt-btn ${viewMode === "table" ? "active" : ""}`} onClick={() => setViewMode("table")} title="Table">=</button>
            <button className={`vt-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} title="List">≡</button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state"><p>{releases.length === 0 ? "No releases found. Click Search above." : "No matches for this filter."}</p></div>
      ) : viewMode === "table" ? (
        <div className="table-wrap">
          <table className="release-table">
            <thead>
              <tr>
                {([
                  { key: null, label: "Ep", cls: "" },
                  { key: null, label: "Title", cls: "" },
                  { key: null, label: "Q", cls: "" },
                  { key: null, label: "Size", cls: "" },
                  { key: null, label: "Indexer", cls: "" },
                  { key: "seeders" as const, label: "S/L", cls: "th-sl" },
                  { key: "app_score" as const, label: "Score", cls: "th-score" },
                  { key: null, label: "", cls: "th-act" },
                ]).map((col) => (
                  <th
                    key={col.label + col.cls}
                    className={`${col.cls} ${col.key ? "th-sortable" : ""} ${sortBy === col.key ? "th-active" : ""}`}
                    onClick={col.key ? () => setSortBy(col.key!) : undefined}
                  >
                    {col.label}
                    {col.key && sortBy === col.key && <span className="sort-arrow">{"\u25B2"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: any) => {
                const isExpanded = expandedIds.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr className={isExpanded ? "row-expanded" : ""} onClick={() => { const next = new Set(expandedIds); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); setExpandedIds(next); }}>
                      <td className="td-ep">{r.parsed_episodes || "-"}</td>
                      <td className="td-title">
                        {r.info_url ? <a href={r.info_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={r.title}>{r.title}</a> : <span title={r.title}>{r.title}</span>}
                      </td>
                      <td><span className="rtag">{r.quality || r.radarr_quality}</span></td>
                      <td className="td-size">{formatSize(r.size_mb)}</td>
                      <td className="td-indexer">{r.indexer}</td>
                      <td className="td-sl">{r.seeders != null ? <><span className="sl-seed">{r.seeders}</span>/<span className="sl-leech">{r.leechers ?? 0}</span></> : "-"}</td>
                      <td className="td-score">{r.app_score}/20</td>
                      <td className="td-act" onClick={(e) => e.stopPropagation()}>
                        {!r.approved ? (
                          <button className="btn btn-primary btn-tiny" onClick={() => handleApprove(r.id)} disabled={approvingId !== null}>
                            {approvingId === r.id ? "Approving..." : "Approve"}
                          </button>
                        ) : (
                          <span className="rtag" style={{ background: "#2d6a4f" }}>APPROVED</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="expanded-row">
                        <td colSpan={8}>
                          <Breakdown r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="releases-list">
          {filtered.map((r: any) => {
            const isExpanded = expandedIds.has(r.id);
            return (
              <div key={r.id} className={`release-card ${isExpanded ? "expanded" : ""}`}>
                <div className="release-row" onClick={() => { const next = new Set(expandedIds); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); setExpandedIds(next); }}>
                  <div className="release-main">
                    <div className="release-info">
                      {r.info_url ? (
                        <a href={r.info_url} target="_blank" rel="noopener noreferrer" className="release-title" onClick={(e) => e.stopPropagation()} title={r.title}>{r.title}</a>
                      ) : (
                        <span className="release-title" title={r.title}>{r.title}</span>
                      )}
                      <div className="release-tags">
                        {r.parsed_episodes && <span className="rtag">{r.parsed_episodes}</span>}
                        <span className="rtag">{r.quality || r.radarr_quality}</span>
                        <span className="rtag">{formatSize(r.size_mb)}</span>
                        {r.seeders != null && <span className="rtag">{r.seeders}s/{r.leechers ?? 0}l</span>}
                        {r.indexer && <span className="rtag">{r.indexer}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="release-right">
                    <div className="score-pill">
                      <span className="score-num">{r.app_score}</span>
                      <span className="score-of">/20</span>
                    </div>
                    {!r.approved && (
                      <button className="btn btn-primary btn-tiny" onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }} disabled={approvingId !== null}>
                        {approvingId === r.id ? "Approving..." : "Approve"}
                      </button>
                    )}
                    {r.approved && (
                      <span className="rtag" style={{ background: "#2d6a4f" }}>APPROVED</span>
                    )}
                  </div>
                </div>
                {isExpanded && <Breakdown r={r} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
