import { useCallback, useEffect, useState } from "react";
import { fixNamesApply, fixNamesPreview } from "../api";

interface FixNameRow {
  id: string;
  ino: number | null;
  path: string;
  tree: "processed" | "library";
  currentName: string;
  proposedName: string | null;
  role: "movie" | "special" | "episode" | null;
  note: string | null;
}

interface FixNameGroup {
  id: string;
  ino: number | null;
  processed: FixNameRow | null;
  library: FixNameRow | null;
}

export default function FixNamesModal({
  requestId,
  title,
  onClose,
  onApplied,
}: {
  requestId: number;
  title: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [groups, setGroups] = useState<FixNameGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [applySummary, setApplySummary] = useState<string>("");
  const [failures, setFailures] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setFailures([]);
    setApplySummary("");
    try {
      const data = await fixNamesPreview(requestId);
      const gs: FixNameGroup[] = data.groups || [];
      setGroups(gs);
      const sel: Record<string, boolean> = {};
      for (const g of gs) {
        for (const row of [g.processed, g.library]) {
          if (row && row.proposedName) sel[row.id] = true;
        }
      }
      setSelected(sel);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Failed to build preview");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const selectedPaths = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([id]) => {
      for (const g of groups) {
        if (g.processed?.id === id) return g.processed;
        if (g.library?.id === id) return g.library;
      }
      return null;
    })
    .filter((r): r is FixNameRow => r !== null)
    .map((r) => r.path);

  async function apply() {
    if (selectedPaths.length === 0) return;
    setApplying(true);
    setApplySummary("");
    setFailures([]);
    try {
      const data = await fixNamesApply(requestId, selectedPaths);
      const results: any[] = data.results || [];
      const ok = results.filter((r) => r.ok && !r.skipped).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => !r.ok);
      setApplySummary(`Renamed ${ok}, already canonical ${skipped}, failed ${failed.length}.`);
      setFailures(failed.map((f) => `${f.path}: ${f.error}`));
      onApplied();
      await load();
    } catch (e: any) {
      setApplySummary("Apply failed.");
      setFailures([e.response?.data?.error || e.message || "Unknown error"]);
    } finally {
      setApplying(false);
    }
  }

  const selectableCount = groups.filter(
    (g) => (g.processed?.proposedName) || (g.library?.proposedName)
  ).length;

  function Row({ row, nested }: { row: FixNameRow; nested?: boolean }) {
    const renamable = !!row.proposedName;
    const checked = !!selected[row.id];
    const note = row.note || (renamable ? null : "Already canonical");
    return (
      <div
        className={`fixname-row${nested ? " fixname-row-nested" : ""}`}
        onClick={() => renamable && toggle(row.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderRadius: 6,
          cursor: renamable ? "pointer" : "default",
          background: renamable && checked ? "rgba(59,130,246,0.12)" : "transparent",
          opacity: renamable ? 1 : 0.6,
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!renamable}
          onChange={(e) => { e.stopPropagation(); toggle(row.id); }}
        />
        <span className="badge" style={{
          fontSize: 10,
          background: row.tree === "processed" ? "#3b82f6" : "#8b5cf6",
          flexShrink: 0,
        }}>
          {row.tree === "processed" ? "PROCESSED" : "LIBRARY"}
        </span>
        <span style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", flex: 1 }}>
          {renamable ? (
            <>
              <span style={{ color: "#cbd5e1", textDecoration: "line-through" }}>{row.currentName}</span>
              <span style={{ color: "#94a3b8" }}> → </span>
              <span style={{ color: "#10b981" }}>{row.proposedName}</span>
            </>
          ) : (
            <span style={{ color: "#94a3b8" }}>{row.currentName}</span>
          )}
        </span>
        {note && <span style={{ fontSize: 11, color: "#f59e0b", flexShrink: 0 }}>{note}</span>}
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box fixnames-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Fix Names</h3>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            Standardize filenames for <strong style={{ color: "#cbd5e1" }}>{title}</strong> to the
            canonical template. Renames keep the file{`'`}s inode — hardlinked library copies and
            identity stay intact.
          </p>
          {error && <div className="modal-line" style={{ color: "#f87171", marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>Scanning processed + library files…</div>
          ) : groups.length === 0 ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>No files to rename.</div>
          ) : (
            <div className="fixname-list" style={{ maxHeight: "42vh", overflowY: "auto", border: "1px solid #334155", borderRadius: 8, padding: 6 }}>
              {groups.map((g) => (
                <div key={g.id} style={{ marginBottom: 2 }}>
                  {g.processed ? <Row row={g.processed} /> : null}
                  {g.library ? <Row row={g.library} nested /> : null}
                </div>
              ))}
            </div>
          )}
          {!loading && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
              {selectedPaths.length} of {selectableCount} renamable file{selectableCount === 1 ? "" : "s"} selected.
            </div>
          )}
          {applySummary && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <span style={{ color: "#10b981" }}>{applySummary}</span>
              {failures.length > 0 && (
                <div style={{ marginTop: 4, color: "#f87171", fontSize: 12, maxHeight: 100, overflowY: "auto" }}>
                  {failures.map((f, i) => <div key={i}>{f}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={applying}>Close</button>
          <button
            className="btn btn-primary"
            onClick={apply}
            disabled={!loading && selectedPaths.length === 0}
          >
            {applying ? "Applying…" : `Apply (${selectedPaths.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}