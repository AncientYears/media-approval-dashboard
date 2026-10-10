import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { fetchActiveWorkspaces } from "../api";

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

  const activeCount = workspaces.filter((w) => w.metadata?.status !== "completed").length;

  return (
    <div className="ws-overview-wrapper" ref={ref}>
      <button className="ws-overview-toggle" onClick={() => setOpen(!open)}>
        {activeCount > 0 && <span className="ws-overview-badge">{activeCount}</span>}
        Workspaces
      </button>
      {open && (
        <div className="ws-overview-dropdown">
          {loading ? (
            <div className="ws-overview-loading">Loading...</div>
          ) : workspaces.length === 0 ? (
            <div className="ws-overview-empty">No workspaces</div>
          ) : (
            workspaces.map((w) => {
              const isCompleted = w.metadata?.status === "completed";
              return (
                <div
                  key={`${w.requestId}-${w.index}`}
                  className={`ws-overview-row ${isCompleted ? "ws-overview-row-completed" : ""}`}
                  onClick={() => {
                    // A series workspace opens its franchise view: arr-linked
                    // groups key off sonarr_id, native groups off the request id
                    // (/native/:id). Sending a native request id to /managed/:id
                    // made FranchiseDetail fetch it as a sonarr id and fail.
                    const target = w.mediaType === "series"
                      ? (w.sonarrId ? `/managed/${w.sonarrId}` : `/native/${w.requestId}`)
                      : `/requests/${w.requestId}`;
                    navigate(target);
                    setOpen(false);
                  }}
                >
                  <span className={`ws-overview-dot ${isCompleted ? "ws-dot-done" : "ws-dot-active"}`} />
                  <div>
                    <div className="ws-overview-row-title">{w.metadata?.name || `Job ${w.index}`}</div>
                    <div className="ws-overview-row-meta">
                      <span>{w.mediaTitle}</span>
                      {w.inputCount > 0 && <span>{w.inputCount} in</span>}
                      {w.outputCount > 0 && <span>{w.outputCount} out</span>}
                      {isCompleted && <span>done</span>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
