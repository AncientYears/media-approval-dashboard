import { useCallback, useEffect, useState } from "react";
import { scanTrackers, restoreTrackers, linkTrackerTorrent, moveOrphans } from "../api";
import { useToast } from "./Toast";

interface TrackerRow {
  infoHash: string;
  name: string;
  sourcePath: string;
  announce: string[];
  layout: "single" | "folder";
  typeGuess: "movie" | "series";
  totalSize: number;
  complete: boolean;
  coveredBytes: number;
  fileCount: number;
  missing: string[];
  live: boolean;
  liveState: string | null;
  liveProgress: number | null;
  liveVerified: boolean;
  liveChecking: boolean;
  linkedRequest: { request_id: number; title: string } | null;
  storedTracker: boolean;
}

interface OrphanRow {
  path: string;
  type: "movie" | "series";
  name: string;
  isDir: boolean;
  sizeMb: number;
  videoCount: number;
  existsInProcessed: boolean;
  matchedRequest: { id: number; title: string; season: number | null } | null;
}

interface ScanData {
  trackers: TrackerRow[];
  orphans: OrphanRow[];
  duplicates: { infoHash: string; sourcePath: string }[];
  parseErrors: { file: string; error: string }[];
  healed?: { request_id: number; title: string }[];
}

function fmtMB(v: number): string {
  if (!v) return "0 MB";
  const gb = v / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(v)} MB`;
}

const TYPE_HINT =
  "A .torrent carries no movie/series label of its own. This picks the destination " +
  "(Movies vs Series download folder) and which requests are matched when linking. " +
  "Guessed from the release name — a S01E01 makes it a Series.";

function statusOf(t: TrackerRow): { label: string; cls: string } {
  if (t.live && t.liveChecking) {
    return { label: `Verifying ${Math.round((t.liveProgress || 0) * 100)}%`, cls: "tor-state-check" };
  }
  if (t.live && t.liveVerified) return { label: "In qBittorrent · complete", cls: "tor-state-up" };
  if (t.live) return { label: t.liveState || "In qBittorrent", cls: "tor-state-muted" };
  if (t.complete) return { label: "Ready to restore", cls: "tor-state-up" };
  return { label: `${t.missing.length} file(s) missing`, cls: "tor-state-err" };
}

export default function TrackerRecoveryModal({ onClose }: { onClose: () => void }) {
  const [scan, setScan] = useState<ScanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"trackers" | "orphans">("trackers");
  const [types, setTypes] = useState<Record<string, "movie" | "series">>({});
  const [orphanPicks, setOrphanPicks] = useState<Set<string>>(new Set());
  const [healNote, setHealNote] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!healNote) return;
    toast(healNote, "success");
    setHealNote(null);
  }, [healNote, toast]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await scanTrackers();
      setScan(data);
      setError("");
      if (data.healed?.length) {
        setHealNote(
          data.healed.length === 1
            ? `#${data.healed[0].request_id} (${data.healed[0].title}) is already in the library — marked complete`
            : `${data.healed.length} linked requests are already in the library — marked complete`,
        );
      }
      setTypes((prev) => {
        const next = { ...prev };
        for (const t of data.trackers as TrackerRow[]) {
          if (!next[t.infoHash]) next[t.infoHash] = t.typeGuess;
        }
        return next;
      });
      setOrphanPicks((prev) => {
        const next = new Set(prev);
        for (const o of data.orphans as OrphanRow[]) next.add(o.path);
        return next;
      });
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any tracker is still verifying — a restore adds torrents that
  // recheck, and the UI must track them live.
  useEffect(() => {
    const hasChecking = !!scan?.trackers.some((t) => t.liveChecking);
    if (!hasChecking) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [load, scan?.trackers]);

  async function restore(t: TrackerRow) {
    setBusy(t.infoHash);
    try {
      const res = await restoreTrackers([{ infoHash: t.infoHash, type: types[t.infoHash] || t.typeGuess }]);
      const r = res.results?.[0];
      if (r?.ok) {
        toast(`${t.name}: added, verifying`, "success");
        await load(true);
      } else {
        toast(`${t.name}: ${r?.error || "failed"}`, "error");
      }
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function link(t: TrackerRow) {
    setBusy(`link-${t.infoHash}`);
    try {
      const res = await linkTrackerTorrent(t.infoHash, types[t.infoHash] || t.typeGuess);
      if (res.linked) {
        toast(
          res.inLibrary
            ? `${t.name}: linked to #${res.linked.requestId} — already in library, marked complete`
            : `${t.name}: linked to request #${res.linked.requestId}`,
          "success",
        );
      } else {
        toast(`${t.name}: restored but no matching request found`, "error");
      }
      await load(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    } finally {
      setBusy(null);
    }
  }

  function toggleOrphan(p: string) {
    setOrphanPicks((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function moveSelectedOrphans() {
    if (!scan) return;
    const selected = scan.orphans.filter((o) => orphanPicks.has(o.path));
    if (selected.length === 0) return;
    setBusy("move-orphans");
    try {
      const res = await moveOrphans(selected.map((o) => ({ path: o.path, type: o.type })));
      const ok = res.results?.filter((r: any) => r.ok).length || 0;
      const bad = res.results?.filter((r: any) => !r.ok).length || 0;
      toast(`Moved ${ok} orphan(s) to Processed${bad ? `, ${bad} failed` : ""}`, bad ? "error" : "success");
      setOrphanPicks(new Set());
      await load(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    } finally {
      setBusy(null);
    }
  }

  const allTrackers = scan?.trackers || [];
  const visible = allTrackers.filter((t) => !t.linkedRequest);
  const linkedCount = allTrackers.length - visible.length;
  const orphans = scan?.orphans || [];

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal-box tracker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Restore saved trackers
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="tracker-tabs">
          <button className={`tracker-tab ${tab === "trackers" ? "active" : ""}`} onClick={() => setTab("trackers")}>
            Saved trackers <span className="tracker-tab-count">{visible.length}</span>
          </button>
          <button className={`tracker-tab ${tab === "orphans" ? "active" : ""}`} onClick={() => setTab("orphans")}>
            Download orphans <span className="tracker-tab-count">{orphans.length}</span>
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="tor-error">{error}</div>}
          {loading && <div className="tor-empty">Scanning trackers vs download/processed/library…</div>}

          {!loading && scan && tab === "trackers" && (
            <div className="tracker-section">
              <div className="tracker-section-title">
                Restore puts the files back into the download folder and re-adds the torrent paused for verification.
                {linkedCount > 0 && <span className="tracker-note">{linkedCount} linked, hidden</span>}
                {scan.duplicates.length > 0 && <span className="tracker-note">{scan.duplicates.length} duplicate(s)</span>}
                {scan.parseErrors.length > 0 && <span className="tracker-note tracker-note-err">{scan.parseErrors.length} unreadable</span>}
              </div>

              {visible.length === 0 && (
                <div className="tor-empty">
                  {allTrackers.length === 0 ? "No saved trackers found." : "Every saved tracker is linked — nothing left to restore."}
                </div>
              )}

              <div className="tracker-list">
                {visible.map((t) => {
                  const st = statusOf(t);
                  const isBusy = busy === t.infoHash || busy === `link-${t.infoHash}`;
                  const stopped = t.live || busy !== null;
                  return (
                    <div className={`tracker-item ${isBusy ? "tracker-item-busy" : ""}`} key={t.infoHash}>
                      <div className="tracker-item-head">
                        <span className={`tor-state ${st.cls}`}>{st.label}</span>
                        <span className="tracker-name" title={t.name}>{t.name}</span>
                        <span className="tor-hash" title={t.infoHash}>{t.infoHash.slice(0, 12)}</span>
                        <div className="tracker-item-actions">
                          {t.live && !t.liveVerified && (
                            <span className="tracker-hint">verifying…</span>
                          )}
                          {t.live && t.liveVerified && (
                            <button className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => link(t)}>
                              Link to request
                            </button>
                          )}
                          {!t.live && (
                            <button
                              className="btn btn-small btn-primary"
                              disabled={!t.complete || busy !== null}
                              onClick={() => restore(t)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="tracker-item-sub">
                        <select
                          className="tracker-type"
                          title={TYPE_HINT}
                          value={types[t.infoHash] || t.typeGuess}
                          disabled={stopped}
                          onChange={(e) => setTypes((p) => ({ ...p, [t.infoHash]: e.target.value as "movie" | "series" }))}
                        >
                          <option value="movie">Movie</option>
                          <option value="series">Series</option>
                        </select>
                        <span>{fmtMB(t.totalSize / 1024 / 1024)}</span>
                        <span>
                          {t.complete
                            ? `${t.fileCount} file(s)`
                            : `${t.fileCount - t.missing.length}/${t.fileCount} present`}
                        </span>
                        {t.storedTracker && <span className="badge tracker-badge">stored</span>}
                        {t.missing.length > 0 && (
                          <details className="tracker-missing-details">
                            <summary>{t.missing.length} missing</summary>
                            <ul>
                              {t.missing.map((m) => (
                                <li key={m}>{m}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!loading && scan && tab === "orphans" && (
            <div className="tracker-section">
              <div className="tracker-section-title">
                One-time catch-all: download files with no torrent and no saved tracker get moved into /Processed.
              </div>
              {orphans.length === 0 && <div className="tor-empty">No orphaned download files.</div>}
              {orphans.length > 0 && (
                <div className="tracker-list">
                  {orphans.map((o) => (
                    <label className="tracker-item tracker-orphan" key={o.path}>
                      <input type="checkbox" checked={orphanPicks.has(o.path)} onChange={() => toggleOrphan(o.path)} />
                      <div className="tracker-orphan-info">
                        <div className="tracker-name" title={o.path}>
                          {o.name}
                          {o.isDir && " /"}
                        </div>
                        <div className="tracker-item-sub">
                          <span>{o.type}</span>
                          <span>{fmtMB(o.sizeMb)}</span>
                          {o.existsInProcessed && <span className="badge tracker-badge">already in processed</span>}
                          {o.matchedRequest && <span className="tracker-linked">→ request #{o.matchedRequest.id}</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-actions">
          {tab === "orphans" && (
            <button
              className="btn btn-secondary"
              disabled={busy !== null || orphanPicks.size === 0}
              onClick={moveSelectedOrphans}
            >
              Move selected ({orphanPicks.size}) to Processed
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => load()}>Re-scan</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
