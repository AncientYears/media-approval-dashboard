import { useState, useEffect } from "react";
import { fetchContentInfo } from "../api";

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
  onMove: (releaseId: number) => void;
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

  useEffect(() => {
    if (ts?.progress === 100 && ts?.found && !contentInfo) {
      fetchContentInfo(requestId).then(setContentInfo).catch(() => {});
    }
  }, [ts?.progress, ts?.found, requestId]);

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
        {contentBadge}
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
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      className={`btn btn-tiny ${preprocessing ? "btn-workspace" : "btn-primary"}`}
                      onClick={() => onMove(ar.id)}
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
  );
}
