import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { fetchActiveWorkspaces } from "../api";

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

export default function WorkspaceOverview() {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchActiveWorkspaces()
      .then((data) => setWorkspaces(data.workspaces || []))
      .catch(() => setWorkspaces([]))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const active = workspaces.filter((w) => w.metadata?.status !== "completed");
  const completed = workspaces.filter((w) => w.metadata?.status === "completed");

  return (
    <div className="ws-overview-wrapper" ref={ref}>
      <button className="ws-overview-toggle" onClick={() => setOpen(!open)}>
        {active.length > 0 && <span className="ws-overview-badge">{active.length}</span>}
        Workspaces
      </button>
      {open && (
        <div className="ws-overview-dropdown">
          {loading ? (
            <div className="ws-overview-loading">Loading...</div>
          ) : workspaces.length === 0 ? (
            <div className="ws-overview-empty">No active workspaces</div>
          ) : (
            <>
              {active.length > 0 && (
                <div className="ws-overview-group">
                  <div className="ws-overview-group-label">Active</div>
                  {active.map((w) => (
                    <div
                      key={`${w.requestId}-${w.index}`}
                      className="ws-overview-row"
                      onClick={() => {
                        navigate(w.mediaType === "tv" ? `/managed/${w.requestId}` : `/requests/${w.requestId}`);
                        setOpen(false);
                      }}
                    >
                      <div className="ws-overview-row-title">{w.metadata?.name || `Job ${w.index}`}</div>
                      <div className="ws-overview-row-meta">
                        <span>{w.mediaTitle}</span>
                        <span>{w.inputCount} in / {w.outputCount} out</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {completed.length > 0 && (
                <div className="ws-overview-group">
                  <div className="ws-overview-group-label">Completed</div>
                  {completed.map((w) => (
                    <div
                      key={`${w.requestId}-${w.index}`}
                      className="ws-overview-row ws-overview-row-completed"
                      onClick={() => {
                        navigate(w.mediaType === "tv" ? `/managed/${w.requestId}` : `/requests/${w.requestId}`);
                        setOpen(false);
                      }}
                    >
                      <div className="ws-overview-row-title">{w.metadata?.name || `Job ${w.index}`}</div>
                      <div className="ws-overview-row-meta">
                        <span>{w.mediaTitle}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
