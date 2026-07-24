import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchFranchise } from "../api";

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export default function FranchiseDetail() {
  const { sonarrId } = useParams<{ sonarrId: string }>();
  const navigate = useNavigate();
  const [franchise, setFranchise] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<any>(null);

  useEffect(() => {
    if (!sonarrId) return;
    setLoading(true);
    setSelectedSeason(null);
    fetchFranchise(Number(sonarrId))
      .then((data) => { setFranchise(data); setError(null); })
      .catch(() => setError("Failed to load franchise"))
      .finally(() => setLoading(false));
  }, [sonarrId]);

  if (loading) return <div className="container"><p>Loading...</p></div>;
  if (error) return <div className="container error"><p>{error}</p></div>;
  if (!franchise) return <div className="container"><p>Not found</p></div>;

  // Season drill-down view
  if (selectedSeason) {
    return (
      <div className="container">
        <button className="btn btn-secondary btn-tiny" onClick={() => setSelectedSeason(null)} style={{ marginBottom: 12 }}>
          &larr; {franchise.title}
        </button>

        <h2>Season {selectedSeason.season}</h2>
        <p className="request-meta">
          {selectedSeason.release_count} release{selectedSeason.release_count !== 1 ? "s" : ""} · {formatSize(selectedSeason.total_size_mb)}
          {selectedSeason.episode_count > 0 && <> · {selectedSeason.covered_episodes?.length || 0}/{selectedSeason.episode_count} EP</>}
        </p>

        <div className="request-actions" style={{ marginBottom: 16 }}>
          <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${selectedSeason.request_id}`)}>
            Search &amp; Manage
          </button>
        </div>

        {selectedSeason.releases?.length > 0 ? (
          <div className="franchise-releases">
            {selectedSeason.releases.map((r: any) => (
              <div key={r.id} className="franchise-release">
                <span className="fr-release-title">{r.title}</span>
                {r.parsed_episodes && <span className="rtag">{r.parsed_episodes}</span>}
                <span className="rtag">{r.quality}</span>
                <span className="rtag">{formatSize(r.size_mb)}</span>
                {r.release_group && <span className="rtag">{r.release_group}</span>}
                {r.seeders != null && <span className="rtag">{r.seeders}s</span>}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ opacity: 0.5, fontSize: 13 }}>No releases yet</p>
        )}
      </div>
    );
  }

  // All seasons view
  return (
    <div className="container">
      <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")} style={{ marginBottom: 12 }}>
        &larr; Dashboard
      </button>

      <h2>{franchise.title}</h2>
      <p className="request-meta">
        {franchise.total_releases} EP · {formatSize(franchise.total_size_mb)}
      </p>

      <div className="franchise-seasons-list">
        {franchise.seasons.map((season: any) => {
          const covered = season.covered_episodes?.length || 0;
          const total = season.episode_count;
          const label = total ? `${covered}/${total} EP` : covered > 0 ? `${covered} EP` : "pending";
          return (
            <div key={season.season} className="franchise-season-row" onClick={() => setSelectedSeason(season)}>
              <div className="fr-season-left">
                <span className="season-label">S{String(season.season).padStart(2, "0")}</span>
                <span className={`season-status ${covered > 0 ? "has-content" : "empty"}`}>{label}</span>
              </div>
              <div className="fr-season-right">
                <span className="rtag">{season.release_count}r · {formatSize(season.total_size_mb)}</span>
                <span className="fr-arrow">&rsaquo;</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
