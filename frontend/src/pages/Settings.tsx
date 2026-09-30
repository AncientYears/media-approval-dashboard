import { useEffect, useState } from "react";
import { testConnections, fetchSettingsEnv } from "../api";

interface EnvEntry {
  key: string;
  label: string;
  value: string;
  set: boolean;
}

export default function Settings() {
  const [connectionStatus, setConnectionStatus] = useState<Record<string, any>>({});
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [loading, setLoading] = useState(false);

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
  }, []);

  return (
    <div className="container">
      <h2>Settings</h2>

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
