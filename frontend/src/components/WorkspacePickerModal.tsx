import { useState, useEffect } from "react";
import ScriptDropdown from "./ScriptDropdown";

export interface WorkspacePickerWorkspace {
  index: number;
  inputCount: number;
  outputCount: number;
  metadata?: { name?: string; notes?: string; scripts?: string[]; status?: string; createdAt?: string };
  inputFiles?: { name: string; size: number; exists: boolean }[];
}

export interface WorkspacePickerProps {
  open: boolean;
  title?: string;
  fileName?: string;
  workspaces: WorkspacePickerWorkspace[];
  defaultName?: string;
  onMove: (config: { workspaceIndex?: number; name?: string; notes?: string; scripts?: string[] }) => void;
  onCancel: () => void;
  busy?: boolean;
}

export default function WorkspacePickerModal({
  open,
  title,
  fileName,
  workspaces,
  defaultName = "",
  onMove,
  onCancel,
  busy,
}: WorkspacePickerProps) {
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [newName, setNewName] = useState(defaultName);
  const [newNotes, setNewNotes] = useState("");
  const [newScripts, setNewScripts] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setNewName(defaultName);
      setNewNotes("");
      setNewScripts([]);
    }
  }, [open, defaultName]);

  if (!open) return null;

  const handleMove = () => {
    if (selected === null) return;
    if (selected === "new") {
      onMove({
        name: newName || undefined,
        notes: newNotes || undefined,
        scripts: newScripts.length > 0 ? newScripts : undefined,
      });
    } else {
      onMove({ workspaceIndex: selected });
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title || "Move to Workspace"}</span>
          <button className="modal-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="modal-body">
          {fileName && (
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
              Moving: <strong>{fileName}</strong>
            </p>
          )}

          {workspaces.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Existing Workspaces</div>
              {workspaces.map((ws) => {
                const label = ws.metadata?.name || `Job ${ws.index}`;
                const isSelected = selected === ws.index;
                return (
                  <button
                    key={ws.index}
                    className={`btn ws-picker-row ${isSelected ? "ws-picker-row-selected" : "btn-secondary"}`}
                    style={{ width: "100%", marginBottom: 4, textAlign: "left", fontSize: 12 }}
                    onClick={() => setSelected(isSelected ? null : ws.index)}
                  >
                    <span>{label}</span>
                    <span style={{ opacity: 0.6 }}>{ws.inputCount} in / {ws.outputCount} out</span>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4 }}>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>New Workspace</div>
            <input className="ws-manager-input" placeholder="Name..." value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: "100%", marginBottom: 4 }} onClick={() => setSelected("new")} />
            {selected === "new" && (
              <>
                <textarea className="ws-manager-notes-input" rows={2} placeholder="Add notes about this workspace..." value={newNotes} onChange={(e) => setNewNotes(e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
                <ScriptDropdown value={newScripts} onChange={setNewScripts} placeholder="Select scripts..." />
              </>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <button
              className="btn btn-primary"
              style={{ width: "100%" }}
              onClick={handleMove}
              disabled={selected === null || busy}
            >
              {busy ? "Moving..." : selected === "new" ? "Create & Move" : "Move"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
