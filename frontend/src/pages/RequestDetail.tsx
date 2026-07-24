import { useEffect, useState, Fragment } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchReleases, approveRelease, searchAgain, fetchTorrentStatuses, moveToLibrary, dismissRequest, removeFromLibrary, pauseTorrent, resumeTorrent } from "../api";

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

function getQualityScore(quality: string): number {
  const q = quality.toUpperCase();
  if (q.includes("REMUX-2160") || q.includes("REMUX2160")) return 10;
  if (q.includes("BR-DISK") || q.includes("BLURAY-2160")) return 9;
  if (q.includes("WEB-DL-2160") || q.includes("WEBDL-2160")) return 8;
  if (q.includes("WEBRIP-2160") || q.includes("WEBRIP2160")) return 7;
  if (q.includes("HDTV-2160")) return 6;
  if (q.includes("REMUX-1080") || q.includes("REMUX1080")) return 6;
  if (q.includes("BLURAY-1080")) return 5;
  if (q.includes("WEB-DL-1080") || q.includes("WEBDL-1080")) return 4;
  if (q.includes("WEBRIP-1080") || q.includes("WEBRIP1080")) return 3;
  if (q.includes("HDTV-1080")) return 2;
  if (q.includes("WEB-DL-720")) return 1;
  if (q.includes("2160")) return 7;
  if (q.includes("1080")) return 4;
  if (q.includes("720")) return 1;
  return 0;
}

type SortKey = "app_score" | "radarr_rank" | "size_mb" | "radarr_quality" | "seeders" | "indexer" | "language" | "radarr_custom_formats";
type SortDir = "asc" | "desc";
type FilterQuality = "ALL" | "2160p" | "1080p" | "720p" | "CAM/TS";
type ViewMode = "list" | "table";
type ScoreProfile = "balanced" | "max_quality" | "compact" | "remux_only";

const PROFILES: Record<ScoreProfile, { label: string; desc: string }> = {
  balanced: { label: "Balanced", desc: "Sweet spot size + quality + CF + rank" },
  max_quality: { label: "Max Quality", desc: "Favor bigger files, Remux, no size penalty" },
  compact: { label: "Compact", desc: "Favor smaller encodes under 15 GB" },
  remux_only: { label: "Remux Only", desc: "Only Remux / BR-DISK get high scores" },
};

function computeProfileScore(r: any, profile: ScoreProfile): number {
  const qs = getQualityScore(r.radarr_quality);
  const cf = r.radarr_custom_formats?.length || 0;
  const cfBonus = Math.min(5, cf);
  const rankBonus = r.radarr_rank === 1 ? 2 : r.radarr_rank <= 3 ? 1 : 0;

  switch (profile) {
    case "balanced": {
      const sizeBonus = r.size_mb >= 1000 && r.size_mb <= 15000 ? 3 : r.size_mb >= 500 && r.size_mb <= 25000 ? 2 : r.size_mb > 0 ? 1 : 0;
      return qs + cfBonus + sizeBonus + rankBonus;
    }
    case "max_quality": {
      // Remux/BR-DISK get full marks, size doesn't penalize
      const sizeBonus = r.size_mb > 20000 ? 3 : r.size_mb > 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      return qs + cfBonus + sizeBonus + rankBonus;
    }
    case "compact": {
      // Sweet spot 500MB-5GB gets max size points, larger = less points
      const sizeBonus = r.size_mb >= 500 && r.size_mb <= 5000 ? 3 : r.size_mb >= 200 && r.size_mb <= 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      // Penalize huge files
      const sizePenalty = r.size_mb > 25000 ? -2 : r.size_mb > 15000 ? -1 : 0;
      return Math.max(0, qs + cfBonus + sizeBonus + rankBonus + sizePenalty);
    }
    case "remux_only": {
      // Only Remux/BR-DISK get quality points, everything else capped low
      const isRemux = r.radarr_quality.toUpperCase().includes("REMUX") || r.radarr_quality.toUpperCase().includes("BR-DISK");
      const q = isRemux ? qs : Math.min(qs, 4);
      const sizeBonus = r.size_mb > 20000 ? 3 : r.size_mb > 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      return q + cfBonus + sizeBonus + rankBonus;
    }
  }
}

