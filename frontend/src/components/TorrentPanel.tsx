import { useState, useEffect, useRef } from "react";
import { fetchContentInfo, fetchWorkspaces, updateWorkspaceMetadata, completeWorkspace, deleteWorkspaceFile, deleteWorkspace } from "../api";
import WorkspacePickerModal from "./WorkspacePickerModal";

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

import ScriptDropdown from "./ScriptDropdown";

export interface TorrentPanelProps {
  approvedRelease: any;
  torrentStatus: any;
  moveResult: any;
  requestId: number;
  requestTitle?: string;
  isMoving: boolean;
  isRemoveConfirm: boolean;
  preprocessing: boolean;
  onTogglePreprocessing: (checked: boolean) => void;
  onMove: (releaseId: number, workspaceIndex?: number, wsConfig?: { name?: string; notes?: string; scripts?: string[] }) => void;
  onMoveToLibrary: (releaseId: number) => void;
  onRemoveFromLibrary: (releaseId: number) => void;
  onPause: (releaseId: number) => void;
  onResume: (releaseId: number) => void;
  onCopyPath: (text: string) => void;
  onRefreshMoveStatus?: () => void;
  onRefreshProcessed?: () => void;
  onUnlinkProcessed?: (processedFileName: string) => void;
  onDestroy?: (releaseId: number, deleteFiles: boolean) => void;
}

