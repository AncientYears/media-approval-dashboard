import { useCallback, useEffect, useState } from "react";
import { scanTrackers, restoreTrackers, linkTrackerTorrent, moveOrphans, removeDuplicateTrackers } from "../api";
import { useToast } from "./Toast";

interface MissingFile {
  torrentPath: string;
  length: number;
  /** Video file — its absence blocks a restore. Sidecars (nfo/txt/jpg/…) are skipped instead. */
  media: boolean;
  fileIndex: number;
}

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
  missing: MissingFile[];
  matches: { torrentPath: string; length: number; sourcePath: string | null; tree: string; unique: boolean }[];
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

function fmtBytes(v: number): string {
  if (v <= 0) return "0 B";
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function mediaMissingCount(t: TrackerRow): number {
  return t.missing.filter((m) => m.media).length;
}

/** Which trees satisfy the plan's files — "1 download · 2 library". */
function matchTreeSummary(t: TrackerRow): string {
  const counts: Record<string, number> = {};
  for (const m of t.matches || []) {
    if (!m.sourcePath) continue;
    counts[m.tree] = (counts[m.tree] || 0) + 1;
  }
  return ["download", "processed", "library"]
    .filter((tree) => counts[tree])
    .map((tree) => `${counts[tree]} ${tree}`)
    .join(" · ");
}

const TYPE_HINT =
  "A .torrent carries no movie/series label of its own. This picks the destination " +
  "(Movies vs Series download folder) and which requests are matched when linking. " +
  "Guessed from the release name — a S01E01 makes it a Series.";

const STORED_HINT =
  "Tracker metadata is archived in Trackers/<hash>/ (.torrent + trackers.json). " +
  "Restore still (re)creates any missing hardlinks — files already in place are left untouched.";

function statusOf(t: TrackerRow): { label: string; cls: string } {
  if (t.live && t.liveChecking) {
    return { label: `Verifying ${Math.round((t.liveProgress || 0) * 100)}%`, cls: "tor-state-check" };
  }
  if (t.live && t.liveVerified) return { label: "In qBittorrent · complete", cls: "tor-state-up" };
  if (t.live) return { label: t.liveState || "In qBittorrent", cls: "tor-state-muted" };
  if (t.complete) return { label: "Ready to restore", cls: "tor-state-up" };
  const media = mediaMissingCount(t);
  return { label: media > 0 ? `${media} media file(s) missing` : `${t.missing.length} file(s) missing`, cls: "tor-state-err" };
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
        toast(
          `${t.name}: added, verifying${r.skippedFiles ? ` (skipping ${r.skippedFiles} missing sidecar file(s))` : ""}`,
          "success",
        );
        if (r.warn) toast(`${t.name}: ${r.warn}`, "error");
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

  // Same-hash .torrent copies beyond the surviving one: delete them so the
  // saved-trackers list stops showing phantom duplicates. One copy per hash
  // always remains (the keeper is never in the duplicates list).
  async function removeDuplicates() {
    if (!scan || scan.duplicates.length === 0) return;
    setBusy("dupes");
    try {
      const res = await removeDuplicateTrackers();
      const count = res.removed?.length || 0;
      toast(
        `Removed ${count} duplicate .torrent file(s)${res.errors?.length ? `, ${res.errors.length} failed` : ""}`,
        res.errors?.length ? "error" : "success",
      );
      await load(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    } finally {
      setBusy(null);
    }
  }

  const allTrackers = scan?.trackers || [];
  const visible = allTrackers.filter((t) => !t.linkedRequest);
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
                {scan.duplicates.length > 0 && (
                  <button
                    className="tracker-note tracker-note-btn"
                    title="Same info hash saved more than once (.torrent duplicates). Deleting the extras keeps exactly one copy per torrent."
                    disabled={busy !== null}
                    onClick={removeDuplicates}
                  >
                    {scan.duplicates.length} duplicate(s) — remove
                  </button>
                )}
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
                  const mediaCount = mediaMissingCount(t);
                  const present = t.fileCount - t.missing.length;
                  const treeSummary = matchTreeSummary(t);
                  return (
                    <div className={`tracker-item ${isBusy ? "tracker-item-busy" : ""}`} key={t.infoHash}>
                      <div className="tracker-item-head">
                        <span className={`tor-state ${st.cls}`}>{st.label}</span>
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
                              title={t.complete ? undefined : "Video files are missing on disk — see the missing list below"}
                              onClick={() => restore(t)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="tracker-name-row">
                        <span className="tracker-name" title={t.name}>{t.name}</span>
                        <span className="tor-hash" title={t.infoHash}>{t.infoHash.slice(0, 12)}</span>
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
                        <span>{present}/{t.fileCount} present</span>
                        {treeSummary && <span className="tracker-trees">found: {treeSummary}</span>}
                        <span>{t.announce.length} tracker(s)</span>
                        {t.storedTracker && <span className="badge tracker-badge" title={STORED_HINT}>stored</span>}
                      </div>
                      {t.missing.length > 0 && (
                        <details className={`tracker-missing-details ${mediaCount > 0 ? "blocking" : "skippable"}`}>
                          <summary>
                            {mediaCount > 0
                              ? `${mediaCount} media missing — restore blocked`
                              : `${t.missing.length} sidecar missing — skipped on restore`}
                          </summary>
                          <ul>
                            {t.missing.map((m) => (
                              <li key={m.torrentPath} className={m.media ? "miss-media" : "miss-side"} title={m.torrentPath}>
                                <span className="miss-path">{m.torrentPath.split("/").pop()}</span>
                                <span className="miss-size">{fmtBytes(m.length)}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
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
