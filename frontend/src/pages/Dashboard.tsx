import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRequests, fetchManaged, fetchFranchiseSeasons, cleanupStaleRequests, dismissRequest, detectTorrents, importMissingRequests, scanDownloads, importLibrary, cleanupDuplicates, deleteRequest, deleteFranchise, scanWorkspaces, cleanupWorkspaces } from "../api";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
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

function Modal({ title, lines, onClose, onOk, onCleanup }: { title?: string; lines: string[]; onClose: () => void; onOk?: () => void; onCleanup?: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="modal-title">{title}</h3>}
        <div className="modal-body">
          {lines.map((line, i) => (
            <div key={i} className={line === "" ? "modal-spacer" : "modal-line"}>
              {line || "\u00A0"}
            </div>
          ))}
        </div>
        {onCleanup ? (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
            <button className="btn btn-danger" onClick={onCleanup}>Clean Up</button>
          </div>
        ) : onOk ? (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-danger" onClick={onOk}>Delete Duplicates</button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onClose}>OK</button>
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-line">{message}</div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<any[]>([]);
  const [managed, setManaged] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("status_asc");
  const [modal, setModal] = useState<{ title?: string; lines: string[]; onCleanup?: () => void } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; title: string } | null>(null);
  const [pendingCleanup, setPendingCleanup] = useState<{ dryResult: any } | null>(null);
  const [franchiseSeasons, setFranchiseSeasons] = useState<{ [sonarrId: number]: any }>({});

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
  }, [loadData]);

  const requestsList = requests
    .filter((r: any) => r.status !== "DOWNLOADING" && r.status !== "SEEDING")
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

  // Group series requests by sonarr_id for franchise grouping
  const groupedFranchises: { [key: number]: { title: string; sonarr_id: number; seasons: any[] } } = {};
  const ungroupedRequests: any[] = [];
  for (const req of requestsList) {
    if (req.type === "series" && req.sonarr_id) {
      if (!groupedFranchises[req.sonarr_id]) {
        const franchiseTitle = req.title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
        groupedFranchises[req.sonarr_id] = { title: franchiseTitle, sonarr_id: req.sonarr_id, seasons: [] };
      }
      groupedFranchises[req.sonarr_id].seasons.push(req);
    } else {
      ungroupedRequests.push(req);
    }
  }

  // Fetch full season lists from Sonarr for franchise groups
  useEffect(() => {
    const ids = Object.keys(groupedFranchises).map(Number);
    for (const id of ids) {
      if (franchiseSeasons[id]) continue;
      fetchFranchiseSeasons(id).then((data) => {
        setFranchiseSeasons((prev) => ({ ...prev, [id]: data }));
      }).catch(() => {});
    }
  }, [Object.keys(groupedFranchises).join(",")]);

  if (loading && requests.length === 0) {
    return <div className="container"><p>Loading requests...</p></div>;
  }

  if (error) {
    return <div className="container error"><p>{error}</p></div>;
  }

  return (
    <div className="container">
      {modal && <Modal title={modal.title} lines={modal.lines} onClose={() => { setModal(null); setPendingCleanup(null); }} onCleanup={modal.onCleanup} onOk={pendingCleanup ? async () => {
        setPendingCleanup(null);
        setModal({ title: "Cleanup Duplicates", lines: ["Deleting..."] });
        try {
          const result = await cleanupDuplicates(false);
          const lines = [`Cleaned up ${result.duplicates} duplicate(s):`];
          for (const r of result.results) {
            lines.push(`  "${r.title}": deleted ${r.deleted}, moved ${r.movedRcs} RCs`);
          }
          setModal({ title: "Cleanup Complete", lines });
          loadData();
        } catch (err: any) {
          setModal({ title: "Cleanup Error", lines: [err.message] });
        }
      } : undefined} />}
      {confirmDelete && (
        <ConfirmModal
          message={`Permanently delete "${confirmDelete.title}"? This cannot be undone.`}
          onConfirm={async () => {
            await dismissRequest(confirmDelete.id);
            setConfirmDelete(null);
            loadData();
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

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
            const lines = [
              `Detected ${result.detected} torrent(s) out of ${result.total} pending request(s).`,
              "",
            ];
            if (result.matches && result.matches.length > 0) {
              for (const m of result.matches) {
                lines.push(`"${m.request_title}" → ${m.torrent_name}`);
              }
            }
            setModal({ title: "Detect Torrents", lines });
            loadData();
          }}>Detect Torrents</button>
          <button className="btn btn-secondary btn-tiny" onClick={async () => {
            const result = await importMissingRequests();
            const lines = [
              `Imported ${result.imported} new request(s).`,
            ];
            if (result.fixed > 0) {
              lines.push(`Fixed ${result.fixed} existing request(s) NEW→COMPLETED.`);
            }
            if (result.orphaned > 0) {
              lines.push(`Removed ${result.orphaned} orphaned request(s).`);
            }
            if (result.skipped > 0) {
              lines.push(`Skipped ${result.skipped} (already in DB).`);
            }
            if (result.skippedItems && result.skippedItems.length > 0) {
              lines.push("");
              lines.push("Skipped items:");
              for (const s of result.skippedItems) {
                lines.push(`  ${s.title} — ${s.reason}`);
              }
            }
            if (result.removedOrphans && result.removedOrphans.length > 0) {
              lines.push("");
              lines.push("Removed orphans:");
              for (const o of result.removedOrphans) {
                lines.push(`  ${o}`);
              }
            }
            setModal({ title: "Import Missing", lines });
            loadData();
          }}>Import Missing</button>
          <button className="btn btn-primary btn-tiny" onClick={async () => {
            setModal({ title: "Scan Downloads", lines: ["Scanning qBittorrent..."] });
            const result = await scanDownloads();
            const lines = [
              `Scanned ${result.total} torrent(s).`,
              `Imported ${result.imported} into Radarr/Sonarr.`,
              `Skipped ${result.skipped} (already in DB).`,
              `No match: ${result.noMatch}.`,
              `Errors: ${result.errors}.`,
            ];
            if (result.backfilled > 0) lines.push(`Backfilled ${result.backfilled} approval(s).`);
            if (result.staleRemoved > 0) lines.push(`Removed ${result.staleRemoved} stale approval(s).`);
            if (result.statusFixed > 0) lines.push(`Fixed ${result.statusFixed} request status(es).`);
            if (result.seasonFixed > 0) lines.push(`Removed ${result.seasonFixed} season-mismatched RC(s) — re-run to import.`);
            if (result.rcFixed > 0) lines.push(`Fixed ${result.rcFixed} RC title/quality.`);
            if (result.results && result.results.length > 0) {
              lines.push("");
              for (const r of result.results) {
                const icon = r.status === "imported" ? "+" : r.status === "skipped" ? "=" : r.status === "error" ? "!" : "-";
                lines.push(`[${icon}] ${r.title} (${r.status}${r.type ? `, ${r.type}` : ""}${r.error ? `: ${r.error}` : ""})`);
              }
            }
            setModal({ title: "Scan Downloads", lines });
            loadData();
          }}>Scan Downloads</button>
          <button className="btn btn-primary btn-tiny" onClick={async () => {
            setModal({ title: "Import Library", lines: ["Scanning Radarr/Sonarr library..."] });
            const result = await importLibrary();
            const lines = [
              `Imported ${result.imported} file(s) into processed.`,
              `Already exists: ${result.exists}.`,
              `Skipped (no file): ${result.skipped}.`,
              `Errors: ${result.errors}.`,
            ];
            if (result.results && result.results.length > 0) {
              lines.push("");
              for (const r of result.results) {
                if (r.status === "imported") lines.push(`[+] ${r.title}`);
                else if (r.status === "exists") lines.push(`[=] ${r.title} (already in processed)`);
                else if (r.status === "error") lines.push(`[!] ${r.title}: ${r.error}`);
              }
            }
            setModal({ title: "Import Library", lines });
            loadData();
          }}>Import Library</button>
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Cleanup Duplicates", lines: ["Checking for duplicates..."] });
            try {
              const dryResult = await cleanupDuplicates(true);
              if (dryResult.duplicates === 0) {
                setModal({ title: "Cleanup Duplicates", lines: ["No duplicates found!"] });
              } else {
                const lines: string[] = [`Found ${dryResult.duplicates} duplicate title(s):`];
                for (const r of dryResult.results) {
                  lines.push(`  "${r.title}": delete ${r.deleted}, move ${r.movedRcs} RCs`);
                  if (r.sonarrDeleted?.length) lines.push(`    Sonarr: ${r.sonarrDeleted.join(", ")}`);
                  if (r.radarrDeleted?.length) lines.push(`    Radarr: ${r.radarrDeleted.join(", ")}`);
                }
                setPendingCleanup({ dryResult });
                setModal({ title: "Cleanup Duplicates", lines });
              }
            } catch (err: any) {
              setModal({ title: "Cleanup Duplicates", lines: [`Error: ${err.message}`] });
            }
          }}>Cleanup Duplicates</button>
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Scan Workspaces", lines: ["Scanning workspace directories..."] });
            try {
              const result = await scanWorkspaces();
              if (!result.workspaces || result.workspaces.length === 0) {
                setModal({ title: "Scan Workspaces", lines: ["No workspace directories found."] });
                return;
              }
              const lines: string[] = [`${result.workspaces.length} workspace(s) found:`];
              lines.push("");
              for (const ws of result.workspaces) {
                const icon = ws.status === "orphaned" ? "!" : ws.status === "empty" ? "-" : "+";
                const label = ws.status === "orphaned" ? "ORPHANED" : ws.status === "empty" ? "EMPTY" : "active";
                lines.push(`[${icon}] ${ws.dirName} — ${label}`);
                if (ws.requestTitle) lines.push(`    Request: ${ws.requestTitle} (${ws.requestType})`);
                lines.push(`    Inputs: ${ws.inputCount}, Outputs: ${ws.outputCount}`);
                if (ws.metadata?.name) lines.push(`    Name: ${ws.metadata.name}`);
                if (ws.metadata?.status) lines.push(`    Status: ${ws.metadata.status}`);
              }
              const cleanupable = result.workspaces.filter((ws: any) => ws.status === "orphaned" || ws.status === "empty");
              if (cleanupable.length > 0) {
                lines.push("");
                lines.push(`${cleanupable.length} can be cleaned up.`);
              }
              setModal({ title: "Scan Workspaces", lines, onCleanup: cleanupable.length > 0 ? async () => {
                setModal({ title: "Cleanup Workspaces", lines: ["Deleting..."] });
                const del = await cleanupWorkspaces(cleanupable.map((ws: any) => ws.dirName));
                setModal({ title: "Cleanup Workspaces", lines: [`Deleted ${del.deleted} workspace(s).${del.errors.length > 0 ? "\nErrors: " + del.errors.join(", ") : ""}`] });
              } : undefined });
            } catch (err: any) {
              setModal({ title: "Scan Workspaces", lines: [`Error: ${err.message}`] });
            }
          }}>Scan Workspaces</button>
        </div>
      </div>

      {(Object.keys(groupedFranchises).length > 0 || ungroupedRequests.length > 0) && (
        <div className="dashboard-section">
          <h3>Requests — {requestsList.length}</h3>
          <div className="requests-grid">
            {Object.values(groupedFranchises).map((franchise) => {
              const allSeasons = franchiseSeasons[franchise.sonarr_id]?.seasons || [];
              const requestedMap = new Map(franchise.seasons.map((s: any) => [s.season, s]));
              return (
                <div key={`franchise-${franchise.sonarr_id}`} className="request-card managed-card">
                  <div className="request-header">
                    <h3>{franchise.title} <span className="type-suffix">- Series ({franchise.seasons.length}/{allSeasons.length || franchise.seasons.length} requested)</span></h3>
                  </div>
                  <div className="managed-seasons">
                    {(allSeasons.length > 0 ? allSeasons : franchise.seasons.map((s: any) => ({ season: s.season }))).map((sn: any) => {
                      const req = requestedMap.get(sn.season);
                      return (
                        <div
                          key={sn.season}
                          className={`managed-season ${req ? "" : "unrequested"}`}
                          onClick={() => req && navigate(`/requests/${req.id}`)}
                          style={{ opacity: req ? 1 : 0.4, cursor: req ? "pointer" : "default" }}
                        >
                          <span className="season-label">S{String(sn.season).padStart(2, "0")}</span>
                          <span className={`season-status ${req ? (req.status === "AWAITING_APPROVAL" ? "has-content" : "empty") : ""}`}>
                            {req ? req.status.replace(/_/g, " ") : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="request-actions">
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/managed/${franchise.sonarr_id}`)}>View Franchise</button>
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      if (window.confirm(`Delete "${franchise.title}" from DB + Sonarr?`)) {
                        deleteFranchise(franchise.sonarr_id).then(() => loadData());
                      }
                    }}>Delete</button>
                  </div>
                </div>
              );
            })}
            {ungroupedRequests.map((req: any) => (
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
                  <button className="btn btn-danger btn-tiny" onClick={() => setConfirmDelete({ id: req.id, title: req.title })}>Delete</button>
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
                      const label = s.request_id ? (total ? `${covered}/${total} EP` : covered > 0 ? `${covered} EP` : "pending") : (total > 0 ? `${covered}/${total} EP` : covered > 0 ? `${covered} EP` : "—");
                      return (
                        <div key={s.season} className={`managed-season ${!s.request_id ? "unrequested" : ""}`} onClick={s.request_id ? () => navigate(`/requests/${s.request_id}`) : undefined} style={{ opacity: s.request_id ? 1 : 0.4, cursor: s.request_id ? "pointer" : "default" }}>
                          <span className={`season-label ${s.season === 0 ? "season-special" : ""}`}>{s.season === 0 ? "Special" : `S${String(s.season).padStart(2, "0")}`}</span>
                          <span className={`season-status ${covered > 0 ? "has-content" : "empty"}`}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="managed-footer">
                    <span className="rtag">{item.total_covered || item.total_releases} EP · {formatSize(item.total_size_mb)}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/managed/${item.sonarr_id}`)}>Manage</button>
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      if (window.confirm(`Delete "${item.title}" from DB + Sonarr?`)) {
                        deleteFranchise(item.sonarr_id).then(() => loadData());
                      }
                    }}>Delete</button>
                  </div>
                </div>
              ) : (
                <div key={item.request_id} className="request-card managed-card">
                  <h3 className="managed-title">{item.title} <span className="type-suffix">- Movie</span></h3>
                  <div className="managed-footer">
                    <span className="rtag">{(() => { const vc = item.release_count + (item.processed_count || 0); if (vc > 0) return `${vc} version${vc !== 1 ? "s" : ""}${item.total_size_mb > 0 ? " · " + formatSize(item.total_size_mb) : ""}`; if (item.status === 'COMPLETED') return 'In Library'; return `· ${item.status}`; })()}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${item.request_id}`)}>Manage</button>
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      if (window.confirm(`Delete "${item.title}" from DB + Radarr?`)) {
                        deleteRequest(item.request_id).then(() => loadData());
                      }
                    }}>Delete</button>
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
