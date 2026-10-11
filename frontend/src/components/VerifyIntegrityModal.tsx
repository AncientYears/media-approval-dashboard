import { useEffect, useRef, useState } from "react";
import { streamCorruptionScan, type CorruptFinding, type CorruptionScanStats } from "../api";

function fmtBytes(v: number): string {
  if (v <= 0) return "0 B";
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/** What the scan actually did — so "no corruption" shows its work instead of
 *  being an opaque green tick. `verified` = fresh piece hashes this run. */
function statsLine(s: CorruptionScanStats): string {
  const parts = [`hashed ${s.verified} file${s.verified === 1 ? "" : "s"}`];
  if (s.bytes) parts.push(fmtBytes(s.bytes));
  if (s.cached) parts.push(`${s.cached} cached`);
  if (s.unverifiable) parts.push(`${s.unverifiable} unverifiable`);
  return parts.join(" · ");
}

function parentDir(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * Dashboard-level integrity scan. Streams progress because the piece hashing is
 * disk-bound and can run for minutes; a single request would just hang. Read-only.
 */
export default function VerifyIntegrityModal({ onClose }: { onClose: () => void }) {
  const [running, setRunning] = useState(true);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("Starting…");
  const [scanned, setScanned] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [stats, setStats] = useState<CorruptionScanStats | null>(null);
  const [findings, setFindings] = useState<CorruptFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    abort.current = ac;
    streamCorruptionScan({
      signal: ac.signal,
      onProgress: (d, t, msg) => {
        setDone(d);
        setTotal(t);
        if (msg) setMessage(msg);
      },
    })
      .then((res) => {
        setScanned(res.scanned);
        setSkipped(res.skipped);
        setStats(res.stats);
        setFindings(res.findings);
        setRunning(false);
      })
      .catch((err: any) => {
        if (err?.name !== "AbortError") setError(err?.message || "Scan failed");
        setRunning(false);
      });
    return () => abort.current?.abort();
  }, []);

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : running ? 5 : 100;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box integrity-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Verify integrity</div>
        <div className="modal-body">
          <div className="integrity-intro">
            Hashes every download / processed / library file against the saved trackers'
            own piece hashes, to find files a past bad restore overwrote with another
            release's bytes — same size, wrong content. Read-only.
          </div>

          {error ? (
            <div className="tor-error">{error}</div>
          ) : running ? (
            <div className="integrity-progress">
              <div className="integrity-bar">
                <div className="integrity-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="integrity-sub">
                <span>{total > 0 ? `Verified ${done} / ${total}` : "Collecting files…"}</span>
                {message && <span className="integrity-msg" title={message}>{message}</span>}
              </div>
            </div>
          ) : findings && findings.length === 0 ? (
            <div className="integrity-ok">
              <div>No corruption found — verified {scanned} saved tracker(s){skipped > 0 ? `, skipped ${skipped} still downloading` : ""}.</div>
              {stats && (
                <div
                  className="integrity-sub"
                  title="unverifiable = the file is smaller than one torrent piece, so it cannot be judged from the file alone"
                >
                  {statsLine(stats)}
                </div>
              )}
            </div>
          ) : findings ? (
            <div className="corruption-panel has-findings">
              <div className="corruption-head">
                <strong>{findings.length} suspect file(s) — bytes don't match the torrent:</strong>
                {skipped > 0 && <span className="tracker-note"> {skipped} downloading torrent(s) skipped</span>}
              </div>
              {findings.map((f, i) => (
                <div className="corruption-row" key={`${f.path}-${i}`}>
                  <span className="corruption-flag">!</span>
                  <div className="corruption-info">
                    <div className="corruption-path" title={f.path}>{f.path}</div>
                    <div className="corruption-sub">
                      <span className="corruption-tree">{f.tree}</span>
                      <span>expected {fmtBytes(f.expectedLength)}</span>
                      <span className="corruption-tor" title={f.name}>in torrent: {f.name}</span>
                      {f.matchOther && (
                        <span className="corruption-other" title={f.matchOther}>holds another release's bytes: {f.matchOther}</span>
                      )}
                      {f.goodCopy && (
                        <span className="corruption-good" title={f.goodCopy}>good copy: {parentDir(f.goodCopy)}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="modal-actions">
          <span className="integrity-note">
            {running
              ? "Scanning… you can close this; it keeps running."
              : `Verified ${scanned} saved tracker(s)${skipped > 0 ? `, skipped ${skipped} still downloading` : ""}${stats ? ` · ${statsLine(stats)}` : ""}.`}
          </span>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
