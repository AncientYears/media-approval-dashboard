import { useEffect, useState } from "react";
import { testConnections } from "../api";

export default function Settings() {
  const [connectionStatus, setConnectionStatus] = useState<Record<string, any>>({});
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
  }, []);

  return (
    <div className="container">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>API Configuration</h3>
        <p className="section-description">
          Configure connections to Radarr, Sonarr, Jellyseerr, and ntfy in your .env file.
        </p>

        <div className="settings-form">
          <div className="form-group">
            <label>Radarr Configuration</label>
            <p className="help-text">URL: http://192.168.1.100:7878 | API Key: (configured in .env)</p>
          </div>

          <div className="form-group">
            <label>Sonarr Configuration</label>
            <p className="help-text">URL: http://192.168.1.100:8989 | API Key: (configured in .env)</p>
          </div>

          <div className="form-group">
            <label>Jellyseerr Configuration</label>
            <p className="help-text">URL: http://192.168.1.100:5055 | (Reference only)</p>
          </div>

          <div className="form-group">
            <label>ntfy Configuration</label>
            <p className="help-text">URL and Topic: (configured in .env)</p>
          </div>
        </div>
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
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p>Media Approval Dashboard v0.1.0</p>
        <p className="help-text">
          A human-friendly approval gateway for Radarr/Sonarr. Review, compare, and approve media releases before download.
        </p>
      </section>
    </div>
  );
}
