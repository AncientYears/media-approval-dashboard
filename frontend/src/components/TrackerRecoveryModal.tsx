import { useCallback, useEffect, useRef, useState } from "react";
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
}

function fmtMB(v: number): string {
  if (!v) return "0 MB";
  const gb = v / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(v)} MB`;
}

function shortHash(h: string): string {
  return h.slice(0, 12);
}

export default function TrackerRecoveryModal({ onClose }: { onClose: () => void }) {
  const [scan, setScan] = useState<ScanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [types, setTypes] = useState<Record<string, "movie" | "series">>({});
  const [orphanPicks, setOrphanPicks] = useState<Set<string>>(new Set());
  const { toast } = useToast();
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await scanTrackers();
      setScan(data);
      setError("");
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

  // Poll while the window is open and any tracker is still verifying — the
  // restore step adds torrents that recheck, and the UI must track them live.
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
        toast(`${t.name}: added to qBittorrent (verifying)`, "success");
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
        toast(`${t.name}: linked to request #${res.linked.requestId}`, "success");
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

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal-box tracker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Restore saved trackers
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="tor-error">{error}</div>}
          {loading && <div className="tor-empty">Scanning trackers vs download/processed/library…</div>}
          {!loading && scan && (
            <>
              <div className="tracker-section">
                <div className="tracker-section-title">
                  Saved trackers ({scan.trackers.length})
                  {scan.duplicates.length > 0 && (
                    <span className="tracker-note">{scan.duplicates.length} duplicate .torrent file(s) collapsed</span>
                  )}
                  {scan.parseErrors.length > 0 && (
                    <span className="tracker-note tracker-note-err">{scan.parseErrors.length} unreadable file(s)</span>
                  )}
                </div>

                {scan.trackers.length === 0 && <div className="tor-empty">No trackers in {scan.trackers.length === 0 && "the Trackers directory"}.</div>}

                <div className="tracker-list">
                  {scan.trackers.map((t) => (
                    <div className={`tracker-item ${busy === t.infoHash || busy === `link-${t.infoHash}` ? "tracker-item-busy" : ""}`} key={t.infoHash}>
                      <div className="tracker-item-head">
                        <span className="tracker-name" title={t.name}>{t.name}</span>
                        <span className="tor-hash" title={t.infoHash}>{shortHash(t.infoHash)}</span>
                      </div>
                      <div className="tracker-item-sub">
                        <select
                          className="tracker-type"
                          value={types[t.infoHash] || t.typeGuess}
                          disabled={t.live || busy !== null}
                          onChange={(e) => setTypes((p) => ({ ...p, [t.infoHash]: e.target.value as "movie" | "series" }))}
                        >
                          <option value="movie">Movie</option>
                          <option value="series">Series</option>
                        </select>
                        <span>
                          {t.complete
                            ? `complete · ${t.fileCount} file(s)`
                            : `${t.fileCount - t.missing.length}/${t.fileCount} files · missing ${t.missing.length}`}
                        </span>
                        <span>{fmtMB(t.totalSize / 1024 / 1024)}</span>
                        {t.storedTracker && <span className="badge tracker-badge">stored</span>}
                        {t.live && (
                          <span className={`tor-state ${t.liveChecking ? "tor-state-check" : t.liveVerified ? "tor-state-up" : "tor-state-muted"}`}>
                            {t.liveChecking ? `checking ${Math.round((t.liveProgress || 0) * 100)}%` : t.liveState}
                          </span>
                        )}
                      </div>
                      {!t.live && !t.complete && t.missing.length > 0 && (
                        <div className="tracker-missing" title={t.missing.join("\n")}>
                          missing: {t.missing.slice(0, 3).join(", ")}{t.missing.length > 3 ? ` +${t.missing.length - 3}` : ""}
                        </div>
                      )}
                      <div className="tracker-item-actions">
                        {t.live ? (
                          <>
                            {t.liveVerified && !t.linkedRequest && (
                              <button
                                className="btn btn-small btn-primary"
                                disabled={busy !== null}
                                onClick={() => link(t)}
                              >
                                Link to request
                              </button>
                            )}
                            {t.linkedRequest && (
                              <span className="tracker-linked">linked to request #{t.linkedRequest.request_id}</span>
                            )}
                          </>
                        ) : (
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
                  ))}
                </div>
              </div>

              <div className="tracker-section">
                <div className="tracker-section-title">
                  Download orphans — no torrent, no saved tracker ({scan.orphans.length})
                  <span className="tracker-note">one-time catch-all: files whose tracker is lost get captured into /Processed</span>
                </div>
                {scan.orphans.length === 0 && <div className="tor-empty">No orphaned download files.</div>}
                {scan.orphans.length > 0 && (
                  <>
                    <div className="tracker-list">
                      {scan.orphans.map((o) => (
                        <label className="tracker-item tracker-orphan" key={o.path}>
                          <input
                            type="checkbox"
                            checked={orphanPicks.has(o.path)}
                            onChange={() => toggleOrphan(o.path)}
                          />
                          <div className="tracker-orphan-info">
                            <div className="tracker-name" title={o.path}>
                              {o.name}
                              {o.isDir && " /"}
                            </div>
                            <div className="tracker-item-sub">
                              <span>{o.type}</span>
                              <span>{fmtMB(o.sizeMb)}</span>
                              {o.existsInProcessed && <span className="badge tracker-badge">already in processed</span>}
                              {o.matchedRequest && (
                                <span className="tracker-linked">→ request #{o.matchedRequest.id}</span>
                              )}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="tracker-orphan-actions">
                      <button
                        className="btn btn-small btn-secondary"
                        disabled={busy !== null || orphanPicks.size === 0}
                        onClick={moveSelectedOrphans}
                      >
                        Move selected ({orphanPicks.size}) to Processed
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => load()}>Re-scan</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}