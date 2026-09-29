import { useState } from "react";
import { scanDownloadDirs, applyDownloadDirsActions } from "../api";

interface DirEntry {
  type: "movie" | "series";
  name: string;
  path: string;
  isDir: boolean;
  sizeMb: number;
  tracked: boolean;
  trackedName: string;
  trackedHash: string;
  linked: boolean;
  existsInProcessed: boolean;
  videoCount: number;
  matchedRequest?: { id: number; title: string; season: number | null } | null;
}

interface Result {
  path: string;
  action: string;
  ok: boolean;
  detail?: string;
  dest?: string;
  hash?: string;
  linked?: { requestId: number; title: string; existing?: boolean } | null;
  error?: string;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export default function DownloadDirsModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<DirEntry[] | null>(null);
  const [scanError, setScanError] = useState("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [attachPath, setAttachPath] = useState<string | null>(null);
  const [magnet, setMagnet] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileBase64, setFileBase64] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});

  async function runScan() {
    setScanError("");
    setItems(null);
    setResults({});
    try {
      const data = await scanDownloadDirs();
      setItems(data.items || []);
    } catch (e: any) {
      setScanError(e.response?.data?.error || e.message);
    }
  }

  async function apply(path: string, action: "attach" | "link" | "hardlink-process" | "move-process" | "delete", extra: { magnet?: string; torrentFileBase64?: string; torrentFilename?: string; force?: boolean } = {}) {
    setBusyPath(path);
    try {
      const data = await applyDownloadDirsActions({
        items: [{ path, action, ...extra }],
      });
      const result = (data.results || [])[0];
      setResults((prev) => ({ ...prev, [path]: result }));
      const entry = items?.find((i) => i.path === path);
      if (result && result.ok) {
        if (entry) {
          entry.tracked = action === "attach";
          if (result.linked) entry.linked = true;
        }
        if (action === "move-process" || action === "delete") {
          setItems((prev) => (prev ? prev.filter((i) => i.path !== path) : prev));
        }
        setAttachPath(null);
        setMagnet("");
        setFileName("");
        setFileBase64("");
        setConfirmDelete(null);
      }
    } catch (e: any) {
      setResults((prev) => ({ ...prev, [path]: { path, action, ok: false, error: e.response?.data?.error || e.message } }));
    } finally {
      setBusyPath(null);
    }
  }

  async function unlinkEntries() {
    const targets = items?.filter((i) => i.tracked && !i.linked && i.matchedRequest) || [];
    if (targets.length === 0) return;
    setBusyPath("__link_all__");
    try {
      const data = await applyDownloadDirsActions({
        items: targets.map((t) => ({ path: t.path, action: "link" as const })),
      });
      const results = data.results || [];
      const mark = { ...results };
      setResults((prev) => ({ ...prev, ...mark }));
      setItems((prev) => (prev ? prev.map((i) => (targets.some((t) => t.path === i.path) ? { ...i, linked: true } : i)) : prev));
    } catch (e: any) {
      setResults((prev) => ({ ...prev, __link_all__: { path: "__link_all__", action: "link", ok: false, error: e.response?.data?.error || e.message } }));
    } finally {
      setBusyPath(null);
    }
  }

  function onFileSelected(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const idx = dataUrl.indexOf(",");
      setFileBase64(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box download-dirs-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Scan Download Dirs</h3>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            {items
              ? "Content in the download folders that no longer has a qBittorrent torrent. Attach a new torrent (magnet or .torrent), capture into Processed, or delete."
              : "Scans /download/filmy and /download/serialy for entries with no live torrent, then lets you attach, capture, or delete each one."}
          </p>
          {!items && (
            <button className="btn btn-primary btn-tiny" onClick={runScan} disabled={busyPath !== null}>
              Start Scan
            </button>
          )}
          {scanError && <div className="modal-line" style={{ color: "#f87171" }}>Scan error: {scanError}</div>}
          {items && items.length === 0 && <div className="modal-line">Nothing found — all download entries are tracked by qBittorrent (or folders are empty).</div>}
          {items && items.length > 0 && (
            <>
              <div className="download-dirs-summary">
                <span className="badge" style={{ background: "#10b981" }}>{items.filter((i) => i.tracked).length} tracked</span>
                <span className="badge" style={{ background: "#f59e0b" }}>{items.filter((i) => !i.tracked).length} orphaned</span>
                <span className="badge" style={{ background: "#475569" }}>{items.length} total</span>
                <button className="btn btn-secondary btn-tiny" onClick={runScan} disabled={busyPath !== null}>Rescan</button>
                <button
                  className="btn btn-primary btn-tiny"
                  onClick={unlinkEntries}
                  disabled={busyPath !== null || items.filter((i) => i.tracked && !i.linked && i.matchedRequest).length === 0}
                >
                  Link {items.filter((i) => i.tracked && !i.linked && i.matchedRequest).length} unlinked
                </button>
              </div>
              {(() => {
                const orphaned = items.filter((i) => !i.tracked).sort((a, b) => a.name.localeCompare(b.name));
                const tracked = items.filter((i) => i.tracked).sort((a, b) => a.name.localeCompare(b.name));
                return ([] as Array<{ label: string; list: DirEntry[] }>)
                  .concat(orphaned.length > 0 ? [{ label: `Orphaned — no torrent (${orphaned.length})`, list: orphaned }] : [])
                  .concat(tracked.length > 0 ? [{ label: `Tracked by qBittorrent (${tracked.length})`, list: tracked }] : []);
              })().map(({ label, list }) => (
                <div key={label} className="download-dirs-group">
                  <div className="download-dirs-group-title">{label}</div>
                  {list.map((entry) => {
                const r = results[entry.path];
                return (
                  <div key={entry.path} className="download-dirs-item">
                    <div className="download-dirs-item-row">
                      <span className="badge" style={{ background: entry.type === "movie" ? "#3b82f6" : "#8b5cf6" }}>{entry.type}</span>
                      <span className="download-dirs-name" title={entry.path}>{entry.name.length > 70 ? entry.name.slice(0, 70) + "..." : entry.name}</span>
                      <span className="badge" style={{ background: "#6b7280" }}>{formatSize(entry.sizeMb)}</span>
                      {entry.tracked && <span className="badge" style={{ background: "#10b981" }} title={entry.trackedName}>tracked</span>}
                      {!entry.tracked && <span className="badge" style={{ background: entry.existsInProcessed ? "#3b82f6" : "#ef4444" }}>{entry.existsInProcessed ? "in Processed" : "orphan"}</span>}
                      {entry.tracked && (
                        <span className="badge" style={{ background: entry.linked ? "#10b981" : "#f59e0b" }} title={entry.trackedName}>
                          {entry.linked ? "linked" : "unlinked"}
                        </span>
                      )}
                      {entry.matchedRequest && (
                        <span className="badge" style={{ background: "#0ea5e9" }} title="auto-matches this request">
                          → {entry.matchedRequest.title}{entry.matchedRequest.season != null ? ` S${String(entry.matchedRequest.season).padStart(2, "0")}` : ""}
                        </span>
                      )}
                      {busyPath === entry.path && <span style={{ color: "#94a3b8", fontSize: 12 }}>working…</span>}
                    </div>
                    {!entry.tracked && (
                      <div className="download-dirs-actions">
                        {attachPath === entry.path ? (
                          <div className="download-dirs-attach">
                            <input
                              type="text"
                              value={magnet}
                              onChange={(e) => setMagnet(e.target.value)}
                              placeholder="magnet:?xt=urn:btih:…"
                              className="download-dirs-input"
                              disabled={busyPath !== null}
                            />
                            <label className="download-dirs-file">
                              <input type="file" accept=".torrent" onChange={(e) => e.target.files?.[0] && onFileSelected(e.target.files[0])} disabled={busyPath !== null} />
                              {fileName ? `📎 ${fileName}` : "or .torrent file"}
                            </label>
                            <button className="btn btn-primary btn-tiny" disabled={busyPath !== null || (!magnet && !fileBase64)} onClick={() => apply(entry.path, "attach", { magnet, torrentFileBase64: fileBase64, torrentFilename: fileName })}>
                              Add
                            </button>
                            <button className="btn btn-secondary btn-tiny" onClick={() => setAttachPath(null)} disabled={busyPath !== null}>Cancel</button>
                          </div>
                        ) : (
                          <button className="btn btn-secondary btn-tiny" onClick={() => setAttachPath(entry.path)} disabled={busyPath !== null}>Attach</button>
                        )}
                        <button className="btn btn-secondary btn-tiny" onClick={() => apply(entry.path, "hardlink-process")} disabled={busyPath !== null}>To Processed</button>
                        <button className="btn btn-secondary btn-tiny" onClick={() => apply(entry.path, "move-process")} disabled={busyPath !== null}>Move</button>
                        {confirmDelete === entry.path ? (
                          <button className="btn btn-danger btn-tiny" onClick={() => apply(entry.path, "delete", { force: !entry.existsInProcessed })} disabled={busyPath !== null}>
                            {entry.existsInProcessed ? "Confirm Delete" : "Force Delete (not in Processed)"}
                          </button>
                        ) : (
                          <button className="btn btn-danger btn-tiny" onClick={() => setConfirmDelete(entry.path)} disabled={busyPath !== null}>Delete</button>
                        )}
                        {!entry.existsInProcessed && <span style={{ color: "#f59e0b", fontSize: 12 }}>⚠ not in Processed</span>}
                      </div>
                    )}
                    {entry.tracked && !entry.linked && entry.matchedRequest && (
                      <div className="download-dirs-actions">
                        <button className="btn btn-primary btn-tiny" onClick={() => apply(entry.path, "link")} disabled={busyPath !== null}>
                          Link to request
                        </button>
                        <span style={{ color: "#94a3b8", fontSize: 12 }}>torrent exists but isn't shown as a version yet</span>
                      </div>
                    )}
                    {r && (
                      <div className="modal-line" style={{ color: r.ok ? "#10b981" : "#f87171", fontSize: 12 }}>
                        {r.ok
                          ? `✓ ${r.action}: ${r.detail || "ok"}${r.dest ? ` → ${r.dest}` : ""}${r.linked ? ` · linked to request "${r.linked.title}"${r.linked.existing ? " (already linked)" : ""}` : r.action === "attach" ? " · no matching request found" : ""}`
                          : `✗ ${r.error || "failed"}`}
                      </div>
                    )}
                  </div>
                );
              })}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}