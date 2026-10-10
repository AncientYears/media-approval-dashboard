import { useEffect, useState } from "react";
import { applyNormalizeProcessed, previewNormalizeProcessed } from "../api";

interface PlanItem {
  file: string;
  source: string;
  destination: string;
  ownerRequestId: number;
  ownerTitle: string;
  season: number;
  evidence: "association" | "identity" | "name";
  warning: string | null;
}

interface PlanSkip {
  file: string;
  source: string;
  reason: string;
}

const EVIDENCE_LABEL: Record<PlanItem["evidence"], string> = {
  association: "own bookkeeping",
  identity: "identity row",
  name: "filename",
};

const EVIDENCE_COLOR: Record<PlanItem["evidence"], string> = {
  association: "#10b981",
  identity: "#f59e0b",
  name: "#3b82f6",
};

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

export default function NormalizeProcessedModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<PlanItem[]>([]);
  const [skips, setSkips] = useState<PlanSkip[]>([]);
  const [processedDir, setProcessedDir] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    setOutcome("");
    try {
      const plan = await previewNormalizeProcessed();
      setItems(plan.items || []);
      setSkips(plan.skips || []);
      setProcessedDir(plan.processedDir || "");
      // Pre-select everything EXCEPT rows that carry a warning — those need a
      // deliberate opt-in, since a mis-attributed identity is exactly the case
      // this preview exists to catch.
      setSelected(new Set((plan.items || []).filter((i) => !i.warning).map((i) => i.file)));
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Could not build the plan");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(file: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  async function apply() {
    if (selected.size === 0) return;
    setApplying(true);
    setError("");
    setOutcome("");
    try {
      const res = await applyNormalizeProcessed([...selected]);
      setOutcome(
        `Moved ${res.moved.length} file(s)${res.failed.length ? `, ${res.failed.length} failed` : ""}.` +
          (res.failed.length ? `\n${res.failed.map((f) => `  ! ${f.file}: ${f.error}`).join("\n")}` : ""),
      );
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  const moveCount = items.length;
  const skipCount = skips.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 900, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
      >
        <h3 className="modal-title">Normalize Processed Tree</h3>
        <div className="modal-body" style={{ overflowY: "auto", flex: 1 }}>
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
            Series files sitting directly in the processed root are legacy leftovers (the old “Complete &amp; Import”
            dropped them there). This moves the ones you tick into their canonical{" "}
            <code>&lt;Show&gt;/&lt;Sxx&gt;/</code> folder. Renames are inode-preserving; nothing is moved until you
            press Apply.
            {processedDir ? (
              <>
                <br />
                <span style={{ opacity: 0.7 }}>{processedDir}</span>
              </>
            ) : null}
          </p>

          {error && <div className="modal-line" style={{ color: "#f87171" }}>{error}</div>}
          {outcome && (
            <div className="modal-line" style={{ color: "#10b981", whiteSpace: "pre-wrap" }}>
              {outcome}
            </div>
          )}

          {loading ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>Scanning processed root…</div>
          ) : moveCount === 0 ? (
            <div className="modal-line" style={{ color: "#94a3b8" }}>
              Nothing to normalize — no attributable series files in the processed root.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {items.map((it) => {
                const checked = selected.has(it.file);
                return (
                  <label
                    key={it.source}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: checked ? "rgba(16,185,129,0.08)" : "rgba(148,163,184,0.07)",
                      border: it.warning ? "1px solid #f59e0b55" : "1px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(it.file)}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{it.file}</span>
                        <span
                          className="badge"
                          style={{ background: `${EVIDENCE_COLOR[it.evidence]}22`, color: EVIDENCE_COLOR[it.evidence], fontSize: 11 }}
                          title="Why this file was attributed to this request"
                        >
                          {EVIDENCE_LABEL[it.evidence]}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                        → {dirOf(it.destination)}
                      </div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                        owner: {it.ownerTitle} · S{String(it.season).padStart(2, "0")} (request #{it.ownerRequestId})
                      </div>
                      {it.warning && (
                        <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>⚠ {it.warning}</div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {skipCount > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#94a3b8" }}>
                {skipCount} file(s) left alone
              </summary>
              <div style={{ marginTop: 6, fontSize: 12, color: "#64748b", display: "flex", flexDirection: "column", gap: 3 }}>
                {skips.map((s) => (
                  <div key={s.source}>
                    <span style={{ color: "#94a3b8" }}>{s.file}</span> — {s.reason}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={load} disabled={loading || applying}>
            Rescan
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={applying}>
            Close
          </button>
          <button className="btn btn-primary" onClick={apply} disabled={applying || selected.size === 0}>
            {applying ? "Moving…" : `Move ${selected.size} file(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
