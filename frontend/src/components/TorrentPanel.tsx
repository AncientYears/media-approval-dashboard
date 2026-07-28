import { useState, useEffect, useRef } from "react";
import { fetchContentInfo, fetchWorkspaces } from "../api";
import WorkspacePickerModal from "./WorkspacePickerModal";
import WorkspaceManagerModal from "./WorkspaceManagerModal";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
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
  onUnlinkProcessed,
  onDestroy,
}: TorrentPanelProps) {
  const [contentInfo, setContentInfo] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [wsManagerOpen, setWsManagerOpen] = useState(false);
  const [showDestroyModal, setShowDestroyModal] = useState(false);
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
    if (mr && mr !== prevMrRef.current && ts?.progress === 100) {
      loadWorkspaces();
    }
    prevMrRef.current = mr;
  }, [mr]);

  if (!ar.torrent_hash) return null;
  if (ts && !ts.found) {
    return (
      <div className="torrent-panel">
        <div className="approved-release-info">
          <span className="approved-label">Installed</span>
          <span className="approved-title">{ar.title}</span>
          <span className="rtag rtag-warn">Torrent missing</span>
        </div>
        <div className="torrent-meta">
          <span>Torrent no longer in qBittorrent</span>
          {onDestroy && (
            <button className="btn btn-danger btn-tiny" style={{ marginLeft: 8 }} onClick={() => setShowDestroyModal(true)}>Remove</button>
          )}
        </div>
      </div>
    );
  }

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
                  <button className="btn btn-danger btn-tiny" onClick={() => setShowDestroyModal(true)}>Destroy</button>
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
                    <button className="btn btn-secondary btn-tiny" onClick={() => setWsManagerOpen(true)}>Manage</button>
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

    {wsManagerOpen && mr?.workspaceIndex != null && (
      <WorkspaceManagerModal
        open={wsManagerOpen}
        requestId={requestId}
        workspaceIndex={mr.workspaceIndex}
        onClose={() => setWsManagerOpen(false)}
        onRefresh={refreshAll}
      />
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

    {showDestroyModal && onDestroy && (
      <div className="modal-overlay" onClick={() => setShowDestroyModal(false)}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()}>
          <h3 className="modal-title" style={{ color: "#ef4444" }}>Destroy Torrent</h3>
          <div className="modal-body">
            <div className="modal-line" style={{ fontWeight: 600 }}>
              {ar.title || "Unknown"}
            </div>
            <div className="modal-line" style={{ marginTop: 8, color: "#94a3b8" }}>
              The .torrent file and tracker info will be exported to /media/Torrents/Trackers/ before removal.
            </div>
            <div className="modal-spacer" />
            <div className="modal-line" style={{ fontSize: "0.9em" }}>
              <strong style={{ color: "#ef4444" }}>Delete Files</strong> — removes from qBittorrent and deletes downloaded files from disk
            </div>
            <div className="modal-line" style={{ fontSize: "0.9em", marginTop: 4 }}>
              <strong style={{ color: "#f59e0b" }}>Keep Files</strong> — removes from qBittorrent but moves the files to /Processed
            </div>
            <div className="modal-line" style={{ fontSize: "0.85em", color: "#94a3b8", marginTop: 8 }}>
              Processed (renamed/trimmed) files already in /Processed will be kept either way.
            </div>
            <div className="modal-line" style={{ fontSize: "0.85em", color: "#94a3b8" }}>
              Sonarr/Radarr are not affected — if the media is still wanted, it will be re-discovered on next poll.
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setShowDestroyModal(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { setShowDestroyModal(false); onDestroy(ar.id, false); }}>Keep Files</button>
            <button className="btn btn-danger" onClick={() => { setShowDestroyModal(false); onDestroy(ar.id, true); }}>Delete Files</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
