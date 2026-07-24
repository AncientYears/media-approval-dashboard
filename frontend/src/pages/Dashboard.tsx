import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRequests, fetchManaged, searchAgain, cleanupStaleRequests, dismissRequest, detectTorrents, importMissingRequests } from "../api";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const STATUS_OPTIONS = ["ALL", "NEW", "SEARCHING", "AWAITING_APPROVAL", "DOWNLOADING"];
const TYPE_OPTIONS = ["ALL", "movie", "series"];
const SORT_OPTIONS = [
  { value: "created_at_desc", label: "Newest first" },
  { value: "created_at_asc", label: "Oldest first" },
  { value: "title_asc", label: "Title A-Z" },
  { value: "title_desc", label: "Title Z-A" },
  { value: "status_asc", label: "Status (pending first)" },
];

const STATUS_ORDER: Record<string, number> = {
  AWAITING_APPROVAL: 0,
  SEARCHING: 1,
  NEW: 2,
  DOWNLOADING: 3,
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<any[]>([]);
  const [managed, setManaged] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("status_asc");

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [reqData, managedData] = await Promise.all([fetchRequests(), fetchManaged()]);
      setRequests(reqData);
      setManaged(managedData);
      setError(null);
    } catch (err) {
      setError("Failed to load requests");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    cleanupStaleRequests().then(() => loadData());
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const requestsList = requests
    .filter((r: any) => !r.has_torrent)
    .filter((r: any) => statusFilter === "ALL" || r.status === statusFilter)
    .filter((r: any) => typeFilter === "ALL" || r.type === typeFilter)
    .sort((a: any, b: any) => {
      switch (sortBy) {
        case "created_at_desc": return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "created_at_asc": return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "title_asc": return a.title.localeCompare(b.title);
        case "title_desc": return b.title.localeCompare(a.title);
        case "status_asc": return (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        default: return 0;
      }
    });

  if (loading && requests.length === 0) {
    return <div className="container"><p>Loading requests...</p></div>;
  }

  if (error) {
    return <div className="container error"><p>{error}</p></div>;
  }

  return (
    <div className="container">
      <div className="filter-bar">
        <div className="filter-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "ALL" ? "All Statuses" : s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t === "ALL" ? "All Types" : t}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Sort</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <button className="btn btn-secondary btn-tiny" onClick={async () => {
            const result = await detectTorrents();
            let msg = `Detected ${result.detected} torrent(s) out of ${result.total} pending request(s).`;
            if (result.matches && result.matches.length > 0) {
              msg += "\n\n" + result.matches.map((m: any) => `"${m.request_title}" → ${m.torrent_name}`).join("\n");
            }
            alert(msg);
            loadData();
          }}>Detect Torrents</button>
          <button className="btn btn-secondary btn-tiny" onClick={async () => {
            const result = await importMissingRequests();
            let msg = `Imported ${result.imported} new request(s).`;
            if (result.skippedItems && result.skippedItems.length > 0) {
              msg += `\n\nSkipped ${result.skipped} (already in DB):`;
              for (const s of result.skippedItems) {
                msg += `\n• ${s.title} (${s.reason})`;
              }
            }
            alert(msg);
            loadData();
          }}>Import Missing</button>
        </div>
      </div>

      {requestsList.length > 0 && (
        <div className="dashboard-section">
          <h3>Requests — {requestsList.length}</h3>
          <div className="requests-grid">
            {requestsList.map((req: any) => (
              <div key={req.id} className="request-card">
                <div className="request-header">
                  <h3>{req.title}</h3>
                  <span className={`status-badge ${req.status.toLowerCase()}`}>
                    {req.status.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="request-meta">
                  Type: <strong>{req.type}</strong>
                  {req.type === "series" && req.season != null && <> · Season {req.season}</>}
                  {" · "}{new Date(req.created_at).toLocaleDateString()}
                  {req.status === "AWAITING_APPROVAL" && (
                    req.candidate_count > 0
                      ? <> · <strong>{req.candidate_count}</strong> release{req.candidate_count !== 1 ? "s" : ""} found</>
                      : <> · <em style={{opacity:0.6}}>no releases yet</em></>
                  )}
                </p>
                {req.requested_by && Array.isArray(req.requested_by) && req.requested_by.length > 0 && (
                  <p className="request-meta">Requested by: {req.requested_by.join(", ")}</p>
                )}
                <div className="request-actions">
                  <button className="btn btn-primary" onClick={() => navigate(`/requests/${req.id}`)}>View Releases</button>
                  <button className="btn btn-secondary" onClick={async () => {
                    await searchAgain(req.id, {});
                    loadData();
                  }}>Refresh</button>
                  <button className="btn btn-danger btn-tiny" onClick={async () => {
                    if (!confirm(`Permanently delete "${req.title}"? This cannot be undone.`)) return;
                    await dismissRequest(req.id);
                    loadData();
                  }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {managed.length > 0 && (
        <div className="dashboard-section">
          <h3>Managed Media — {managed.length}</h3>
          <div className="requests-grid">
            {managed.map((item: any) => (
              item.type === "series" ? (
                <div key={item.sonarr_id} className="request-card managed-card">
                  <h3 className="managed-title">{item.title} <span className="type-suffix">- Series</span></h3>
                  <div className="managed-seasons">
                    {item.seasons.map((s: any) => {
                      const covered = s.covered_episodes?.length || 0;
                      const total = s.episode_count;
                      const label = total ? `${covered}/${total} EP` : covered > 0 ? `${covered} EP` : "pending";
                      return (
                        <div key={s.season} className="managed-season" onClick={() => navigate(`/requests/${s.request_id}`)}>
                          <span className="season-label">S{String(s.season).padStart(2, "0")}</span>
                          <span className={`season-status ${covered > 0 ? "has-content" : "empty"}`}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="managed-footer">
                    <span className="rtag">{item.total_releases} EP · {formatSize(item.total_size_mb)}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/managed/${item.sonarr_id}`)}>Manage</button>
                  </div>
                </div>
              ) : (
                <div key={item.request_id} className="request-card managed-card">
                  <h3 className="managed-title">{item.title} <span className="type-suffix">- Movie</span></h3>
                  <div className="managed-footer">
                    <span className="rtag">{item.release_count} version{item.release_count !== 1 ? "s" : ""} · {formatSize(item.total_size_mb)}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${item.request_id}`)}>Manage</button>
                  </div>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {requestsList.length === 0 && managed.length === 0 && (
        <div className="empty-state">
          <p>No requests yet</p>
        </div>
      )}
    </div>
  );
}
