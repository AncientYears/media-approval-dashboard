import { useState, useRef, useEffect } from "react";
import { fetchWorkspaces, updateWorkspaceMetadata, completeWorkspace, deleteWorkspaceFile, deleteWorkspace } from "../api";
import ScriptDropdown from "./ScriptDropdown";

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

export interface WorkspaceManagerModalProps {
  open: boolean;
  requestId: number;
  workspaceIndex: number;
  onClose: () => void;
  onRefresh?: () => void;
}

export default function WorkspaceManagerModal({ open, requestId, workspaceIndex, onClose, onRefresh }: WorkspaceManagerModalProps) {
  const [ws, setWs] = useState<any>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  const load = () => {
    fetchWorkspaces(requestId).then((data) => {
      const list = data.workspaces || [];
      const found = list.find((w: any) => w.index === workspaceIndex);
      setWs(found || null);
    }).catch(() => {});
  };

  useEffect(() => {
    if (open) load();
  }, [open, requestId, workspaceIndex]);

  useEffect(() => {
    if (editIdx !== null && editRef.current) editRef.current.focus();
  }, [editIdx]);

  if (!open || !ws) return null;

  const meta = ws.metadata || {};

  const refreshAndReload = () => {
    if (onRefresh) onRefresh();
    load();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {editIdx === ws.index ? (
              <input
                ref={editRef}
                className="workspace-edit-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={async () => {
                  if (editValue.trim()) {
                    await updateWorkspaceMetadata(requestId, ws.index, { name: editValue.trim() });
                    refreshAndReload();
                  }
                  setEditIdx(null);
                }}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && editValue.trim()) {
                    await updateWorkspaceMetadata(requestId, ws.index, { name: editValue.trim() });
                    refreshAndReload();
                    setEditIdx(null);
                  }
                  if (e.key === "Escape") setEditIdx(null);
                }}
              />
            ) : (
              <h3 style={{ margin: 0, cursor: "pointer" }} onClick={() => { setEditValue(meta.name || `Job ${ws.index}`); setEditIdx(ws.index); }}>
                {meta.name || `Job ${ws.index}`}
              </h3>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="ws-manager-meta">
            <span>{ws.inputCount} input{ws.inputCount !== 1 ? "s" : ""}</span>
            <span>{ws.outputCount} output{ws.outputCount !== 1 ? "s" : ""}</span>
            <span className="ws-manager-date">{new Date(meta.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="ws-manager-section-label">Notes</div>
          <textarea
            className="ws-manager-notes-input"
            rows={2}
            placeholder="Add notes about this workspace..."
            value={meta.notes || ""}
            onChange={(e) => { setWs({ ...ws, metadata: { ...meta, notes: e.target.value } }); }}
            onBlur={async () => { await updateWorkspaceMetadata(requestId, ws.index, { notes: meta.notes || "" }); }}
          />
          <div className="ws-manager-section-label">Scripts</div>
          <ScriptDropdown
            value={meta.scripts || []}
            onChange={async (next) => {
              setWs({ ...ws, metadata: { ...meta, scripts: next } });
              await updateWorkspaceMetadata(requestId, ws.index, { scripts: next } as any);
            }}
            placeholder="Select scripts..."
          />
          <div className="ws-manager-section">
            <div className="ws-manager-section-label">Inputs ({ws.inputCount})</div>
            {ws.inputFiles?.length > 0 ? (
              ws.inputFiles.map((f: any) => (
                <div key={f.name} className="ws-manager-output-path ws-file-row">
                  <span className="ws-file-exists">{f.exists ? "\u25CF" : "\u25CB"}</span>
                  <span className="ws-file-name" title={f.name}>{f.name}</span>
                  <span className="ws-file-size">{formatBytes(f.size)}</span>
                  <button className="btn btn-danger btn-tiny" title="Delete" onClick={async () => {
                    await deleteWorkspaceFile(requestId, ws.index, "inputs", f.name);
                    refreshAndReload();
                  }}>&times;</button>
                </div>
              ))
            ) : (
              <div className="ws-manager-empty">No input files</div>
            )}
          </div>
          <div className="ws-manager-section">
            <div className="ws-manager-section-label">Outputs ({ws.outputCount})</div>
            {ws.outputFiles?.length > 0 ? (
              ws.outputFiles.map((f: any) => (
                <div key={f.name} className="ws-manager-output-path ws-file-row">
                  <span className="ws-file-exists">{f.exists ? "\u25CF" : "\u25CB"}</span>
                  <span className="ws-file-name" title={`${f.name} - Click to copy`} onClick={() => navigator.clipboard.writeText(f.name)}>{f.name}</span>
                  <span className="ws-file-size">{formatBytes(f.size)}</span>
                  <button className="btn btn-danger btn-tiny" title="Delete" onClick={async () => {
                    await deleteWorkspaceFile(requestId, ws.index, "output", f.name);
                    refreshAndReload();
                  }}>&times;</button>
                </div>
              ))
            ) : (
              <div className="ws-manager-empty">Place processed files in workspace/output/</div>
            )}
          </div>
          {meta.outputPaths?.length > 0 && (
            <div className="ws-manager-section ws-manager-processed">
              <div className="ws-manager-section-label">Processed</div>
              {meta.outputPaths.map((p: string, i: number) => (
                <div key={i} className="ws-manager-output-path" title="Click to copy" onClick={() => navigator.clipboard.writeText(p)}>
                  {p}
                </div>
              ))}
            </div>
          )}
          <div className="ws-manager-actions">
            <button
              className={`btn btn-tiny ${ws.outputCount > 0 ? "btn-primary" : "btn-secondary btn-disabled"}`}
              disabled={ws.outputCount === 0 || meta.status === "completed"}
              title={ws.outputCount === 0 ? "Add output files to enable" : ""}
              onClick={async () => {
                if (!confirm(`Complete "${meta.name || `Job ${ws.index}`}"? Inputs will be deleted, outputs moved to /Processed. Radarr/Sonarr will scan and import.`)) return;
                await completeWorkspace(requestId, ws.index);
                refreshAndReload();
                onClose();
              }}
            >
              {meta.status === "completed" ? "Completed" : "Complete & Import"}
            </button>
            <button className="btn btn-danger btn-tiny" onClick={async () => {
              if (!confirm(`Delete workspace "${meta.name || `Job ${ws.index}`}"? This cannot be undone.`)) return;
              await deleteWorkspace(requestId, ws.index);
              if (onRefresh) onRefresh();
              onClose();
            }}>Delete Job</button>
          </div>
        </div>
      </div>
    </div>
  );
}
