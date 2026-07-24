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

  useEffect(() => {
    if (!sonarrId) return;
    setLoading(true);
    fetchFranchise(Number(sonarrId))
      .then((data) => { setFranchise(data); setError(null); })
      .catch(() => setError("Failed to load franchise"))
      .finally(() => setLoading(false));
  }, [sonarrId]);

  if (loading) return <div className="container"><p>Loading...</p></div>;
  if (error) return <div className="container error"><p>{error}</p></div>;
  if (!franchise) return <div className="container"><p>Not found</p></div>;

  return (
    <div className="container">
      <button className="btn btn-secondary btn-tiny" onClick={() => navigate("/")} style={{ marginBottom: 12 }}>
        &larr; Back
      </button>

      <h2>{franchise.title}</h2>
      <p className="request-meta">
        {franchise.total_releases} release{franchise.total_releases !== 1 ? "s" : ""} · {formatSize(franchise.total_size_mb)}
      </p>

      {franchise.seasons.map((season: any) => (
        <div key={season.season} className="franchise-season">
          <div className="franchise-season-header">
            <h3>Season {season.season}</h3>
            <span className="rtag">{season.release_count}r · {formatSize(season.total_size_mb)}</span>
            <button className="btn btn-primary btn-tiny" onClick={() => navigate(`/requests/${season.request_id}`)}>
              Search &amp; Manage
            </button>
          </div>

          {season.releases.length > 0 ? (
            <div className="franchise-releases">
              {season.releases.map((r: any) => (
                <div key={r.id} className="franchise-release">
                  <span className="fr-release-title">{r.title}</span>
                  <span className="rtag">{r.quality}</span>
                  <span className="rtag">{formatSize(r.size_mb)}</span>
                  {r.release_group && <span className="rtag">{r.release_group}</span>}
                  {r.seeders != null && <span className="rtag">{r.seeders}s</span>}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ opacity: 0.5, fontSize: 13, margin: "8px 0" }}>No releases yet</p>
          )}
        </div>
      ))}
    </div>
  );
}