function parseAudioChannels(title: string): string {
  const m = title.match(/\b(\d\.\d)\b/);
  return m ? m[1] : "";
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
  if (t.includes("LPCM") || t.includes("LPCM")) codecs.push("LPCM");
  if (t.includes("PCM")) codecs.push("PCM");
  return codecs;
}

function ScoreBar({ value, max, className }: { value: number; max: number; className?: string }) {
  return (
    <div className="ed-bar">
      <div className={`ed-fill ${className || ""}`} style={{ width: `${(value / max) * 100}%` }} />
    </div>
  );
}

function Breakdown({ r, profile }: { r: any; profile: ScoreProfile }) {
  const qs = getQualityScore(r.radarr_quality);
  const cf = r.radarr_custom_formats?.length || 0;
  const cfBonus = Math.min(5, cf);
  const rankBonus = r.radarr_rank === 1 ? 2 : r.radarr_rank <= 3 ? 1 : 0;

  let sizeBonus: number;
  let sizeNote = "";
  switch (profile) {
    case "balanced":
      sizeBonus = r.size_mb >= 1000 && r.size_mb <= 15000 ? 3 : r.size_mb >= 500 && r.size_mb <= 25000 ? 2 : r.size_mb > 0 ? 1 : 0;
      break;
    case "max_quality":
      sizeBonus = r.size_mb > 20000 ? 3 : r.size_mb > 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      sizeNote = "larger = better";
      break;
    case "compact":
      sizeBonus = r.size_mb >= 500 && r.size_mb <= 5000 ? 3 : r.size_mb >= 200 && r.size_mb <= 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      const penalty = r.size_mb > 25000 ? -2 : r.size_mb > 15000 ? -1 : 0;
      if (penalty < 0) sizeNote = `${penalty} penalty`;
      break;
    case "remux_only":
      sizeBonus = r.size_mb > 20000 ? 3 : r.size_mb > 10000 ? 2 : r.size_mb > 0 ? 1 : 0;
      break;
    default:
      sizeBonus = 0;
  }

  const isRemux = r.radarr_quality.toUpperCase().includes("REMUX") || r.radarr_quality.toUpperCase().includes("BR-DISK");
  const effectiveQs = profile === "remux_only" && !isRemux ? Math.min(qs, 4) : qs;

  const audioCodec = parseAudioCodec(r.title);
  const audioChannels = parseAudioChannels(r.title);

  return (
    <div className="expanded-detail">
      <div className="ed-grid">
        <div className="ed-item"><span>Quality</span><ScoreBar value={effectiveQs} max={10} /><span>{effectiveQs}/10</span><span className="ed-sub">{r.radarr_quality}{profile === "remux_only" && !isRemux ? " (capped)" : ""}</span></div>
        <div className="ed-item"><span>CF</span><ScoreBar value={cf} max={5} className="cf-fill" /><span>{cf}</span><span className="ed-sub">+{cfBonus}pts</span></div>
        <div className="ed-item"><span>Size</span><ScoreBar value={Math.max(0, sizeBonus)} max={3} className="size-fill" /><span>{formatSize(r.size_mb)}</span><span className="ed-sub">+{sizeBonus}pts{sizeNote ? ` (${sizeNote})` : ""}</span></div>
        <div className="ed-item"><span>Rank</span><ScoreBar value={rankBonus} max={2} className="rank-fill" /><span>#{r.radarr_rank}</span><span className="ed-sub">+{rankBonus}pts</span></div>
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
      {cf > 0 && (
        <div className="cf-list">
          {r.radarr_custom_formats.map((f: string) => <span key={f} className="format-tag">{f}</span>)}
        </div>
      )}
    </div>
  );
}

