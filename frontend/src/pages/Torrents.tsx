import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchTorrents, torrentAction } from "../api";
import { useToast } from "../components/Toast";
import TrackerRecoveryModal from "../components/TrackerRecoveryModal";

interface TorrentRow {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  completed: number;
  dlspeed: number;
  upspeed: number;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
  category: string;
  save_path: string;
  content_path: string;
  verified: boolean;
  checking: boolean;
  hasStoredTracker: boolean;
  linkedRequest: { rc_id: number; title: string; request_id: number; status: string } | null;
}

function fmtMB(v: number): string {
  if (!v) return "0 B";
  const gb = v / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = v / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(v / 1024).toFixed(0)} KB`;
}

function fmtSpeed(v: number): string {
  return `${fmtMB(v)}/s`;
}

function fmtAge(ts: number): string {
  if (!ts) return "—";
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days < 1) return `${Math.floor((Date.now() / 1000 - ts) / 3600)}h`;
  return `${days}d`;
}

function stateTone(state: string): string {
  const s = String(state || "").toLowerCase();
  if (s.includes("up") || s === "uploading") return "tor-state-up";
  if (s.includes("dl") || s === "downloading") return "tor-state-dl";
  if (s.startsWith("checking") || s.startsWith("queued")) return "tor-state-check";
  if (s.startsWith("error") || s.startsWith("missing")) return "tor-state-err";
  if (s.startsWith("stopped") || s.startsWith("paused")) return "tor-state-stop";
  return "tor-state-muted";
}

export default function Torrents() {
  const [rows, setRows] = useState<TorrentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "active" | "seeding" | "paused" | "checking" | "linked" | "unlinked"
  >("all");
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; hash: string } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [pending, setPending] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchTorrents();
      setRows(data.torrents || []);
      setError("");
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll continuously: qBittorrent transitions (start/stop, the restore flow's
  // add → verify → stopped) outlast a single fetch, and with no poll the
  // buttons and labels stayed wrong until a manual Refresh. Covers live
  // recheck progress too.
  useEffect(() => {
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [load]);

  const isStopped = (state: string) => {
    const s = (state || "").toLowerCase();
    return s.startsWith("stopped") || s.startsWith("paused");
  };

  async function act(hash: string, name: string, action: "start" | "stop" | "recheck") {
    setPending((p) => ({ ...p, [hash]: action }));
    try {
      await torrentAction(hash, action);
      // React on the row immediately — the buttons must disable without
      // waiting for the refresh round-trip to land.
      setRows((prev) =>
        prev.map((r) =>
          r.hash === hash
            ? {
                ...r,
                state: action === "stop" ? "stoppedDL" : action === "start" ? "downloading" : r.state,
                checking: action === "recheck" ? true : r.checking,
              }
            : r,
        ),
      );
      toast(`${name}: ${action}`, "success");
      if (action === "recheck") {
        load(true);
      } else {
        // qBittorrent applies start/stop asynchronously, so an immediate
        // refetch can still report the pre-action state and revert the
        // optimistic update above — and with no poll left running (the
        // checking poll stops once verification ends) the buttons would stay
        // wrong until a manual Refresh. Hold `pending` until qBittorrent
        // agrees (or a few seconds pass).
        await converge(hash, action);
      }
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[hash];
        return next;
      });
    }
  }

  // Poll until the torrent's fetched state reflects the action, so Start/Stop
  // enable/disable from real qBittorrent state instead of a stale read.
  async function converge(hash: string, action: "start" | "stop") {
    const wanted = (t: TorrentRow) => (action === "stop" ? isStopped(t.state) : !isStopped(t.state));
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      let list: TorrentRow[] = [];
      try {
        const data = await fetchTorrents();
        list = data.torrents || [];
      } catch {
        return;
      }
      setRows(list);
      const t = list.find((r) => r.hash === hash);
      if (!t || wanted(t)) return;
    }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    const { hash, name } = confirmDelete;
    setConfirmDelete(null);
    try {
      await torrentAction(hash, "delete", deleteFiles);
      toast(`Deleted ${name}`, "success");
      load(true);
    } catch (err: any) {
      toast(err?.response?.data?.error || err.message, "error");
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q) && !r.hash.includes(q)) return false;
      const linked = !!r.linkedRequest;
      switch (filter) {
        case "active":
          return r.state.toLowerCase().includes("dl") || r.num_leechs > 0 || r.dlspeed > 0;
        case "seeding":
          return r.state.toLowerCase().endsWith("up") || r.state === "uploading";
        case "paused":
          return r.state.toLowerCase().startsWith("paused") || r.state.toLowerCase().startsWith("stopped");
        case "checking":
          return r.checking;
        case "linked":
          return linked;
        case "unlinked":
          return !linked;
        default:
          return true;
      }
    });
  }, [rows, query, filter]);

  return (
    <div className="tor-page">
      <div className="tor-header">
        <h2>Torrents</h2>
        <div className="tor-header-actions">
          <button className="btn btn-secondary" onClick={() => load()}>Refresh</button>
          <button className="btn btn-primary" onClick={() => setShowRecovery(true)}>
            Restore saved trackers
          </button>
        </div>
      </div>

      {error && <div className="tor-error">{error}</div>}

      <div className="tor-toolbar">
        <input
          className="tor-search"
          type="text"
          placeholder="Filter by name or hash…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="tor-filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All ({rows.length})</option>
          <option value="active">Downloading</option>
          <option value="seeding">Seeding</option>
          <option value="paused">Paused / Stopped</option>
          <option value="checking">Checking</option>
          <option value="linked">Linked to request</option>
          <option value="unlinked">Unlinked</option>
        </select>
      </div>

      {loading ? (
        <div className="tor-empty">Loading torrents…</div>
      ) : filtered.length === 0 ? (
        <div className="tor-empty">No torrents {rows.length === 0 ? "— qBittorrent is empty" : "match the filter"}.</div>
      ) : (
        <div className="tor-list">
          {filtered.map((t) => (
            <div className="tor-row" key={t.hash}>
              <div className="tor-main">
                <div className="tor-title">
                  {t.name}
                  {t.verified && <span className="badge badge-in-library">verified</span>}
                  {t.hasStoredTracker && <span className="badge tor-badge-tracker">tracker</span>}
                </div>
                <div className="tor-meta">
                  <span className={`tor-state ${stateTone(t.state)}`}>{t.state || "—"}</span>
                  <span>{fmtMB(t.size)}</span>
                  <span>ratio {t.ratio.toFixed(2)}</span>
                  <span>{t.linkedRequest ? `request #${t.linkedRequest.request_id}` : "unlinked"}</span>
                  <span className="tor-hash" title={t.hash}>{t.hash.slice(0, 12)}</span>
                </div>
                <div className="tor-progress">
                  <div className="tor-progress-track">
                    <div
                      className={`tor-progress-fill ${t.checking ? "tor-progress-check" : ""}`}
                      style={{ width: `${Math.round((t.progress || 0) * 100)}%` }}
                    />
                  </div>
                  <span className="tor-progress-label">
                    {t.checking ? `checking… ${Math.round((t.progress || 0) * 100)}%` : `${Math.round((t.progress || 0) * 100)}%`}
                  </span>
                </div>
                <div className="tor-sub">
                  {t.dlspeed > 0 && <span>↓ {fmtSpeed(t.dlspeed)}</span>}
                  {t.upspeed > 0 && <span>↑ {fmtSpeed(t.upspeed)}</span>}
                  {t.num_seeds > 0 && <span>{t.num_seeds} seeds</span>}
                  {t.num_leechs > 0 && <span>{t.num_leechs} peers</span>}
                  <span>
                    {t.num_seeds === 0 && t.num_leechs === 0
                      ? isStopped(t.state)
                        ? "stopped"
                        : t.verified
                          ? "seeding"
                          : "—"
                      : ""}
                  </span>
                  <span>{fmtAge(t.added_on)} ago</span>
                </div>
              </div>
              <div className="tor-actions">
                {t.linkedRequest && (
                  <Link className="btn btn-small btn-library-ok" to={`/requests/${t.linkedRequest.request_id}`}>
                    Request #{t.linkedRequest.request_id}
                  </Link>
                )}
                <button className="btn btn-small btn-secondary" onClick={() => act(t.hash, t.name, "start")} disabled={!!pending[t.hash] || t.checking || !isStopped(t.state)}>
                  Start
                </button>
                <button className="btn btn-small btn-secondary" onClick={() => act(t.hash, t.name, "stop")} disabled={!!pending[t.hash] || t.checking || isStopped(t.state)}>
                  Stop
                </button>
                <button className="btn btn-small btn-secondary" onClick={() => act(t.hash, t.name, "recheck")} disabled={!!pending[t.hash] || t.checking}>
                  Recheck
                </button>
                <button className="btn btn-small btn-danger" disabled={!!pending[t.hash]} onClick={() => { setDeleteFiles(false); setConfirmDelete({ name: t.name, hash: t.hash }); }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Delete torrent</div>
            <div className="modal-body">
              <div className="modal-line">Delete <strong>{confirmDelete.name}</strong> from qBittorrent?</div>
              <label className="tor-delete-files">
                <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
                Also delete downloaded files from disk
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={doDelete}>Delete{deleteFiles ? " + files" : ""}</button>
            </div>
          </div>
        </div>
      )}

      {showRecovery && <TrackerRecoveryModal onClose={() => { setShowRecovery(false); load(true); }} />}
    </div>
  );
}