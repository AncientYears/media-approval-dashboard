import { useEffect, useRef, useState } from "react";

interface Finding {
  infoHash: string;
  name: string;
  torrentPath: string;
  expectedLength: number;
  path: string;
  tree: "download" | "processed" | "library";
  type: "movie" | "series";
  matchOther: string | null;
  goodCopy: string | null;
}

function fmtBytes(v: number): string {
  if (v <= 0) return "0 B";
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function parentDir(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * Dashboard-level integrity audit: streams the piece-hash scan of every
 * download/processed/library file against the saved trackers, shows a progress
 * bar while it runs (it is disk-bound), then lists files whose bytes no longer
 * match their torrent — the retroactive hunt for a past bad hardlink.
 */
export default function VerifyIntegrityModal({ onClose }: { onClose: () => void }) {
  const [running, setRunning] = useState(true);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("Starting…");
  const [scanned, setScanned] = useState(0);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    abort.current = ac;

    (async () => {
      try {
        const resp = await fetch("/api/requests/trackers/corruption/stream", { signal: ac.signal });
        if (!resp.body) throw new Error("No response body");
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "";

        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = JSON.parse(line.slice(6));
              if (eventType === "progress") {
                setDone(data.done || 0);
                setTotal(data.total || 0);
                if (data.message) setMessage(data.message);
              } else if (eventType === "done") {
                setScanned(data.scanned || 0);
                setFindings(data.findings || []);
                setRunning(false);
              } else if (eventType === "error") {
                setError(data.error || "Scan failed");
                setRunning(false);
              }
            } else if (line.trim() === "") {
              eventType = "";
            }
          }
        }
        setRunning(false);
      } catch (err: any) {
        if (err?.name !== "AbortError") setError(err?.message || "Scan failed");
        setRunning(false);
      }
    })();

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
              <div className="integrity-line">
                <span>
                  {total > 0 ? `${done} / ${total} files` : "Counting files…"}
                </span>
                {message && <span className="integrity-current" title={message}>{message}</span>}
              </div>
            </div>
          ) : findings ? (
            findings.length === 0 ? (
              <div className="integrity-ok">No corruption found — verified {scanned} saved tracker(s).</div>
            ) : (
              <div className={`corruption-panel has-findings`}>
                <div className="corruption-head">
                  <strong>{findings.length} suspect file(s) — bytes don't match the torrent:</strong>
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
            )
          ) : null}
        </div>
        <div className="modal-actions">
          {running ? (
            <span className="integrity-note">Scanning… you can close this and it will keep running.</span>
          ) : (
            <span className="integrity-note">
              {findings ? `Verified ${scanned} saved tracker(s).` : ""}
            </span>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