export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [request, setRequest] = useState<any>(null);
  const [releases, setReleases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [sortBy, setSortBy] = useState<SortKey>("app_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterQuality, setFilterQuality] = useState<FilterQuality>("ALL");
  const [filterIndexer, setFilterIndexer] = useState("ALL");
  const [filterLanguage, setFilterLanguage] = useState("ALL");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [scoreProfile, setScoreProfile] = useState<ScoreProfile>("balanced");
  const [torrentStatuses, setTorrentStatuses] = useState<any[]>([]);
  const [approvedReleases, setApprovedReleases] = useState<any[]>([]);
  const [moveResults, setMoveResults] = useState<Record<number, any>>({});
  const [moving, setMoving] = useState<number | null>(null);
  const [removeConfirmId, setRemoveConfirmId] = useState<number | null>(null);
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const loadData = async (initial = false) => {
    try {
      if (initial) setLoading(true);
      const data = await fetchReleases(Number(id));
      setRequest(data);
      setReleases(data.releases || []);
      setApprovedReleases(data.approved_releases || []);
      setError(null);
    } catch (err) {
      setError("Failed to load releases");
      console.error(err);
    } finally {
      if (initial) setLoading(false);
    }
  };

  const hasAnyTorrent = approvedReleases.some((r: any) => r.torrent_hash);

  const loadTorrentStatuses = async () => {
    if (!request || !hasAnyTorrent) {
      setTorrentStatuses([]);
      return;
    }
    try {
      const statuses = await fetchTorrentStatuses(Number(id));
      setTorrentStatuses(Array.isArray(statuses) ? statuses : []);
    } catch {
      setTorrentStatuses([]);
    }
  };

  useEffect(() => { loadData(true); }, [id]);
  useEffect(() => { loadTorrentStatuses(); }, [id, hasAnyTorrent]);

  // Poll torrent status while we have active torrents
  useEffect(() => {
    if (!hasAnyTorrent) return;
    const interval = setInterval(loadTorrentStatuses, 3000);
    return () => clearInterval(interval);
  }, [id, hasAnyTorrent]);

  const handleApprove = async (releaseId: number) => {
    setApprovingId(releaseId);
    try {
      await approveRelease(Number(id), releaseId);
      loadData();
      let attempts = 0;
      const pollHash = setInterval(async () => {
        attempts++;
        const data = await fetchReleases(Number(id));
        const hasHash = (data.approved_releases || []).some((r: any) => r.torrent_hash);
        if (hasHash || attempts >= 10) {
          clearInterval(pollHash);
          setRequest(data);
          setReleases(data.releases || []);
          setApprovedReleases(data.approved_releases || []);
        }
      }, 3000);
    } finally {
      setApprovingId(null);
    }
  };

  const handleSearchAgain = async () => {
    setRequest((prev: any) => prev ? { ...prev, status: "SEARCHING" } : prev);
    await searchAgain(Number(id), searchTerm ? { searchTerm } : {});
    loadData();
  };

  const handleCopyPath = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
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
      const result = await moveToLibrary(Number(id));
      setMoveResults((prev) => ({ ...prev, [releaseId]: result }));
      if (!result.alreadyExists) loadData();
    } catch (err: any) {
      setMoveResults((prev) => ({ ...prev, [releaseId]: { error: err?.response?.data?.error || err.message } }));
    } finally {
      setMoving(null);
    }
  };

  const handleDismiss = async (releaseId?: number) => {
    if (!confirm("Delete torrent and all files? This cannot be undone.")) return;
    await dismissRequest(Number(id), releaseId);
    loadData();
  };

  const handleRemoveFromLibrary = async (releaseId: number) => {
    if (removeConfirmId !== releaseId) {
      setRemoveConfirmId(releaseId);
      return;
    }
    try {
      await removeFromLibrary(Number(id));
      setRemoveConfirmId(null);
      setMoveResults((prev) => ({ ...prev, [releaseId]: null }));
      loadTorrentStatuses();
    } catch (err: any) {
      alert(err?.response?.data?.error || err.message);
      setRemoveConfirmId(null);
    }
  };

  const handlePause = async (releaseId: number) => {
    await pauseTorrent(Number(id), releaseId);
    loadTorrentStatuses();
  };

  const handleResume = async (releaseId: number) => {
    await resumeTorrent(Number(id), releaseId);
    loadTorrentStatuses();
  };

  if (loading) return <div className="container"><p>Loading...</p></div>;
  if (error) return <div className="container error"><p>{error}</p></div>;
  if (!request) return <div className="container"><p>Not found</p></div>;

  const indexers = [...new Set(releases.map((r: any) => r.indexer))].sort();
  const allLangs = releases.flatMap((r: any) => r.language ? r.language.split(", ") : []).filter(Boolean);
  const languages = [...new Set(allLangs)].sort();

  const filtered = releases
    .filter((r: any) => {
      if (filterQuality === "ALL") return true;
      const q = (r.radarr_quality || "").toUpperCase();
      if (filterQuality === "2160p") return q.includes("2160") || q.includes("BR-DISK");
      if (filterQuality === "1080p") return q.includes("1080");
      if (filterQuality === "720p") return q.includes("720");
      if (filterQuality === "CAM/TS") return q.includes("CAM") || q.includes("TELESYNC") || q.includes("TELECINE") || q.includes("SCR");
      return true;
    })
    .filter((r: any) => filterIndexer === "ALL" || r.indexer === filterIndexer)
    .filter((r: any) => {
      if (filterLanguage === "ALL") return true;
      if (r.language && r.language.includes(filterLanguage)) return true;
      const titleUpper = r.title.toUpperCase();
      if (titleUpper.includes("MULTI")) return true;
      if (titleUpper.includes(filterLanguage.toUpperCase())) return true;
      return false;
    })
    .sort((a: any, b: any) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortBy) {
        case "app_score": return (computeProfileScore(b, scoreProfile) - computeProfileScore(a, scoreProfile)) * dir;
        case "radarr_rank": return (a.radarr_rank - b.radarr_rank) * dir;
        case "size_mb": return (b.size_mb - a.size_mb) * dir;
        case "radarr_quality": return (getQualityScore(b.radarr_quality) - getQualityScore(a.radarr_quality)) * dir;
        case "seeders": return ((b.seeders ?? 0) - (a.seeders ?? 0)) * dir;
        case "indexer": return (a.indexer || "").localeCompare(b.indexer || "") * dir;
        case "language": return (a.language || "").localeCompare(b.language || "") * dir;
        case "radarr_custom_formats": return ((b.radarr_custom_formats?.length || 0) - (a.radarr_custom_formats?.length || 0)) * dir;
        default: return 0;
      }
    });

  return (
    <div className="container">
      {approvedReleases.length > 0 && approvedReleases.map((ar: any) => {
        const ts = torrentStatuses.find((s: any) => s.release_id === ar.id);
        const mr = moveResults[ar.id];
        const isMoving = moving === ar.id;
        const isRemoveConfirm = removeConfirmId === ar.id;
        const hasTorrentAr = !!ar.torrent_hash;

        if (!hasTorrentAr) return null;

        // Don't render card if torrent was deleted from qBittorrent (stale hash)
        const tsEntry = torrentStatuses.find((s: any) => s.release_id === ar.id);
        if (tsEntry && !tsEntry.found) return null;

        return (
          <div key={ar.id} className="torrent-panel">
            <div className="approved-release-info">
              <span className="approved-label">Installed</span>
              <span className="approved-title" title={ar.title}>
                {ar.info_url
                  ? <a href={ar.info_url} target="_blank" rel="noopener noreferrer">{ar.title}</a>
                  : ar.title}
              </span>
              <span className="rtag">{ar.radarr_quality}</span>
              <span className="rtag">{formatSize(ar.size_mb)}</span>
              {ts?.found && (
                <span className={`status-badge status-badge-sm qb-${ts.state}`}>
                  {ts.state}
                </span>
              )}
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
                  {ts.completion_on > 0 && (
                    <div className="ts-item">
                      <span className="ts-label">Seeding</span>
                      <span className="ts-value">{formatDuration((Date.now() / 1000) - ts.completion_on)}</span>
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
                      <span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(ts.content_path)}>
                        {ts.content_path}
                      </span>
                      <button className="btn btn-danger btn-tiny" onClick={() => handleDismiss(ar.id)}>Delete</button>
                    </div>
                    <div className="torrent-path-row">
                      <span className="path-label">Library:</span>
                      {ts.in_library ? (
                        <>
                          <span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(ts.library_path)}>
                            {ts.library_path}
                          </span>
                          <button className={`btn btn-tiny ${isRemoveConfirm ? "btn-danger" : "btn-library-ok"}`} onClick={() => handleRemoveFromLibrary(ar.id)}>
                            {isRemoveConfirm ? "Remove?" : "In Library"}
                          </button>
                        </>
                      ) : mr?.source ? (
                        <span className="move-result">
                          <span>Hardlinked →</span>
                          <span className="torrent-path" title="Click to copy" onClick={() => handleCopyPath(mr.destination)}>{mr.destination}</span>
                        </span>
                      ) : mr?.error ? (
                        <span className="move-error">{mr.error}</span>
                      ) : (
                        <button className="btn btn-primary btn-tiny" onClick={() => handleMoveToLibrary(ar.id)} disabled={isMoving}>
                          {isMoving ? "Moving..." : "Move to Library"}
                        </button>
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

      {request.status === "DISMISSED" && !hasAnyTorrent && (
        <div className="torrent-panel">
          <div className="torrent-meta"><span>Dismissed</span></div>
        </div>
      )}

      <div className="detail-topbar">
        <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")}>Back</button>
        <div className="detail-title">
          <span className="detail-title-text">{request.title}</span>
        </div>
        <input
          className="search-term-input"
          type="text"
          placeholder="Search term..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSearchAgain(); }}
        />
        <button className="btn btn-primary btn-tiny" onClick={handleSearchAgain}>Refresh</button>
      </div>

      <div className="release-toolbar">
        <div className="toolbar-filters">
          <select value={scoreProfile} onChange={(e) => setScoreProfile(e.target.value as ScoreProfile)} title={PROFILES[scoreProfile].desc}>
            {Object.entries(PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterQuality} onChange={(e) => setFilterQuality(e.target.value as FilterQuality)}>
            <option value="ALL">Quality</option>
            <option value="2160p">2160p</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="CAM/TS">CAM</option>
          </select>
          {languages.length > 1 && (
            <select value={filterLanguage} onChange={(e) => setFilterLanguage(e.target.value)}>
              <option value="ALL">Lang</option>
              {languages.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          {indexers.length > 1 && (
            <select value={filterIndexer} onChange={(e) => setFilterIndexer(e.target.value)}>
              <option value="ALL">Indexer</option>
              {indexers.map((idx) => <option key={idx} value={idx}>{idx}</option>)}
            </select>
          )}
        </div>
        <div className="toolbar-right">
          <span className="release-count">{filtered.length}/{releases.length}</span>
          <div className="view-toggle">
            <button className={`vt-btn ${viewMode === "table" ? "active" : ""}`} onClick={() => setViewMode("table")} title="Table">=</button>
            <button className={`vt-btn ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} title="List">≡</button>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state"><p>No matches</p></div>
      ) : viewMode === "table" ? (
        <div className="table-wrap">
          <table className="release-table">
            <thead>
              <tr>
                {([
                  { key: "radarr_rank" as SortKey, label: "#", cls: "th-rank" },
                  { key: null, label: "Title", cls: "" },
                  { key: "radarr_quality" as SortKey, label: "Q", cls: "" },
                  { key: "size_mb" as SortKey, label: "Size", cls: "" },
                  { key: "language" as SortKey, label: "Lang", cls: "" },
                  { key: "indexer" as SortKey, label: "Indexer", cls: "" },
                  { key: "seeders" as SortKey, label: "S/L", cls: "th-sl" },
                  { key: "radarr_custom_formats" as SortKey, label: "CF", cls: "" },
                  { key: "app_score" as SortKey, label: "Score", cls: "th-score" },
                  { key: null, label: "", cls: "th-act" },
                ]).map((col) => (
                  <th
                    key={col.label + col.cls}
                    className={`${col.cls} ${col.key ? "th-sortable" : ""} ${sortBy === col.key ? "th-active" : ""}`}
                    onClick={col.key ? () => {
                      if (sortBy === col.key) {
                        setSortDir((d) => d === "asc" ? "desc" : "asc");
                      } else {
                        setSortBy(col.key);
                        setSortDir(col.key === "radarr_rank" ? "asc" : "desc");
                      }
                    } : undefined}
                  >
                    {col.label}
                    {col.key && sortBy === col.key && <span className="sort-arrow">{sortDir === "asc" ? " ▲" : " ▼"}</span>}
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
                      <td className="td-rank">{r.radarr_rank}</td>
                      <td className="td-title">
                        {r.info_url ? <a href={r.info_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={r.title}>{r.title}</a> : <span title={r.title}>{r.title}</span>}
                      </td>
                      <td><span className="rtag">{r.radarr_quality}</span></td>
                      <td className="td-size">{formatSize(r.size_mb)}</td>
                      <td className="td-lang">{r.language ? r.language.split(", ").map((l: string) => <span key={l} className="rtag rtag-lang">{l}</span>) : "-"}</td>
                      <td className="td-indexer">{r.indexer}</td>
                      <td className="td-sl">{r.seeders != null ? <><span className="sl-seed">{r.seeders}</span>/<span className="sl-leech">{r.leechers ?? 0}</span></> : "-"}</td>
                      <td className="td-cf">{r.radarr_custom_formats?.length || 0}</td>
                      <td className="td-score">{computeProfileScore(r, scoreProfile)}/{scoreProfile === "compact" ? "17" : "20"}</td>
                      <td className="td-act" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-primary btn-tiny" onClick={() => handleApprove(r.id)} disabled={approvingId !== null}>
                          {approvingId === r.id ? "Approving..." : "Approve"}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="expanded-row">
                        <td colSpan={10}>
                          <Breakdown r={r} profile={scoreProfile} />
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
            const cf = r.radarr_custom_formats?.length || 0;

            return (
              <div key={r.id} className={`release-card ${isExpanded ? "expanded" : ""}`}>
                <div className="release-row" onClick={() => { const next = new Set(expandedIds); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); setExpandedIds(next); }}>
                  <div className="release-main">
                    <div className="release-rank">#{r.radarr_rank}</div>
                    <div className="release-info">
                      {r.info_url ? <a href={r.info_url} target="_blank" rel="noopener noreferrer" className="release-title" onClick={(e) => e.stopPropagation()} title={r.title}>{r.title}</a> : <span className="release-title" title={r.title}>{r.title}</span>}
                      <div className="release-tags">
                        <span className="rtag">{r.radarr_quality}</span>
                        <span className="rtag">{formatSize(r.size_mb)}</span>
                        {r.language && r.language.split(", ").map((l: string) => <span key={l} className="rtag rtag-lang">{l}</span>)}
                        <span className="rtag">{r.indexer}</span>
                        {cf > 0 && <span className="rtag rtag-cf">{cf}CF</span>}
                      </div>
                    </div>
                  </div>
                  <div className="release-right">
                    <div className="score-pill">
                      <span className="score-num">{computeProfileScore(r, scoreProfile)}</span>
                      <span className="score-of">/{scoreProfile === "compact" ? "17" : "20"}</span>
                    </div>
                    <button className="btn btn-primary btn-tiny" onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }} disabled={approvingId !== null}>
                      {approvingId === r.id ? "Approving..." : "Approve"}
                    </button>
                  </div>
                </div>
                {isExpanded && <Breakdown r={r} profile={scoreProfile} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
