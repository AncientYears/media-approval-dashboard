import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRequests, fetchManaged, fetchFranchiseSeasons, cleanupStaleRequests, dismissRequest, detectTorrents, importMissingRequests, scanDownloads, importLibraryNative, cleanupDuplicates, deleteRequest, deleteFranchise, scanWorkspaces, cleanupWorkspaces, fetchLibraryAudit, adoptIntoProcessed, syncSeerr } from "../api";
import UnmatchedTorrentsPanel from "../components/UnmatchedTorrentsPanel";
import DownloadDirsModal from "../components/DownloadDirsModal";
import DiscoverModal from "../components/DiscoverModal";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

const STATUS_OPTIONS = ["ALL", "NEW", "SEARCHING", "AWAITING_APPROVAL", "DOWNLOADING"];
const TYPE_OPTIONS = ["ALL", "movie", "series"];
const SORT_OPTIONS = [
  { value: "created_at_desc", label: "Newest first" },
  { value: "created_at_asc", label: "Oldest first" },
  { value: "title_asc", label: "Title A-Z" },
  { value: "title_desc", label: "Title Z-A" },
  { value: "status_asc", label: "Status (pending first)" },
];

const STATUS_ORDER: Record<string, number> = {
  AWAITING_APPROVAL: 0,
  SEARCHING: 1,
  NEW: 2,
  DOWNLOADING: 3,
};

