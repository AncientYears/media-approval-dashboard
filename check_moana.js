const Database = require('better-sqlite3');
const db = new Database('./data/app.db');

// Find all Moana entries
const rows = db.prepare("SELECT id, title, radarr_id, status, type FROM media_requests WHERE title LIKE '%oana%'").all();
console.log("=== Moana requests ===");
console.log(JSON.stringify(rows, null, 2));

// Check if Moana 2026 has any releases or approvals
for (const row of rows) {
  const releases = db.prepare("SELECT id, torrent_hash, radarr_release_id FROM release_candidates WHERE request_id = ?").all(row.id);
  const approvals = db.prepare("SELECT * FROM approval_history WHERE request_id = ?").all(row.id);
  console.log(`\n--- Request ${row.id}: ${row.title} (status=${row.status}, radarr_id=${row.radarr_id}) ---`);
  console.log(`Releases: ${JSON.stringify(releases, null, 2)}`);
  console.log(`Approvals: ${JSON.stringify(approvals, null, 2)}`);
}

db.close();
