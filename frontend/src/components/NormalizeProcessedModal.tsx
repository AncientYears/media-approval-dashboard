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

interface StaleIdentity {
  dev: number;
  inode: number;
  path: string;
  tree: "processed" | "library";
  folder: string;
  season: number;
  claimedKey: string;
  claimedTitle: string;
  action: "repoint" | "clear";
  ownerKey: string | null;
  ownerTitle: string | null;
  evidence: string;
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

function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function idKey(i: { dev: number; inode: number }): string {
  return `${i.dev}:${i.inode}`;
}

export default function NormalizeProcessedModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<PlanItem[]>([]);
  const [identities, setIdentities] = useState<StaleIdentity[]>([]);
  const [skips, setSkips] = useState<PlanSkip[]>([]);
  const [processedDir, setProcessedDir] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    setOutcome("");
    try {
      const plan = await previewNormalizeProcessed();
      setItems(plan.items || []);
      setIdentities(plan.staleIdentity || []);
      setSkips(plan.skips || []);
      setProcessedDir(plan.processedDir || "");
      // Pre-select everything EXCEPT rows that carry a warning — those need a
      // deliberate opt-in, since a mis-attributed identity is exactly the case
      // this preview exists to catch.
      setSelected(new Set((plan.items || []).filter((i) => !i.warning).map((i) => i.file)));
      setSelectedIds(new Set((plan.staleIdentity || []).filter((i) => !i.warning).map(idKey)));
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

  function toggleId(key: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply() {
    if (selected.size === 0 && selectedIds.size === 0) return;
    setApplying(true);
    setError("");
    setOutcome("");
    try {
      const chosen = identities.filter((i) => selectedIds.has(idKey(i)));
      const res = await applyNormalizeProcessed(
        [...selected],
        chosen.map((i) => ({ dev: i.dev, inode: i.inode })),
      );
      const lines: string[] = [];
      lines.push(`Moved ${res.moved.length} file(s)${res.failed.length ? `, ${res.failed.length} failed` : ""}.`);
      const idOk = res.identityApplied?.length || 0;
      const idFail = res.identityFailed?.length || 0;
      if (idOk || idFail) {
        const repointed = (res.identityApplied || []).filter((i) => i.action === "repoint").length;
        const cleared = (res.identityApplied || []).filter((i) => i.action === "clear").length;
        lines.push(
          `Identity: ${repointed} re-pointed, ${cleared} cleared${idFail ? `, ${idFail} failed` : ""}.`,
        );
      }
      for (const f of res.failed) lines.push(`  ! ${f.file}: ${f.error}`);
      for (const f of res.identityFailed || []) lines.push(`  ! ${baseOf(f.path)}: ${f.error}`);
      setOutcome(lines.join("\n"));
      await load();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  const moveCount = items.length;
  const staleCount = identities.length;
  const skipCount = skips.length;
  const totalSelected = selected.size + selectedIds.size;

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
            <code>&lt;Show&gt;/&lt;Sxx&gt;/</code> folder. It also lists <strong>stale identities</strong>: files whose
            identity is registered to a different show than the folder they sit in. Renames are inode-preserving;
            nothing is changed until you press Apply.
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
            <div className="modal-line" style={{ color: "#94a3b8" }}>Scanning processed tree…</div>
          ) : (
            <>
              {moveCount === 0 && staleCount === 0 && (
                <div className="modal-line" style={{ color: "#94a3b8" }}>
                  Nothing to normalize — no attributable series strays and no stale identities.
                </div>
              )}

              {moveCount > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Relocate strays ({moveCount})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                          <input type="checkbox" checked={checked} onChange={() => toggle(it.file)} style={{ marginTop: 3 }} />
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
                            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>→ {dirOf(it.destination)}</div>
                            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                              owner: {it.ownerTitle} · S{String(it.season).padStart(2, "0")} (request #{it.ownerRequestId})
                            </div>
                            {it.warning && <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>⚠ {it.warning}</div>}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {staleCount > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Stale identities ({staleCount})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {identities.map((it) => {
                      const key = idKey(it);
                      const checked = selectedIds.has(key);
                      return (
                        <label
                          key={key}
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "flex-start",
                            padding: "8px 10px",
                            borderRadius: 6,
                            background: checked ? "rgba(59,130,246,0.08)" : "rgba(148,163,184,0.07)",
                            border: it.warning ? "1px solid #f59e0b55" : "1px solid transparent",
                            cursor: "pointer",
                          }}
                        >
                          <input type="checkbox" checked={checked} onChange={() => toggleId(key)} style={{ marginTop: 3 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{baseOf(it.path)}</span>
                              <span className="badge" style={{ background: "#0ea5e922", color: "#0ea5e9", fontSize: 11 }}>
                                {it.tree}
                              </span>
                              <span
                                className="badge"
                                style={{
                                  background: it.action === "repoint" ? "#10b98122" : "#f59e0b22",
                                  color: it.action === "repoint" ? "#10b981" : "#f59e0b",
                                  fontSize: 11,
                                }}
                              >
                                {it.action === "repoint" ? "re-point" : "clear"}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2, wordBreak: "break-all" }}>{dirOf(it.path)}</div>
                            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                              claimed: {it.claimedTitle} →{" "}
                              {it.action === "repoint" ? (
                                <span style={{ color: "#34d399" }}>{it.ownerTitle}</span>
                              ) : (
                                <span style={{ color: "#f59e0b" }}>no owning show</span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{it.evidence}</div>
                            {it.warning && <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 4 }}>⚠ {it.warning}</div>}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
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
          <button className="btn btn-primary" onClick={apply} disabled={applying || totalSelected === 0}>
            {applying ? "Applying…" : `Apply ${totalSelected} change(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
