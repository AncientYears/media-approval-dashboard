import { useState, useRef } from "react";
import { importTorrent } from "../api";

export interface ImportModalProps {
  open: boolean;
  requestId: number;
  onClose: () => void;
  onImported?: () => void;
}

export default function ImportModal({ open, requestId, onClose, onImported }: ImportModalProps) {
  const [mode, setMode] = useState<"magnet" | "file">("magnet");
  const [magnetUrl, setMagnetUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileBase64, setFileBase64] = useState("");
  const [bypassApproval, setBypassApproval] = useState(true);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; title?: string; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] || "";
      setFileBase64(base64);
    };
    reader.readAsDataURL(file);
  };

  const handleImport = async () => {
    if (mode === "magnet" && !magnetUrl.trim()) return;
    if (mode === "file" && !fileBase64) return;

    setImporting(true);
    setResult(null);
    try {
      const params: any = { bypassApproval };
      if (mode === "magnet") {
        params.magnetUrl = magnetUrl.trim();
      } else {
        params.torrentFileBase64 = fileBase64;
        params.torrentFilename = fileName;
      }
      const res = await importTorrent(requestId, params);
      setResult({ success: true, title: res.title });
      if (onImported) onImported();
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setResult({ success: false, error: err.response?.data?.error || err.message });
    }
    setImporting(false);
  };

  const canImport = mode === "magnet" ? magnetUrl.trim().length > 0 : fileBase64.length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Import Torrent</h3>
        <div className="modal-body">
          <div className="import-mode-toggle" style={{ display: "flex", gap: 4, marginBottom: 12 }}>
            <button className={`btn btn-tiny ${mode === "magnet" ? "btn-primary" : "btn-secondary"}`} onClick={() => setMode("magnet")}>Magnet Link</button>
            <button className={`btn btn-tiny ${mode === "file" ? "btn-primary" : "btn-secondary"}`} onClick={() => setMode("file")}>.torrent File</button>
          </div>

          {mode === "magnet" ? (
            <input
              className="input"
              type="text"
              placeholder="magnet:?xt=urn:btih:..."
              value={magnetUrl}
              onChange={(e) => setMagnetUrl(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          ) : (
            <div>
              <input ref={fileRef} type="file" accept=".torrent" onChange={handleFileChange} style={{ display: "none" }} />
              <button className="btn btn-secondary btn-tiny" onClick={() => fileRef.current?.click()}>
                {fileName || "Choose .torrent file"}
              </button>
              {fileName && (
                <span style={{ marginLeft: 8, color: "#94a3b8", fontSize: "0.85em" }}>{fileName}</span>
              )}
            </div>
          )}

          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.9em" }}>
              <input type="checkbox" checked={bypassApproval} onChange={(e) => setBypassApproval(e.target.checked)} />
              Skip approval &amp; start downloading immediately
            </label>
          </div>
          {!bypassApproval && (
            <div style={{ marginTop: 4, fontSize: "0.8em", color: "#94a3b8" }}>
              Torrent will appear as a release candidate for manual approval.
            </div>
          )}

          {result && (
            <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, background: result.success ? "#166534" : "#7f1d1d", fontSize: "0.9em" }}>
              {result.success ? `Imported: ${result.title}` : `Error: ${result.error}`}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={handleImport} disabled={!canImport || importing}>
            {importing ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