function Modal({ title, lines, onClose, onOk, onCleanup, onApply }: { title?: string; lines: string[]; onClose: () => void; onOk?: () => void; onCleanup?: () => void; onApply?: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="modal-title">{title}</h3>}
        <div className="modal-body">
          {lines.map((line, i) => (
            <div key={i} className={line === "" ? "modal-spacer" : "modal-line"}>
              {line || "\u00A0"}
            </div>
          ))}
        </div>
        {onCleanup ? (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
            <button className="btn btn-danger" onClick={onCleanup}>Clean Up</button>
          </div>
        ) : onApply ? (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={onApply}>Apply</button>
          </div>
        ) : onOk ? (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-danger" onClick={onOk}>Delete Duplicates</button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onClose}>OK</button>
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-line">{message}</div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<any[]>([]);
  const [managed, setManaged] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("status_asc");
  const [modal, setModal] = useState<{ title?: string; lines: string[]; onCleanup?: () => void; onApply?: () => void } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; title: string } | null>(null);
  const [pendingCleanup, setPendingCleanup] = useState<{ dryResult: any } | null>(null);
  const [downloadDirsOpen, setDownloadDirsOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [franchiseSeasons, setFranchiseSeasons] = useState<{ [sonarrId: number]: any }>({});

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [reqData, managedData] = await Promise.all([fetchRequests(), fetchManaged()]);
      setRequests(reqData);
      setManaged(managedData);
      setError(null);
    } catch (err) {
      setError("Failed to load requests");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    syncSeerr().catch(() => {}).then(() => loadData());
    cleanupStaleRequests().then(() => loadData());
  }, [loadData]);

  const requestsList = requests
    .filter((r: any) => r.status !== "DOWNLOADING" && r.status !== "SEEDING")
    .filter((r: any) => statusFilter === "ALL" || r.status === statusFilter)
    .filter((r: any) => typeFilter === "ALL" || r.type === typeFilter)
    .sort((a: any, b: any) => {
      switch (sortBy) {
        case "created_at_desc": return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "created_at_asc": return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "title_asc": return a.title.localeCompare(b.title);
        case "title_desc": return b.title.localeCompare(a.title);
        case "status_asc": return (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        default: return 0;
      }
    });

  // Group series requests into franchise cards. Arr-linked rows group by
  // sonarr_id; native (arr-free) rows group by library_key — but only when
  // MORE than one season is actually requested. A lone requested season stays
  // a plain card: the Managed section already renders the full season list for
  // a content-bearing franchise, and inflating a single Discover row into a
  // franchise card would just add ceremony.
  interface FranchiseGroup {
    key: string;
    title: string;
    sonarr_id?: number;
    library_key?: string;
    firstRequestId: number;
    seasons: any[];
  }
  const groupedFranchises = new Map<string, FranchiseGroup>();
  const ungroupedRequests: any[] = [];
  const nativeKeySeasons = new Map<string, any[]>();
  for (const req of requestsList) {
    if (req.type === "series") {
      if (req.sonarr_id) {
        const gk = `s:${req.sonarr_id}`;
        if (!groupedFranchises.has(gk)) {
          const franchiseTitle = req.title.replace(/ S\d+$/, "").replace(/ Season \d+$/, "");
          groupedFranchises.set(gk, {
            key: gk,
            title: franchiseTitle,
            sonarr_id: req.sonarr_id,
            firstRequestId: req.id,
            seasons: [],
          });
        }
        groupedFranchises.get(gk)!.seasons.push(req);
      } else if (req.library_key) {
        const list = nativeKeySeasons.get(req.library_key) || [];
        list.push(req);
        nativeKeySeasons.set(req.library_key, list);
      } else {
        ungroupedRequests.push(req);
      }
    } else {
      ungroupedRequests.push(req);
    }
  }
  for (const [libKey, list] of nativeKeySeasons) {
    if (list.length > 1) {
      const gk = `l:${libKey}`;
      groupedFranchises.set(gk, {
        key: gk,
        title: list[0].title.replace(/ S\d+$/, "").replace(/ Season \d+$/, ""),
        library_key: libKey,
        firstRequestId: list[0].id,
        seasons: [...list].sort((a, b) => (a.season ?? 0) - (b.season ?? 0)),
      });
    } else {
      ungroupedRequests.push(list[0]);
    }
  }

  // Fetch full season lists for arr-linked franchise groups only (native
  // groups have no Sonarr list — their pills are the requested seasons).
  useEffect(() => {
    const ids = Array.from(groupedFranchises.values()).filter((g) => g.sonarr_id != null).map((g) => g.sonarr_id!);
    for (const id of ids) {
      if (franchiseSeasons[id]) continue;
      fetchFranchiseSeasons(id).then((data) => {
        setFranchiseSeasons((prev) => ({ ...prev, [id]: data }));
      }).catch(() => {});
    }
  }, [Array.from(groupedFranchises.values()).map((g) => g.key).join(",")]);

  if (loading && requests.length === 0) {
    return <div className="container"><p>Loading requests...</p></div>;
  }

  if (error) {
    return <div className="container error"><p>{error}</p></div>;
  }

  return (
    <div className="container">
      {modal && <Modal title={modal.title} lines={modal.lines} onClose={() => { setModal(null); setPendingCleanup(null); }} onCleanup={modal.onCleanup} onApply={modal.onApply} onOk={pendingCleanup ? async () => {
        setPendingCleanup(null);
        setModal({ title: "Cleanup Duplicates", lines: ["Deleting..."] });
        try {
          const result = await cleanupDuplicates(false);
          const lines = [`Cleaned up ${result.duplicates} duplicate(s):`];
          for (const r of result.results) {
            lines.push(`  "${r.title}": deleted ${r.deleted}, moved ${r.movedRcs} RCs`);
          }
          setModal({ title: "Cleanup Complete", lines });
          loadData();
        } catch (err: any) {
          setModal({ title: "Cleanup Error", lines: [err.message] });
        }
      } : undefined} />}
      {downloadDirsOpen && <DownloadDirsModal onClose={() => { setDownloadDirsOpen(false); loadData(); }} />}
      {discoverOpen && <DiscoverModal onClose={() => setDiscoverOpen(false)} onRequested={(id) => navigate(`/requests/${id}`)} />}
      {confirmDelete && (
        <ConfirmModal
          message={`Permanently delete "${confirmDelete.title}"? This cannot be undone.`}
          onConfirm={async () => {
            const res = await dismissRequest(confirmDelete.id).catch(() => null);
            setConfirmDelete(null);
            if (res?.seerrDelete && !res.seerrDelete.ok) {
              setModal({
                title: "Seerr delete failed",
                lines: [
                  `"${confirmDelete.title}" was deleted locally, but Seerr refused the delete (${res.seerrDelete.method}: ${res.seerrDelete.error || res.seerrDelete.body || "HTTP " + res.seerrDelete.status}).`,
                  "Seerr still holds the request, so the next sync will bring it back. Decline/delete it in Seerr's UI to stop re-appearing.",
                ],
              });
            }
            loadData();
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      <div className="filter-bar">
        <div className="filter-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "ALL" ? "All Statuses" : s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t === "ALL" ? "All Types" : t}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Sort</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <button className="btn btn-secondary btn-tiny" onClick={async () => {
            const result = await detectTorrents();
            const lines = [
              `Detected ${result.detected} torrent(s) out of ${result.total} pending request(s).`,
              "",
            ];
            if (result.matches && result.matches.length > 0) {
              for (const m of result.matches) {
                lines.push(`"${m.request_title}" → ${m.torrent_name}`);
              }
            }
            setModal({ title: "Detect Torrents", lines });
            loadData();
          }}>Detect Torrents</button>
          <button className="btn btn-secondary btn-tiny" onClick={async () => {
            const result = await importMissingRequests();
            const lines = [
              `Imported ${result.imported} new request(s).`,
            ];
            if (result.fixed > 0) {
              lines.push(`Fixed ${result.fixed} existing request(s) NEW→COMPLETED.`);
            }
            if (result.orphaned > 0) {
              lines.push(`Removed ${result.orphaned} orphaned request(s).`);
            }
            if (result.skipped > 0) {
              lines.push(`Skipped ${result.skipped} (already in DB).`);
            }
            if (result.skippedItems && result.skippedItems.length > 0) {
              lines.push("");
              lines.push("Skipped items:");
              for (const s of result.skippedItems) {
                lines.push(`  ${s.title} — ${s.reason}`);
              }
            }
            if (result.removedOrphans && result.removedOrphans.length > 0) {
              lines.push("");
              lines.push("Removed orphans:");
              for (const o of result.removedOrphans) {
                lines.push(`  ${o}`);
              }
            }
            setModal({ title: "Import Missing", lines });
            loadData();
          }}>Import Missing</button>
          <button className="btn btn-primary btn-tiny" onClick={() => setDiscoverOpen(true)}>Discover</button>
          <button className="btn btn-primary btn-tiny" onClick={async () => {
            setModal({ title: "Scan Downloads", lines: ["Scanning qBittorrent..."] });
            const result = await scanDownloads();
            const lines = [
              `Scanned ${result.total} torrent(s).`,
              `Tracked ${result.imported} into the dashboard.`,
              `Skipped ${result.skipped} (already in DB).`,
              `No match: ${result.noMatch}.`,
              `Errors: ${result.errors}.`,
            ];
            if (result.backfilled > 0) lines.push(`Backfilled ${result.backfilled} approval(s).`);
            if (result.staleRemoved > 0) lines.push(`Removed ${result.staleRemoved} stale approval(s).`);
            if (result.statusFixed > 0) lines.push(`Fixed ${result.statusFixed} request status(es).`);
            if (result.seasonFixed > 0) lines.push(`Removed ${result.seasonFixed} season-mismatched RC(s) — re-run to import.`);
            if (result.rcFixed > 0) lines.push(`Fixed ${result.rcFixed} RC title/quality.`);
            if (result.results && result.results.length > 0) {
              lines.push("");
              for (const r of result.results) {
                const icon = r.status === "imported" ? "+" : r.status === "skipped" ? "=" : r.status === "error" ? "!" : "-";
                lines.push(`[${icon}] ${r.title} (${r.status}${r.type ? `, ${r.type}` : ""}${r.error ? `: ${r.error}` : ""})`);
              }
            }
            setModal({ title: "Scan Downloads", lines });
            loadData();
          }}>Scan Downloads</button>
          <button className="btn btn-primary btn-tiny" onClick={async () => {
            setModal({ title: "Import Library", lines: ["Planning from disk..."] });
            try {
              const plan = await importLibraryNative();
              const t = plan.totals || {};
              if ((t.create || 0) + (t.adopt || 0) + (t.update || 0) === 0) {
                setModal({ title: "Import Library", lines: ["Nothing to reconcile — library already matches requests.", ...(plan.errors || []).map((e: string) => `Scan: ${e}`)] });
                return;
              }
              const lines: string[] = [
                `Movies + series found: ${plan.candidates?.length || 0}.`,
                `To create: ${t.create}. To adopt: ${t.adopt}. To update: ${t.update}.`,
                `Active requests skipped: ${t.skip} (never touched).`,
              ];
              if ((t.create || 0) > 0) {
                lines.push("");
                lines.push("New COMPLETED requests:");
                for (const c of (plan.candidates || [])) {
                  if (c.action !== "create") continue;
                  lines.push(`  + [${c.kind}] ${c.title}${c.season != null ? ` S${String(c.season).padStart(2, "0")}` : ""} → ${c.libraryKey} — ${c.filesMatched}/${c.filesTotal} file(s)`);
                }
              }
              if ((t.adopt || 0) > 0) {
                lines.push("");
                lines.push("Asserted library identity onto existing rows:");
                for (const c of (plan.candidates || [])) {
                  if (c.action !== "adopt") continue;
                  lines.push(`  = [${c.kind}] ${c.title}${c.season != null ? ` S${String(c.season).padStart(2, "0")}` : ""} → ${c.libraryKey}${c.reason ? ` (${c.reason})` : ""}`);
                }
              }
              if ((t.update || 0) > 0) {
                lines.push("");
                lines.push(`Updated (merging missing processed files): ${t.update}.`);
              }
              setModal({ title: "Import Library", lines, onApply: async () => {
                setModal({ title: "Import Library", lines: ["Reconciling..."] });
                try {
                  const result = await importLibraryNative({ apply: true });
                  const r = result.result || {};
                  setModal({
                    title: "Import Library",
                    lines: [
                      `Created: ${r.totals?.create}. Adopted: ${r.totals?.adopt}. Updated: ${r.totals?.update}.`,
                      `Active skipped: ${r.totals?.skip}.`,
                      `Files associated: ${r.filesAssociated}.`,
                      ...(plan.errors || []).map((e: string) => `Scan: ${e}`),
                    ],
                  });
                  loadData();
                } catch (err: any) {
                  setModal({ title: "Import Library", lines: [`Error: ${err.message}`] });
                }
              } });
            } catch (err: any) {
              setModal({ title: "Import Library", lines: [`Error: ${err.message}`] });
            }
          }}>Import Library</button>
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Cleanup Duplicates", lines: ["Checking for duplicates..."] });
            try {
              const dryResult = await cleanupDuplicates(true);
              if (dryResult.duplicates === 0) {
                setModal({ title: "Cleanup Duplicates", lines: ["No duplicates found!"] });
              } else {
                const lines: string[] = [`Found ${dryResult.duplicates} duplicate title(s):`];
                for (const r of dryResult.results) {
                  lines.push(`  "${r.title}": delete ${r.deleted}, move ${r.movedRcs} RCs`);
                  if (r.sonarrDeleted?.length) lines.push(`    Sonarr: ${r.sonarrDeleted.join(", ")}`);
                  if (r.radarrDeleted?.length) lines.push(`    Radarr: ${r.radarrDeleted.join(", ")}`);
                }
                setPendingCleanup({ dryResult });
                setModal({ title: "Cleanup Duplicates", lines });
              }
            } catch (err: any) {
              setModal({ title: "Cleanup Duplicates", lines: [`Error: ${err.message}`] });
            }
          }}>Cleanup Duplicates</button>
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Scan Workspaces", lines: ["Scanning workspace directories..."] });
            try {
              const result = await scanWorkspaces();
              if (!result.workspaces || result.workspaces.length === 0) {
                setModal({ title: "Scan Workspaces", lines: ["No workspace directories found."] });
                return;
              }
              const lines: string[] = [`${result.workspaces.length} workspace(s) found:`];
              lines.push("");
              for (const ws of result.workspaces) {
                const icon = ws.status === "orphaned" ? "!" : ws.status === "empty" ? "-" : "+";
                const label = ws.status === "orphaned" ? "ORPHANED" : ws.status === "empty" ? "EMPTY" : "active";
                lines.push(`[${icon}] ${ws.dirName} — ${label}`);
                if (ws.requestTitle) lines.push(`    Request: ${ws.requestTitle} (${ws.requestType})`);
                lines.push(`    Inputs: ${ws.inputCount}, Outputs: ${ws.outputCount}`);
                if (ws.metadata?.name) lines.push(`    Name: ${ws.metadata.name}`);
                if (ws.metadata?.status) lines.push(`    Status: ${ws.metadata.status}`);
              }
              const cleanupable = result.workspaces.filter((ws: any) => ws.status === "orphaned" || ws.status === "empty");
              if (cleanupable.length > 0) {
                lines.push("");
                lines.push(`${cleanupable.length} can be cleaned up.`);
              }
              setModal({ title: "Scan Workspaces", lines, onCleanup: cleanupable.length > 0 ? async () => {
                setModal({ title: "Cleanup Workspaces", lines: ["Deleting..."] });
                const del = await cleanupWorkspaces(cleanupable.map((ws: any) => ws.dirName));
                setModal({ title: "Cleanup Workspaces", lines: [`Deleted ${del.deleted} workspace(s).${del.errors.length > 0 ? "\nErrors: " + del.errors.join(", ") : ""}`] });
              } : undefined });
            } catch (err: any) {
              setModal({ title: "Scan Workspaces", lines: [`Error: ${err.message}`] });
            }
          }}>Scan Workspaces</button>
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Library Audit", lines: ["Scanning library..."] });
            try {
              const a = await fetchLibraryAudit();
              const lib = a.library || {};
              const proc = a.processed || {};
              const dl = a.download || {};
              const adoption = a.adoption || {};
              const overlap = a.overlap || {};
              const lines: string[] = [
                `Library: ${lib.movie_folders} movies, ${lib.series_shows} shows (${lib.movie_files} movie files, ${lib.series_files} series files)`,
                `Processed: ${proc.movie_files} movie files, ${proc.series_files} series files across ${proc.series_shows} shows`,
                `Download: ${dl.movie_files} movie files, ${dl.series_files} series files across ${dl.series_shows} shows`,
                "",
                `Library files already in processed: ${overlap.library_files_already_in_processed}`,
                `Library files NOT in processed: ${overlap.library_files_not_in_processed}`,
                `  recoverable from download: ${adoption.adoptable_from_download}`,
                `  no download origin: ${adoption.with_no_download_origin}`,
                `Processed files not in library: ${overlap.processed_files_not_in_library}`,
              ];
              if (a.show_attribution && a.show_attribution.length > 0) {
                lines.push("");
                lines.push("Shows (library files → processed, per show):");
                for (const s of a.show_attribution) {
                  lines.push(`  ${s.library_title}: ${s.matched_by_inode}/${s.files} matched, ratio ${s.match_ratio}${s.best_processed_match ? ` → ${s.best_processed_match.replace(/.*processed\/series\//, "series/")}` : " (untracked)"}`);
                }
              }
              if (adoption.movies_needing_adoption && adoption.movies_needing_adoption.length > 0) {
                lines.push("", "Movies needing adoption:");
                for (const m of adoption.movies_needing_adoption) {
                  lines.push(`  ${m.title} (${m.year}): ${m.versions} version(s), ${m.missing} missing, ${m.available_in_download} in download`);
                }
              }
              if (adoption.shows_needing_adoption && adoption.shows_needing_adoption.length > 0) {
                lines.push("", "Shows needing adoption:");
                for (const s of adoption.shows_needing_adoption) {
                  lines.push(`  ${s.title}: ${s.files} file(s), ${s.missing} missing, ${s.available_in_download} in download`);
                }
              }
              if (overlap.name_only_duplicate_count > 0) {
                lines.push("", `Name-only duplicates detected: ${overlap.name_only_duplicate_count}`);
              }
              if (a.errors && a.errors.length > 0) {
                lines.push("", "Scan errors:");
                for (const e of a.errors) lines.push(`  ${e}`);
              }
              setModal({ title: "Library Audit", lines });
            } catch (err: any) {
              setModal({ title: "Library Audit", lines: [`Error: ${err.message}`] });
            }
          }}>Library Audit</button>
          <button className="btn btn-primary" style={{ fontSize: "0.8rem", padding: "6px 12px" }} onClick={async () => {
            setModal({ title: "Adopt into Processed", lines: ["Planning..."] });
            try {
              const plan = await adoptIntoProcessed();
              if (plan.planned === 0) {
                setModal({ title: "Adopt into Processed", lines: ["Nothing to adopt — library is fully linked into processed."] });
                return;
              }
              const lines: string[] = [
                `Planned: ${plan.planned} link(s).`,
                `Movies: ${plan.totals.movies}, Series: ${plan.totals.series}.`,
                `Already present: ${plan.already_present}.`,
              ];
              if (plan.conflicts && plan.conflicts.length > 0) {
                lines.push("", `CONFLICTS (${plan.conflicts.length}) — will NOT overwrite:`);
                for (const c of plan.conflicts) {
                  lines.push(`  ${c.destination.replace(/.*processed\//, "processed/")}`);
                }
              }
              lines.push("");
              for (const item of plan.items) {
                lines.push(`[${item.kind}] ${item.destination.replace(/.*processed\//, "processed/")}`);
              }
              setModal({ title: "Adopt into Processed", lines, onApply: async () => {
                setModal({ title: "Adopt into Processed", lines: ["Linking..."] });
                try {
                  const result = await adoptIntoProcessed({ apply: true });
                  const lines: string[] = [`Linked ${result.linked} file(s).`];
                  if (result.failed?.length) {
                    lines.push(`${result.failed.length} failed:`);
                    const shown = result.failed.slice(0, 100);
                    for (const f of shown) {
                      lines.push(`  🞩 ${f.destination.replace(/.*processed\//, "processed/")}`);
                      lines.push(`    ${f.error}`);
                    }
                    if (result.failed.length > shown.length) lines.push(`  ... and ${result.failed.length - shown.length} more`);
                  }
                  setModal({ title: "Adopt into Processed", lines });
                  loadData();
                } catch (err: any) {
                  setModal({ title: "Adopt into Processed", lines: [`Error: ${err.message}`] });
                }
              } });
            } catch (err: any) {
              setModal({ title: "Adopt into Processed", lines: [`Error: ${err.message}`] });
            }
          }}>Adopt into Processed</button>
          <button className="btn btn-primary btn-tiny" onClick={() => setDownloadDirsOpen(true)}>Scan Download Dirs</button>
        </div>
      </div>

      <UnmatchedTorrentsPanel />

      {(groupedFranchises.size > 0 || ungroupedRequests.length > 0) && (
        <div className="dashboard-section">
          <h3>Requests — {requestsList.length}</h3>
          <div className="requests-grid">
            {Array.from(groupedFranchises.values()).map((franchise) => {
              const isNative = franchise.sonarr_id == null;
              const allSeasons = isNative ? null : (franchiseSeasons[franchise.sonarr_id!]?.seasons || []);
              const requestedMap = new Map(franchise.seasons.map((s: any) => [s.season, s]));
              return (
                <div key={franchise.key} className="request-card managed-card">
                  <div className="request-header">
                    <h3>{franchise.title} <span className="type-suffix">- Series ({franchise.seasons.length}{!isNative && allSeasons && allSeasons.length > franchise.seasons.length ? "/" + allSeasons.length : ""} requested)</span></h3>
                  </div>
                  <div className="managed-seasons">
                    {(isNative ? franchise.seasons : (allSeasons && allSeasons.length > 0 ? allSeasons : franchise.seasons.map((s: any) => ({ season: s.season })))).map((sn: any) => {
                      const req = requestedMap.get(sn.season);
                      const nav = isNative
                        ? (req ? () => navigate(`/native/${franchise.firstRequestId}?open=${sn.season}`) : undefined)
                        : (req ? () => navigate(`/requests/${req.id}`, { state: { back: `/managed/${franchise.sonarr_id}` } }) : undefined);
                      return (
                        <div
                          key={sn.season}
                          className={`managed-season ${req ? "" : "unrequested"}`}
                          onClick={nav}
                          style={{ opacity: req ? 1 : 0.4, cursor: req ? "pointer" : "default" }}
                        >
                          <span className="season-label">{isNative && sn.season === 0 ? "Special" : `S${String(sn.season).padStart(2, "0")}`}</span>
                          <span className={`season-status ${req ? (req.status === "AWAITING_APPROVAL" ? "has-content" : "empty") : ""}`}>
                            {req ? req.status.replace(/_/g, " ") : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="request-actions">
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(isNative ? `/native/${franchise.firstRequestId}` : `/managed/${franchise.sonarr_id}`)}>View Franchise</button>
                    {franchise.sonarr_id ? (
                      <button className="btn btn-danger btn-tiny" onClick={() => {
                        if (window.confirm(`Delete "${franchise.title}" from the dashboard?`)) {
                          deleteFranchise(franchise.sonarr_id!).then(() => loadData());
                        }
                      }}>Delete</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {ungroupedRequests.map((req: any) => (
              <div key={req.id} className="request-card">
                <div className="request-header">
                  <h3>{req.title}</h3>
                  <span className={`status-badge ${req.status.toLowerCase()}`}>
                    {req.status.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="request-meta">
                  Type: <strong>{req.type}</strong>
                  {req.type === "series" && req.season != null && <> · Season {req.season}</>}
                  {" · "}{new Date(req.created_at).toLocaleDateString()}
                  {req.status === "AWAITING_APPROVAL" && (
                    req.candidate_count > 0
                      ? <> · <strong>{req.candidate_count}</strong> release{req.candidate_count !== 1 ? "s" : ""} found</>
                      : <> · <em style={{opacity:0.6}}>no releases yet</em></>
                  )}
                </p>
                {req.requested_by && Array.isArray(req.requested_by) && req.requested_by.length > 0 && (
                  <p className="request-meta">Requested by: {req.requested_by.join(", ")}</p>
                )}
                <div className="request-actions">
                  <button className="btn btn-primary" onClick={() => navigate(`/requests/${req.id}`)}>View Releases</button>
                  <button className="btn btn-danger btn-tiny" onClick={() => setConfirmDelete({ id: req.id, title: req.title })}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {managed.length > 0 && (
        <div className="dashboard-section">
          <h3>Managed Media — {managed.length}</h3>
          <div className="requests-grid">
            {managed.map((item: any) => (
              item.type === "series" ? (
                <div key={item.group_key || item.sonarr_id || item.library_key} className="request-card managed-card">
                  <h3 className="managed-title">{item.title} <span className="type-suffix">- Series</span></h3>
                  <div className="managed-seasons">
                    {item.seasons.map((s: any) => {
                      const covered = s.covered_episodes?.length || 0;
                      const total = s.episode_count;
                      const extra = s.extras || 0;
                      const shown = covered + extra;
                      const isNativeSpecials = !item.sonarr_id && s.season === 0;
                      // Native S00 episode_count is nativeSpecialDenominator,
                      // which already floors with covered+extras — so does
                      // nativeSeasonDenominator for a native regular season.
                      // Only Sonarr's episode_count is a bare list, where the
                      // unnumbered extras are genuinely additive.
                      const denom = isNativeSpecials
                        ? Math.max(shown, total || 0)
                        : item.sonarr_id
                          ? (total ? total + extra : shown)
                          : (total || shown);
                      const finished = s.status === "COMPLETED";
                      // A content-less COMPLETED row is the dormancy artifact of
                      // clicking a season pill's "Open Releases" (ensure-season
                      // creates exactly one) — no request was made and nothing is
                      // on disk, so dim it beside the truly unrequested seasons
                      // instead of lighting it up as in-library. Genuinely in-flight
                      // rows (Discover/Seerr NEW, SEARCHING/APPROVED, torrents
                      // DOWNLOADING/SEEDING) stay bright while empty, and so does
                      // a row with release/disk history (a season completed via
                      // move-to-library may hold no processed copy of its own).
                      const activeRequest = !!s.request_id && s.status != null && s.status !== "COMPLETED" && s.status !== "DISMISSED";
                      const hasHistory = (s.release_count || 0) > 0 || (s.total_size_mb || 0) > 0;
                      const dimmed = shown === 0 && !(activeRequest || hasHistory);
                      const contentPresent = shown > 0 || (finished && hasHistory);
                      const requestedEmpty = !!s.request_id && shown === 0 && !finished && !dimmed;
                      const label = s.request_id ? (denom ? `${shown}/${denom} EP` : shown > 0 ? `${shown} EP` : s.status === "COMPLETED" && hasHistory ? "in library" : "pending") : (denom > 0 ? `${shown}/${denom} EP` : shown > 0 ? `${shown} EP` : "—");
                      const nav = item.sonarr_id
                        ? (s.request_id ? () => navigate(`/requests/${s.request_id}`, { state: { back: `/managed/${item.sonarr_id}` } }) : undefined)
                        : () => navigate(`/native/${item.first_request_id}?open=${s.season}`);
                      return (
                        <div key={s.season} className={`managed-season ${!s.request_id ? "unrequested" : ""} ${requestedEmpty ? "requested-empty" : ""}`} onClick={nav} style={{ opacity: dimmed ? 0.4 : 1, cursor: nav ? "pointer" : "default" }}>
                          <span className={`season-label ${s.season === 0 ? "season-special" : ""}`}>{s.season === 0 ? "Special" : `S${String(s.season).padStart(2, "0")}`}</span>
                          <span className={`season-status ${contentPresent ? "has-content" : "empty"}`}>
                            {label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="managed-footer">
                    <span className="rtag">{item.total_covered || item.total_releases} EP · {formatSize(item.total_size_mb)}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(item.sonarr_id ? `/managed/${item.sonarr_id}` : `/native/${item.first_request_id}`)}>Manage</button>
                    {item.sonarr_id ? (
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      if (window.confirm(`Delete "${item.title}" from the dashboard?`)) {
                        deleteFranchise(item.sonarr_id).then(() => loadData());
                      }
                    }}>Delete</button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div key={item.request_id} className="request-card managed-card">
                  <h3 className="managed-title">{item.title} <span className="type-suffix">- Movie</span></h3>
                  <div className="managed-footer">
                    <span className="rtag">{(() => { const vc = item.release_count + (item.processed_count || 0); if (vc > 0) return `${vc} version${vc !== 1 ? "s" : ""}${item.total_size_mb > 0 ? " · " + formatSize(item.total_size_mb) : ""}`; if (item.status === 'COMPLETED') return 'In Library'; return `· ${item.status}`; })()}</span>
                    <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${item.request_id}`)}>Manage</button>
                    <button className="btn btn-danger btn-tiny" onClick={() => {
                      if (window.confirm(`Delete "${item.title}" from the dashboard?`)) {
                        deleteRequest(item.request_id).then((res) => {
                          if (res?.seerrDelete && !res.seerrDelete.ok) {
                            setModal({
                              title: "Seerr delete failed",
                              lines: [
                                `"${item.title}" was deleted locally, but Seerr refused the delete (${res.seerrDelete.method}: ${res.seerrDelete.error || res.seerrDelete.body || "HTTP " + res.seerrDelete.status}).`,
                                "Seerr still holds the request, so the next sync will bring it back. Decline/delete it in Seerr's UI to stop re-appearing.",
                              ],
                            });
                          }
                          loadData();
                        });
                      }
                    }}>Delete</button>
                  </div>
                </div>
              )
            ))}
          </div>
        </div>
      )}

      {requestsList.length === 0 && managed.length === 0 && (
        <div className="empty-state">
          <p>No requests yet</p>
        </div>
      )}
    </div>
  );
}