export default function TorrentPanel({
  approvedRelease: ar,
  torrentStatus: ts,
  moveResult: mr,
  requestId,
  requestTitle,
  isMoving,
  isRemoveConfirm,
  preprocessing,
  onTogglePreprocessing,
  onMove,
  onMoveToLibrary,
  onRemoveFromLibrary,
  onPause,
  onResume,
  onCopyPath,
  onRefreshMoveStatus,
  onRefreshProcessed,
  onUnlinkProcessed,
  onDestroy,
}: TorrentPanelProps) {
  const [contentInfo, setContentInfo] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [wsManagerOpen, setWsManagerOpen] = useState(false);
  const [wsManagerData, setWsManagerData] = useState<any[]>([]);
  const [wsEditIdx, setWsEditIdx] = useState<number | null>(null);
  const [destroyConfirm, setDestroyConfirm] = useState(0);
  const [wsEditValue, setWsEditValue] = useState("");
  const wsEditRef = useRef<HTMLInputElement>(null);
  const prevMrRef = useRef<any>(null);

  const defaultName = requestTitle || ar.title || "";

  const loadWorkspaces = () => {
    fetchWorkspaces(requestId).then((data) => {
      setWorkspaces(data.workspaces || []);
    }).catch(() => {});
  };

  const refreshAll = () => {
    loadWorkspaces();
    if (onRefreshMoveStatus) onRefreshMoveStatus();
  };

  const openWsManager = () => {
    fetchWorkspaces(requestId).then((data) => {
      setWsManagerData(data.workspaces || []);
      setWsManagerOpen(true);
    }).catch(() => {});
  };

  const managedWs = wsManagerData[0] || null;

  const handleFileDelete = async (wsIndex: number, subDir: "inputs" | "output", fileName: string) => {
    await deleteWorkspaceFile(requestId, wsIndex, subDir, fileName);
    refreshAll();
    const refreshed = await fetchWorkspaces(requestId);
    const list = refreshed.workspaces || [];
    setWsManagerData(list);
    const updated = list.find((w: any) => w.index === wsIndex);
    if (!updated || (updated.inputCount === 0 && updated.outputCount === 0)) {
      setWsManagerOpen(false);
    }
  };

  const handleDeleteJob = async (wsIndex: number) => {
    await deleteWorkspace(requestId, wsIndex);
    refreshAll();
    setWsManagerOpen(false);
  };

  const handleComplete = async (wsIndex: number) => {
    await completeWorkspace(requestId, wsIndex);
    refreshAll();
    if (onRefreshProcessed) onRefreshProcessed();
    setWsManagerOpen(false);
  };

  useEffect(() => {
    loadWorkspaces();
  }, [requestId]);

  useEffect(() => {
    if (ts?.progress === 100 && ts?.found) {
      setContentInfo(null);
      fetchContentInfo(requestId, ar.id).then(setContentInfo).catch(() => {});
      loadWorkspaces();
    }
  }, [ts?.progress, ts?.found, requestId, ar.id]);

  useEffect(() => {
    if (wsEditIdx !== null && wsEditRef.current) wsEditRef.current.focus();
  }, [wsEditIdx]);

  useEffect(() => {
    if (mr && mr !== prevMrRef.current && ts?.progress === 100) {
      loadWorkspaces();
    }
    prevMrRef.current = mr;
  }, [mr]);

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
                <span className="ts-icon">&darr;</span>
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
              <span className="ts-icon">&uarr;</span>
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
                {onDestroy && (
                  destroyConfirm === 0 ? (
                    <button className="btn btn-danger btn-tiny" onClick={() => setDestroyConfirm(1)}>Destroy</button>
                  ) : destroyConfirm === 1 ? (
                    <div style={{ display: "flex", gap: 3 }}>
                      <button className="btn btn-danger btn-tiny" onClick={() => setDestroyConfirm(2)}>Sure?</button>
                      <button className="btn btn-secondary btn-tiny" onClick={() => setDestroyConfirm(0)}>No</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 3 }}>
                      <button className="btn btn-danger btn-tiny" onClick={() => { setDestroyConfirm(0); onDestroy(ar.id, true); }}>Delete Files</button>
                      <button className="btn btn-danger btn-tiny" onClick={() => { setDestroyConfirm(0); onDestroy(ar.id, false); }}>Keep Files</button>
                      <button className="btn btn-secondary btn-tiny" onClick={() => setDestroyConfirm(0)}>No</button>
                    </div>
                  )
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
              {mr?.error && (
                <div className="torrent-path-row">
                  <span className="path-label">{ts.in_library ? "Also:" : "Move:"}</span>
                  <span className="move-error">{mr.error}</span>
                </div>
              )}
              {mr?.source ? (
                <div className="torrent-path-row">
                  <span className="path-label">{ts.in_library ? "Also:" : "Move:"}</span>
                  <span className="move-result">
                    <span>{mr.processedOutputs && !mr.inWorkspace ? "Processed" : "Hardlinked"} &rarr;</span>
                    <span className="torrent-path" title="Click to copy" onClick={() => onCopyPath(mr.destination)}>{mr.destination}</span>
                  </span>
                  {mr?.inWorkspace && (
                    <button className="btn btn-secondary btn-tiny" onClick={openWsManager}>Manage</button>
                  )}
                  {onUnlinkProcessed && !mr?.inWorkspace && (
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      const fname = mr.destination.split("/").pop();
                      if (fname && confirm("Remove processed file and unlink from this torrent?")) onUnlinkProcessed(fname);
                    }}>Unlink</button>
                  )}
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
                  <div style={{ display: "flex", gap: 4 }}>
                    {preprocessing ? (
                      <button
                        className="btn btn-workspace btn-tiny"
                        onClick={() => setWsPickerOpen(true)}
                        disabled={isMoving}
                      >
                        {isMoving ? "Moving..." : "To Workspace"}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary btn-tiny"
                        onClick={() => onMove(ar.id)}
                        disabled={isMoving}
                      >
                        {isMoving ? "Moving..." : "Move to Processed"}
                      </button>
                    )}
                    {!ts.in_library && (
                      <button className="btn btn-primary btn-tiny" onClick={() => onMoveToLibrary(ar.id)} disabled={isMoving}>
                        {isMoving ? "Moving..." : "Move to Library"}
                      </button>
                    )}
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

    {wsManagerOpen && managedWs && (
      <div className="modal-overlay" onClick={() => setWsManagerOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {wsEditIdx === managedWs.index ? (
                <input
                  ref={wsEditRef}
                  className="workspace-edit-input"
                  value={wsEditValue}
                  onChange={(e) => setWsEditValue(e.target.value)}
                  onBlur={async () => {
                    if (wsEditValue.trim()) {
                      await updateWorkspaceMetadata(requestId, managedWs.index, { name: wsEditValue.trim() });
                      refreshAll();
                      openWsManager();
                    }
                    setWsEditIdx(null);
                  }}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && wsEditValue.trim()) {
                      await updateWorkspaceMetadata(requestId, managedWs.index, { name: wsEditValue.trim() });
                      refreshAll();
                      openWsManager();
                      setWsEditIdx(null);
                    }
                    if (e.key === "Escape") setWsEditIdx(null);
                  }}
                />
              ) : (
                <h3 style={{ margin: 0, cursor: "pointer" }} onClick={() => { setWsEditValue(managedWs.metadata?.name || `Job ${managedWs.index}`); setWsEditIdx(managedWs.index); }}>
                  {managedWs.metadata?.name || `Job ${managedWs.index}`}
                </h3>
              )}
            </div>
            <button className="modal-close" onClick={() => setWsManagerOpen(false)}>&times;</button>
          </div>
          <div className="modal-body">
            <div className="ws-manager-meta">
              <span>{managedWs.inputCount} input{managedWs.inputCount !== 1 ? "s" : ""}</span>
              <span>{managedWs.outputCount} output{managedWs.outputCount !== 1 ? "s" : ""}</span>
              <span className="ws-manager-date">{new Date(managedWs.metadata?.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="ws-manager-section-label">Notes</div>
            <textarea
              className="ws-manager-notes-input"
              rows={2}
              placeholder="Add notes about this workspace..."
              value={managedWs.metadata?.notes || ""}
              onChange={(e) => {
                setWsManagerData((prev) => prev.map((w) => w.index === managedWs.index ? { ...w, metadata: { ...w.metadata, notes: e.target.value } } : w));
              }}
              onBlur={async () => {
                await updateWorkspaceMetadata(requestId, managedWs.index, { notes: managedWs.metadata?.notes || "" });
              }}
            />
            <div className="ws-manager-section-label">Scripts</div>
            <ScriptDropdown
              value={managedWs.metadata?.scripts || []}
              onChange={async (next) => {
                setWsManagerData((prev) => prev.map((w) => w.index === managedWs.index ? { ...w, metadata: { ...w.metadata, scripts: next } } : w));
                await updateWorkspaceMetadata(requestId, managedWs.index, { scripts: next } as any);
              }}
              placeholder="Select scripts..."
            />
            <div className="ws-manager-section">
              <div className="ws-manager-section-label">Inputs ({managedWs.inputCount})</div>
              {managedWs.inputFiles?.length > 0 ? (
                managedWs.inputFiles.map((f: any) => (
                  <div key={f.name} className="ws-manager-output-path ws-file-row">
                    <span className="ws-file-exists">{f.exists ? "\u25CF" : "\u25CB"}</span>
                    <span className="ws-file-name" title={f.name}>{f.name}</span>
                    <span className="ws-file-size">{formatBytes(f.size)}</span>
                    <button className="btn btn-danger btn-tiny" title="Delete" onClick={() => handleFileDelete(managedWs.index, "inputs", f.name)}>&times;</button>
                  </div>
                ))
              ) : (
                <div className="ws-manager-empty">No input files</div>
              )}
            </div>
            <div className="ws-manager-section">
              <div className="ws-manager-section-label">Outputs ({managedWs.outputCount})</div>
              {managedWs.outputFiles?.length > 0 ? (
                managedWs.outputFiles.map((f: any) => (
                  <div key={f.name} className="ws-manager-output-path ws-file-row">
                    <span className="ws-file-exists">{f.exists ? "\u25CF" : "\u25CB"}</span>
                    <span className="ws-file-name" title={`${f.name} - Click to copy`} onClick={() => navigator.clipboard.writeText(f.name)}>{f.name}</span>
                    <span className="ws-file-size">{formatBytes(f.size)}</span>
                    <button className="btn btn-danger btn-tiny" title="Delete" onClick={() => handleFileDelete(managedWs.index, "output", f.name)}>&times;</button>
                  </div>
                ))
              ) : (
                <div className="ws-manager-empty">Place processed files in workspace/output/</div>
              )}
            </div>
            {managedWs.metadata?.outputPaths?.length > 0 && (
              <div className="ws-manager-section ws-manager-processed">
                <div className="ws-manager-section-label">Processed</div>
                {managedWs.metadata.outputPaths.map((p: string, i: number) => (
                  <div key={i} className="ws-manager-output-path" title="Click to copy" onClick={() => navigator.clipboard.writeText(p)}>
                    {p}
                  </div>
                ))}
              </div>
            )}
            <div className="ws-manager-actions">
              <button
                className={`btn btn-tiny ${managedWs.outputCount > 0 ? "btn-primary" : "btn-secondary btn-disabled"}`}
                disabled={managedWs.outputCount === 0 || managedWs.metadata?.status === "completed"}
                title={managedWs.outputCount === 0 ? "Add output files to enable" : ""}
                onClick={() => {
                  if (!confirm(`Complete "${managedWs.metadata?.name || `Job ${managedWs.index}`}"? Inputs will be deleted, outputs moved to /Processed. Radarr/Sonarr will scan and import.`)) return;
                  handleComplete(managedWs.index);
                }}
              >
                {managedWs.metadata?.status === "completed" ? "Completed" : "Complete & Import"}
              </button>
              <button className="btn btn-danger btn-tiny" onClick={() => {
                if (!confirm(`Delete workspace "${managedWs.metadata?.name || `Job ${managedWs.index}`}"? This cannot be undone.`)) return;
                handleDeleteJob(managedWs.index);
              }}>Delete Job</button>
            </div>
          </div>
        </div>
      </div>
    )}

    <WorkspacePickerModal
      open={wsPickerOpen}
      fileName={undefined}
      workspaces={workspaces}
      defaultName={defaultName}
      onMove={(config) => {
        setWsPickerOpen(false);
        onMove(ar.id, config.workspaceIndex, config);
      }}
      onCancel={() => setWsPickerOpen(false)}
      busy={isMoving}
    />
    </>
  );
}
