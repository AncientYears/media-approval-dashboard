import { useEffect, useState } from "react";
import { testConnections, fetchSettingsEnv, fetchNamingSettings, saveNamingSettings } from "../api";

interface EnvEntry {
  key: string;
  label: string;
  value: string;
  set: boolean;
}

interface NamingConf {
  enabled: boolean;
  series_dir: string;
  movie_dir: string;
  season_dir: string;
  episode_file: string;
  special_file: string;
  movie_file: string;
}

const NAMING_LABELS: Record<string, string> = {
  series_dir: "Series show folder",
  movie_dir: "Movie folder",
  season_dir: "Season folder",
  episode_file: "Numbered episode file",
  special_file: "S00 special file",
  movie_file: "Movie file",
};

const NAMING_FIELDS = ["series_dir", "movie_dir", "season_dir", "episode_file", "special_file", "movie_file"] as const;

export default function Settings() {
  const [connectionStatus, setConnectionStatus] = useState<Record<string, any>>({});
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const [naming, setNaming] = useState<NamingConf | null>(null);
  const [namingTokens, setNamingTokens] = useState<string[]>([]);
  const [savingNaming, setSavingNaming] = useState(false);
  const [namingSaved, setNamingSaved] = useState(false);

  const handleTestConnections = async () => {
    try {
      setLoading(true);
      const status = await testConnections();
      setConnectionStatus(status);
    } catch (error) {
      console.error("Failed to test connections", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleTestConnections();
    fetchSettingsEnv()
      .then((data) => setEnvEntries(data.entries || []))
      .catch((error) => console.error("Failed to load environment settings", error));
    fetchNamingSettings()
      .then((data) => {
        setNaming(data.conf || null);
        setNamingTokens(data.tokens || []);
      })
      .catch((error) => console.error("Failed to load naming settings", error));
  }, []);

  const handleSaveNaming = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!naming) return;
    setSavingNaming(true);
    setNamingSaved(false);
    try {
      const res = await saveNamingSettings(naming);
      setNaming(res.conf);
      setNamingSaved(true);
    } catch (error) {
      console.error("Failed to save naming settings", error);
      alert("Failed to save naming settings");
    } finally {
      setSavingNaming(false);
    }
  };

  return (
    <div className="container">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Naming Templates (P1)</h3>
        <p className="section-description">
          Canonical names applied to NEW processed/library files (existing files are never
          renamed). Replaces <code>{"{Token}"}</code> placeholders; the year/id tags make
          the names Jellyfin-friendly and identity-anchored. Disable to keep today's raw
          release names.
        </p>

        {naming && (
          <form className="settings-form" onSubmit={handleSaveNaming}>
            <label className="naming-toggle">
              <input
                type="checkbox"
                checked={naming.enabled}
                onChange={(e) => setNaming({ ...naming, enabled: e.target.checked })}
              />
              Apply canonical naming to new files
            </label>

            {NAMING_FIELDS.map((field) => (
              <div key={field} className="form-group">
                <label htmlFor={`naming-${field}`}>{NAMING_LABELS[field]}</label>
                <input
                  id={`naming-${field}`}
                  type="text"
                  value={(naming as any)[field]}
                  onChange={(e) => setNaming({ ...naming, [field]: e.target.value })}
                  spellCheck={false}
                />
              </div>
            ))}

            <div className="help-text">
              Available tokens:{" "}
              {namingTokens.map((t) => (
                <code key={t}>{t}</code>
              ))}
            </div>

            <button type="submit" className="btn btn-primary" disabled={savingNaming}>
              {savingNaming ? "Saving..." : "Save naming templates"}
            </button>
            {namingSaved && <span className="settings-saved">Saved</span>}
          </form>
        )}
      </section>

      <section className="settings-section">
        <h3>Configuration (.env)</h3>
        <p className="section-description">
          Current environment configuration, read straight from the server. Secrets
          (API keys, passwords) are masked. Edit these in your .env file and restart.
        </p>

        {envEntries.length > 0 && (
          <table className="env-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Variable</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {envEntries.map((entry) => (
                <tr key={entry.key}>
                  <td>{entry.label}</td>
                  <td>
                    <code>{entry.key}</code>
                  </td>
                  <td className={entry.value ? "env-value" : "env-empty"}>
                    {entry.value || "—"}
                  </td>
                  <td>
                    <span className={`status-indicator ${entry.set ? "success" : "error"}`} />
                    <span className="status-text">{entry.set ? "Set" : "Unset"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <h3>Connection Status</h3>
        <button className="btn btn-primary" onClick={handleTestConnections} disabled={loading}>
          {loading ? "Testing..." : "Test Connections"}
        </button>

        {Object.keys(connectionStatus).length > 0 && (
          <div className="connection-status">
            {Object.entries(connectionStatus).map(([service, status]: [string, any]) => (
              <div key={service} className="status-item">
                <span className={`status-indicator ${status.success ? "success" : "error"}`}></span>
                <span className="service-name">{service}</span>
                <span className="status-text">{status.success ? "Connected" : "Failed"}</span>
                {!status.success && (status.message || status.error) && (
                  <span className="status-detail">{status.message || status.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p>Media Approval Dashboard v0.1.0</p>
        <p className="help-text">
          A human-friendly approval gateway for Prowlarr + qBittorrent. Review, compare, and approve media releases before download.
        </p>
      </section>
    </div>
  );
}
