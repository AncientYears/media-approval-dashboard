import { useState, useEffect, useRef } from "react";
import { fetchContentInfo, fetchWorkspaces, updateWorkspaceMetadata, completeWorkspace, cleanWorkspaceInputs } from "../api";

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

export interface TorrentPanelProps {
  approvedRelease: any;
  torrentStatus: any;
  moveResult: any;
  requestId: number;
  isMoving: boolean;
  isRemoveConfirm: boolean;
  preprocessing: boolean;
  onTogglePreprocessing: (checked: boolean) => void;
  onMove: (releaseId: number, workspaceIndex?: number) => void;
  onMoveToLibrary: (releaseId: number) => void;
  onDismiss: (releaseId: number) => void;
  onRemoveFromLibrary: (releaseId: number) => void;
  onPause: (releaseId: number) => void;
  onResume: (releaseId: number) => void;
  onCopyPath: (text: string) => void;
}

export default function TorrentPanel({
  approvedRelease: ar,
  torrentStatus: ts,
  moveResult: mr,
  requestId,
  isMoving,
  isRemoveConfirm,
  preprocessing,
  onTogglePreprocessing,
  onMove,
  onMoveToLibrary,
  onDismiss,
  onRemoveFromLibrary,
  onPause,
  onResume,
  onCopyPath,
}: TorrentPanelProps) {
  const [contentInfo, setContentInfo] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<number | "new">("new");
  const [editingWs, setEditingWs] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [wsManagerOpen, setWsManagerOpen] = useState(false);
  const [wsManagerData, setWsManagerData] = useState<any[]>([]);
  const [wsEditIdx, setWsEditIdx] = useState<number | null>(null);
  const [wsEditField, setWsEditField] = useState<"name" | "notes">("name");
  const [wsEditValue, setWsEditValue] = useState("");
  const wsEditRef = useRef<HTMLInputElement>(null);

  const loadWorkspaces = () => {
    fetchWorkspaces(requestId).then((data) => {
      setWorkspaces(data.workspaces || []);
      if (data.workspaces?.length > 0 && selectedWorkspace === "new") setSelectedWorkspace(data.workspaces[0].index);
    }).catch(() => {});
  };

  const openWsManager = () => {
    fetchWorkspaces(requestId).then((data) => {
      setWsManagerData(data.workspaces || []);
      setWsManagerOpen(true);
    }).catch(() => {});
  };

  useEffect(() => {
    if (ts?.progress === 100 && ts?.found) {
      setContentInfo(null);
      fetchContentInfo(requestId, ar.id).then(setContentInfo).catch(() => {});
      loadWorkspaces();
    }
  }, [ts?.progress, ts?.found, requestId, ar.id]);

  useEffect(() => {
    if (editingWs !== null && editInputRef.current) editInputRef.current.focus();
  }, [editingWs]);

  useEffect(() => {
    if (wsEditIdx !== null && wsEditRef.current) wsEditRef.current.focus();
  }, [wsEditIdx]);

  if (!ar.torrent_hash) return null;
  if (ts && !ts.found) return null;

  const contentBadge = contentInfo ? (() => {
    switch (contentInfo.type) {
      case "video": return <span className="rtag rtag-content-ok">Single video</span>;
      case "bluray": return <span className="rtag rtag-content-warn">Bluray disk</span>;
      case "multi": return <span className="rtag rtag-content-warn">{contentInfo.videoFiles.length} video files</span>;
      case "none": return <span className="rtag rtag-content-err">No video files</span>;
      default: return null;
    }
  })() : null;

  return (
    <>
    <div className="torrent-panel">
      <div className="approved-release-info">
        <span className="approved-label">Installed</span>
        <span className="approved-title" title={ar.title}>
          {ar.info_url
            ? <a href={ar.info_url} target="_blank" rel="noopener noreferrer">{ar.title}</a>
            : ar.title}
        </span>
        <span className="rtag">{ar.radarr_quality || ar.quality}</span>
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
            {ts.completion_on > 0 && (ts.state === "uploading" || ts.state === "stalledUP" || ts.state === "forcedUP" || ts.state === "queuedUP" || ts.state === "pausedUP") && (
              <div className="ts-item">
                <span className="ts-label">Seeding</span>
                <span className="ts-value">{formatDuration(ts.seeding_time || 0)}</span>
              </div>
            )}
            {ts.progress === 100 && (
              <div className="ts-item ts-actions">
                {ts.state === "stalledUP" || ts.state === "uploading" || ts.state === "forcedUP" || ts.state === "queuedUP" ? (
                  <button className="btn btn-secondary btn-tiny" onClick={() => onPause(ar.id)}>Pause</button>
                ) : (
                  <button className="btn btn-secondary btn-tiny" onClick={() => onResume(ar.id)}>Resume</button>
                )}
              </div>
            )}
          </div>
          {ts.progress === 100 && (
            <div className="torrent-paths">
              <div className="torrent-path-row">
                <span className="path-label">Source:</span>
                <span className="torrent-path" title="Click to copy" onClick={() => onCopyPath(ts.content_path)}>
                  {ts.content_path}
                </span>
                <button className="btn btn-danger btn-tiny" onClick={() => onDismiss(ar.id)}>Delete</button>
              </div>
              {ts.in_library && (
                <div className="torrent-path-row">
                  <span className="path-label">Library:</span>
                  <span className="torrent-path" title="Click to copy" onClick={() => onCopyPath(ts.library_path)}>
                    {ts.library_path}
                  </span>
                  <button className={`btn btn-tiny ${isRemoveConfirm ? "btn-danger" : "btn-library-ok"}`} onClick={() => onRemoveFromLibrary(ar.id)}>
                    {isRemoveConfirm ? "Remove?" : "In Library"}
                  </button>
                </div>
              )}
              {mr?.source ? (
                <div className="torrent-path-row">
                  <span className="path-label">{ts.in_library ? "Also:" : "Move:"}</span>
                  <span className="move-result">
                    <span>Hardlinked →</span>
                    <span className="torrent-path" title="Click to copy" onClick={() => onCopyPath(mr.destination)}>{mr.destination}</span>
                  </span>
                </div>
              ) : mr?.error ? (
                <div className="torrent-path-row">
                  <span className="path-label">{ts.in_library ? "Also:" : "Move:"}</span>
                  <span className="move-error">{mr.error}</span>
                </div>
              ) : (
                <div className="torrent-path-row">
                  <span className="path-label">{ts.in_library ? "Also:" : "Move:"}</span>
                  <label className="preprocessing-toggle">
                    <input
                      type="checkbox"
                      checked={preprocessing}
                      onChange={(e) => onTogglePreprocessing(e.target.checked)}
                    />
                    <span className="preprocessing-label">Needs preprocessing</span>
                  </label>
                  {contentBadge}
                  {preprocessing && workspaces.length > 0 && (
                    <div className="workspace-picker">
                      {editingWs !== null ? (
                        <div className="workspace-edit-inline">
                          <input
                            ref={editInputRef}
                            className="workspace-edit-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={async () => {
                              if (editName.trim()) {
                                await updateWorkspaceMetadata(requestId, editingWs, { name: editName.trim() });
                                loadWorkspaces();
                              }
                              setEditingWs(null);
                            }}
                            onKeyDown={async (e) => {
                              if (e.key === "Enter" && editName.trim()) {
                                await updateWorkspaceMetadata(requestId, editingWs, { name: editName.trim() });
                                loadWorkspaces();
                                setEditingWs(null);
                              }
                              if (e.key === "Escape") setEditingWs(null);
                            }}
                          />
                        </div>
                      ) : (
                        <>
                          <select
                            className="workspace-select"
                            value={selectedWorkspace}
                            onChange={(e) => setSelectedWorkspace(e.target.value === "new" ? "new" : Number(e.target.value))}
                          >
                            {workspaces.map((ws) => {
                              const label = ws.metadata?.name || `Job ${ws.index}`;
                              return (
                                <option key={ws.index} value={ws.index}>
                                  {label} ({ws.inputCount} in / {ws.outputCount} out)
                                </option>
                              );
                            })}
                            <option value="new">+ New workspace</option>
                          </select>
                          {selectedWorkspace !== "new" && (
                            <button
                              className="btn btn-secondary btn-tiny"
                              title="Rename workspace"
                              onClick={() => {
                                const ws = workspaces.find((w: any) => w.index === selectedWorkspace);
                                setEditName(ws?.metadata?.name || `Job ${ws?.index}`);
                                setEditingWs(selectedWorkspace as number);
                              }}
                            >&#9998;</button>
                          )}
                          <button className="btn btn-secondary btn-tiny" onClick={openWsManager}>Manage</button>
                        </>
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      className={`btn btn-tiny ${preprocessing ? "btn-workspace" : "btn-primary"}`}
                      onClick={() => onMove(ar.id, preprocessing && selectedWorkspace !== "new" ? selectedWorkspace : undefined)}
                      disabled={isMoving}
                    >
                      {isMoving ? "Moving..." : preprocessing ? "Move to Workspace" : "Move to Processed"}
                    </button>
                    <button className="btn btn-primary btn-tiny" onClick={() => onMoveToLibrary(ar.id)} disabled={isMoving}>
                      {isMoving ? "Moving..." : "Move to Library"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="torrent-meta"><span>Waiting for qBittorrent...</span></div>
      )}
    </div>
    {wsManagerOpen && (
      <div className="modal-overlay" onClick={() => setWsManagerOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Workspaces</h3>
            <button className="modal-close" onClick={() => setWsManagerOpen(false)}>&times;</button>
          </div>
          <div className="modal-body">
            {wsManagerData.length === 0 && <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>No workspaces yet.</p>}
            {wsManagerData.map((ws: any) => (
              <div key={ws.index} className="ws-manager-row">
                <div className="ws-manager-header">
                  {wsEditIdx === ws.index ? (
                    <input
                      ref={wsEditRef}
                      className="workspace-edit-input"
                      value={wsEditValue}
                      onChange={(e) => setWsEditValue(e.target.value)}
                      onBlur={async () => {
                        if (wsEditValue.trim()) {
                          await updateWorkspaceMetadata(requestId, ws.index, { [wsEditField]: wsEditValue.trim() });
                          loadWorkspaces();
                          openWsManager();
                        }
                        setWsEditIdx(null);
                      }}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && wsEditValue.trim()) {
                          await updateWorkspaceMetadata(requestId, ws.index, { [wsEditField]: wsEditValue.trim() });
                          loadWorkspaces();
                          openWsManager();
                          setWsEditIdx(null);
                        }
                        if (e.key === "Escape") setWsEditIdx(null);
                      }}
                    />
                  ) : (
                    <span className="ws-manager-name" onClick={() => { setWsEditField("name"); setWsEditValue(ws.metadata?.name || `Job ${ws.index}`); setWsEditIdx(ws.index); }}>
                      {ws.metadata?.name || `Job ${ws.index}`}
                    </span>
                  )}
                  <span className={`ws-manager-status ${ws.metadata?.status === "completed" ? "ws-completed" : "ws-active"}`}>
                    {ws.metadata?.status || "active"}
                  </span>
                </div>
                <div className="ws-manager-meta">
                  <span>{ws.inputCount} input{ws.inputCount !== 1 ? "s" : ""}</span>
                  <span>{ws.outputCount} output{ws.outputCount !== 1 ? "s" : ""}</span>
                  <span className="ws-manager-date">{new Date(ws.metadata?.createdAt).toLocaleDateString()}</span>
                </div>
                {ws.metadata?.notes && (
                  <div className="ws-manager-notes" onClick={() => { setWsEditField("notes"); setWsEditValue(ws.metadata.notes); setWsEditIdx(ws.index); }}>
                    {ws.metadata.notes}
                  </div>
                )}
                {ws.metadata?.outputPaths?.length > 0 && (
                  <div className="ws-manager-outputs">
                    {ws.metadata.outputPaths.map((p: string, i: number) => (
                      <div key={i} className="ws-manager-output-path" title="Click to copy" onClick={() => navigator.clipboard.writeText(p)}>
                        {p}
                      </div>
                    ))}
                  </div>
                )}
                <div className="ws-manager-actions">
                  {ws.metadata?.status !== "completed" && ws.outputCount > 0 && (
                    <button className="btn btn-primary btn-tiny" onClick={async () => {
                      if (!confirm(`Complete "${ws.metadata?.name || `Job ${ws.index}`}"? Inputs will be deleted, outputs moved to processed.`)) return;
                      await completeWorkspace(requestId, ws.index);
                      loadWorkspaces();
                      openWsManager();
                    }}>Complete</button>
                  )}
                  {ws.inputCount > 0 && (
                    <button className="btn btn-secondary btn-tiny" onClick={async () => {
                      if (!confirm(`Delete ${ws.inputCount} input file(s)? This removes the hardlinks only.`)) return;
                      await cleanWorkspaceInputs(requestId, ws.index);
                      loadWorkspaces();
                      openWsManager();
                    }}>Clean inputs</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
