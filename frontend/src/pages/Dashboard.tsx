import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRequests, searchAgain, fetchTorrentStatus } from "../api";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

const STATUS_OPTIONS = ["ALL", "NEW", "SEARCHING", "AWAITING_APPROVAL", "DOWNLOADING", "SEEDING", "COMPLETED", "REJECTED", "DISMISSED"];
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
  SEEDING: 4,
  COMPLETED: 5,
  REJECTED: 6,
  DISMISSED: 7,
};

const QB_STATE_MAP: Record<string, string> = {
  uploading: "Seeding",
  stalledUP: "Seeding",
  forcedUP: "Seeding",
  queuedUP: "Seeding",
  pausedUP: "Paused",
  downloading: "Downloading",
  forcedDL: "Downloading",
  stalledDL: "Stalled",
  queuedDL: "Queued",
  pausedDL: "Paused",
  checking: "Checking",
  errored: "Error",
  moving: "Moving",
  missingFiles: "Missing",
  unknown: "Unknown",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("status_asc");
  const [torrentStates, setTorrentStates] = useState<Record<number, any>>({});

  const loadRequests = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchRequests();
      setRequests(data);
      setError(null);

      const approved = data.filter((r: any) => r.approved_release?.torrent_hash);
      const states: Record<number, any> = {};
      await Promise.all(approved.map(async (r: any) => {
        try {
          const ts = await fetchTorrentStatus(r.id);
          states[r.id] = ts;
        } catch { /* ignore */ }
      }));
      setTorrentStates(states);
    } catch (err) {
      setError("Failed to load requests");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
    const interval = setInterval(loadRequests, 30000);
    return () => clearInterval(interval);
  }, [loadRequests]);

  const requestsList = requests
    .filter((r: any) => !r.approved_release?.torrent_hash)
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

  const managedList = requests
    .filter((r: any) => !!r.approved_release?.torrent_hash)
    .sort((a: any, b: any) => a.title.localeCompare(b.title));

  if (loading && requests.length === 0) {
    return <div className="container"><p>Loading requests...</p></div>;
  }

  if (error) {
    return <div className="container error"><p>{error}</p></div>;
  }

  return (
    <div className="container">
      <div className="dashboard-header">
        <h2>Media Dashboard</h2>
        <span className="request-count">{requests.length} total</span>
      </div>

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
      </div>

      {managedList.length > 0 && (
        <div className="dashboard-section">
          <h3>Managed Media</h3>
          <div className="requests-grid">
            {managedList.map((req: any) => {
              const ts = torrentStates[req.id];
              const qbState = ts?.found ? ts.state : null;
              const qbLabel = qbState ? (QB_STATE_MAP[qbState] || qbState) : null;

              return (
                <div key={req.id} className="request-card managed-card">
                  <div className="request-header">
                    <h3>{req.title}</h3>
                    <div className="request-badges">
                      {qbLabel && (
                        <span className={`status-badge status-badge-sm qb-${qbState}`}>{qbLabel}</span>
                      )}
                    </div>
                  </div>
                  <p className="request-meta">
                    {req.type} &middot; {req.approved_release?.radarr_quality} &middot; {formatSize(req.approved_release?.size_mb || 0)}
                  </p>
                  <p className="request-meta approved-versions">
                    <strong>1</strong> approved version
                  </p>
                  <div className="request-actions">
                    <button className="btn btn-primary" onClick={() => navigate(`/requests/${req.id}`)}>Manage</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="dashboard-section">
        <h3>Requests</h3>
        {requestsList.length === 0 && !loading ? (
          <div className="empty-state">
            <p>No pending requests</p>
          </div>
        ) : (
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
                  Type: <strong>{req.type}</strong> &middot; {new Date(req.created_at).toLocaleDateString()}
                </p>
                {req.requested_by && Array.isArray(req.requested_by) && req.requested_by.length > 0 && (
                  <p className="request-meta">Requested by: {req.requested_by.join(", ")}</p>
                )}
                <div className="request-actions">
                  <button className="btn btn-primary" onClick={() => navigate(`/requests/${req.id}`)}>View Releases</button>
                  <button className="btn btn-secondary" onClick={async () => {
                    await searchAgain(req.id, {});
                    loadRequests();
                  }}>Search Again</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
