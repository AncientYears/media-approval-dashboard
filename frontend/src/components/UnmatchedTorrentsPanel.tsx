import { useState, useEffect } from "react";
import { fetchUnmatched, matchUnmatched, skipUnmatched } from "../api";

interface UnmatchedEntry {
  id: number;
  torrent_name: string;
  type: "movie" | "series";
  size: number;
  lookup_title: string;
  candidate_results: Array<{ id: number; title: string; year?: number; overview?: string }>;
  created_at: string;
}

export default function UnmatchedTorrentsPanel() {
  const [entries, setEntries] = useState<UnmatchedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const data = await fetchUnmatched();
      setEntries(data || []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleMatch(entry: UnmatchedEntry, index: number) {
    setActionId(entry.id);
    try {
      const result = await matchUnmatched(entry.id, index);
      console.log(`[Unmatched] Matched #${entry.id}: ${result.title}`, result);
      await load();
    } catch (e: any) {
      alert(`Match failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setActionId(null);
    }
  }

  async function handleSkip(entry: UnmatchedEntry) {
    setActionId(entry.id);
    try {
      await skipUnmatched(entry.id);
      await load();
    } catch (e: any) {
      alert(`Skip failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setActionId(null);
    }
  }

  if (loading) return null;
  if (entries.length === 0) return null;

  const isLoading = actionId !== null;

  return (
    <div className="dashboard-section">
      <h2>Unmatched Torrents — {entries.length}</h2>
      <div className="requests-grid">
        {entries.map((entry) => (
          <div key={entry.id} className="request-card franchise-card" style={{ borderLeft: "4px solid #f59e0b" }}>
            <div className="franchise-header">
              <div className="franchise-title-row">
                <span className="franchise-title" title={entry.torrent_name}>
                  {entry.torrent_name.length > 60 ? entry.torrent_name.slice(0, 60) + "..." : entry.torrent_name}
                </span>
                <span className="badge" style={{ background: entry.type === "movie" ? "#3b82f6" : "#8b5cf6" }}>
                  {entry.type}
                </span>
                <span className="badge" style={{ background: "#6b7280" }}>
                  {Math.round(entry.size / (1024 * 1024))} MB
                </span>
              </div>
              {entry.candidate_results.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  <p style={{ margin: 0, fontSize: 12, color: "#94a3b8" }}>Pick a match:</p>
                  {entry.candidate_results.map((c, i) => (
                    <button
                      key={i}
                      disabled={isLoading}
                      onClick={() => handleMatch(entry, i)}
                      style={{
                        textAlign: "left", padding: "6px 10px", cursor: isLoading ? "wait" : "pointer",
                        background: i === 0 ? "#1e3a5f" : "var(--card-bg, #1e293b)",
                        border: "1px solid #334155", borderRadius: 4, color: "#e2e8f0",
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                      }}
                    >
                      <span>{c.title}{c.year ? ` (${c.year})` : ""}</span>
                      {actionId === entry.id && <span style={{ fontSize: 11 }}>...</span>}
                    </button>
                  ))}
                </div>
              )}
              {entry.candidate_results.length === 0 && (
                <p style={{ color: "#ef4444", fontSize: 13 }}>No candidates found</p>
              )}
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button
                  className="btn btn-sm"
                  style={{ background: "#ef4444", color: "#fff", border: "none", padding: "4px 12px", borderRadius: 4, cursor: isLoading ? "wait" : "pointer" }}
                  onClick={() => handleSkip(entry)}
                  disabled={isLoading}
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
