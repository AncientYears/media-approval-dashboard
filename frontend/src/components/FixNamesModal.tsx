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

interface FixNameDirRow {
  id: string;
  path: string;
  tree: "processed" | "library";
  kind: "show" | "season" | "movie";
  currentName: string;
  proposedName: string | null;
  note: string | null;
}

interface FixNameGroup {
  id: string;
  ino: number | null;
  processed: FixNameRow | null;
  library: FixNameRow | null;
}

interface NameRow {
  id: string;
  path: string;
  currentName: string;
  proposedName: string | null;
  note: string | null;
  label: string;
  badge: "processed" | "library" | "dir" | "libdir";
}

type FixMode = "all" | "top" | "season" | "files";

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
  const [dirs, setDirs] = useState<FixNameDirRow[]>([]);
  const [mode, setMode] = useState<FixMode>("all");
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
      const ds: FixNameDirRow[] = data.dirs || [];
      setGroups(gs);
      setDirs(ds);
      const sel: Record<string, boolean> = {};
      for (const g of gs) {
        for (const row of [g.processed, g.library]) {
          if (row && row.proposedName) sel[row.id] = true;
        }
      }
      for (const d of ds) {
        if (d.proposedName) sel[d.id] = true;
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

  // Flatten everything into rows the selection map can address uniformly.
  const dirRows: NameRow[] = dirs.map((d): NameRow => ({
    id: d.id,
    path: d.path,
    currentName: d.currentName,
    proposedName: d.proposedName,
    note: d.note,
    label: `${d.kind} dir`,
    badge: d.tree === "library" ? "libdir" : "dir",
  }));
  const fileRows: NameRow[] = groups.flatMap((g) => {
    const rows: NameRow[] = [];
    if (g.processed) rows.push({
      id: g.processed.id,
      path: g.processed.path,
      currentName: g.processed.currentName,
      proposedName: g.processed.proposedName,
      note: g.processed.note,
      label: "file",
      badge: "processed",
    });
    if (g.library) rows.push({
      id: g.library.id,
      path: g.library.path,
      currentName: g.library.currentName,
      proposedName: g.library.proposedName,
      note: g.library.note,
      label: "library twin",
      badge: "library",
    });
    return rows;
  });
  // Per-layer mode: top = top-level folders (show/movie), season = season
  // folders, files = the per-file rows. Hidden layers keep their selection but
  // are excluded from Select-all and Apply so switching modes is always safe.
  const showDirs = mode !== "files";
  const topOnly = mode === "top";
  const seasonOnly = mode === "season";
  const visibleDirs = showDirs && !topOnly && !seasonOnly ? dirRows
    : showDirs && topOnly ? dirRows.filter((r) => r.label === "show dir" || r.label === "movie dir")
    : showDirs && seasonOnly ? dirRows.filter((r) => r.label === "season dir")
    : [];
  const visibleFiles = mode === "all" || mode === "files" ? fileRows : [];
  const visibleGroups = mode === "all" || mode === "files" ? groups : [];
  const visibleRows = [...visibleDirs, ...visibleFiles];

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function selectAll() {
    const sel: Record<string, boolean> = {};
    for (const r of visibleRows) {
      if (r.proposedName) sel[r.id] = true;
    }
    setSelected(sel);
  }

  function deselectAll() {
    const sel: Record<string, boolean> = {};
    for (const id of Object.keys(selected)) {
      if (!visibleRows.some((r) => r.id === id)) sel[id] = selected[id];
    }
    setSelected(sel);
  }

  const selectedPaths = visibleRows.filter((r) => selected[r.id]).map((r) => r.path);
  const selectableCount = visibleRows.filter((r) => r.proposedName).length;

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

  function Row({ row, nested }: { row: NameRow; nested?: boolean }) {
    const renamable = !!row.proposedName;
    const checked = !!selected[row.id];
    const note = row.note || (renamable ? null : "Already canonical");
    const badgeLabel =
      row.badge === "dir" ? "DIR" : row.badge === "libdir" ? "LIB DIR" : row.badge === "library" ? "LIBRARY" : "PROCESSED";
    const badgeColor = row.badge === "dir" ? "#0ea5e9" : row.badge === "libdir" ? "#06b6d4" : row.badge === "library" ? "#8b5cf6" : "#3b82f6";
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
        <span className="badge" style={{ fontSize: 10, background: badgeColor, flexShrink: 0 }}>
          {badgeLabel}
        </span>
        <span style={{ fontFamily: "monospace", fontSize: 12, flex: 1, minWidth: 0 }}>
          {renamable ? (
            <>
              <div style={{ color: "#f87171", textDecoration: "line-through", textDecorationColor: "#7f1d1d", wordBreak: "break-all" }}>{row.currentName}</div>
              <div style={{ color: "#10b981", wordBreak: "break-all" }}>→ {row.proposedName}</div>
            </>
          ) : (
            <div style={{ color: "#94a3b8", wordBreak: "break-all" }}>{row.currentName}</div>
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
            Standardize names for <strong style={{ color: "#cbd5e1" }}>{title}</strong> to the canonical
            template. Red = current, green = proposed. File renames keep the file{`'`}s inode
            (hardlinked library copies stay intact). Folder renames cover both the processed
            and library trees, only for folders this request owns outright — a folder that
            holds files of another franchise is never proposed. Rename top-down (show folder
            first), then switch layers to finish each.
          </p>
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {([
              ["all", "All"],
              ["top", "Top dirs"],
              ["season", "Season dirs"],
              ["files", "Files"],
            ] as [FixMode, string][]).map(([m, label]) => (
              <button
                key={m}
                className="btn btn-secondary btn-tiny"
                onClick={() => setMode(m)}
                style={mode === m ? { background: "#2563eb", color: "#fff", borderColor: "#2563eb" } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          {error && <div className="modal-line" style={{ color: "#f87171", marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>Scanning processed + library files…</div>
          ) : visibleRows.length === 0 ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>Nothing to rename in this layer.</div>
          ) : (
            <div className="fixname-list" style={{ maxHeight: "46vh", overflowY: "auto", border: "1px solid #334155", borderRadius: 8, padding: 6 }}>
              {visibleDirs.length > 0 && (
                <div style={{ fontSize: 11, color: "#64748b", padding: "4px 8px", fontWeight: 600 }}>FOLDERS</div>
              )}
              {visibleDirs.map((d) => <Row key={d.id} row={d} />)}
              {visibleDirs.length > 0 && visibleFiles.length > 0 && (
                <div style={{ fontSize: 11, color: "#64748b", padding: "4px 8px 4px 8px", fontWeight: 600, marginTop: 6 }}>FILES</div>
              )}
              {visibleGroups && visibleGroups.map((g) => (
                <div key={g.id} style={{ marginBottom: 2 }}>
                  {g.processed && (
                    <Row row={{
                      id: g.processed.id,
                      path: g.processed.path,
                      currentName: g.processed.currentName,
                      proposedName: g.processed.proposedName,
                      note: g.processed.note,
                      label: "file",
                      badge: "processed",
                    }} />
                  )}
                  {g.library && (
                    <Row nested row={{
                      id: g.library.id,
                      path: g.library.path,
                      currentName: g.library.currentName,
                      proposedName: g.library.proposedName,
                      note: g.library.note,
                      label: "library twin",
                      badge: "library",
                    }} />
                  )}
                </div>
              ))}
            </div>
          )}
          {!loading && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span>{selectedPaths.length} of {selectableCount} renamable item{selectableCount === 1 ? "" : "s"} selected.</span>
              {selectableCount > 0 && (
                <>
                  <button className="btn btn-secondary btn-tiny" onClick={selectAll}>Select all</button>
                  <button className="btn btn-secondary btn-tiny" onClick={deselectAll}>Deselect all</button>
                </>
              )}
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