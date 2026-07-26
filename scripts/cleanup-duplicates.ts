/**
 * One-off script to clean up duplicate Sonarr series and DB entries
 * created by the scan-downloads bug.
 *
 * Usage: npx tsx scripts/cleanup-duplicates.ts [--dry-run]
 *
 * What it does:
 * 1. Finds duplicate media_requests by title+type
 * 2. Keeps the entry with the most release_candidates (or earliest ID)
 * 3. Updates orphaned RCs to point to the kept request
 * 4. Deletes extra media_requests
 * 5. Calls Sonarr API to delete unmonitored duplicate series
 */

import Database from "better-sqlite3";
import path from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const SONARR_URL = process.env.SONARR_URL || "http://192.168.1.100:8989";
const SONARR_API_KEY = process.env.SONARR_API_KEY || "d476c16dd86746248d06dac2240d8f7c";

const db = new Database(path.join(__dirname, "..", "data", "app.db"));

async function sonarrDelete(seriesId: number) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would delete Sonarr series ${seriesId}`);
    return;
  }
  const res = await fetch(`${SONARR_URL}/api/v3/series/${seriesId}?deleteFiles=false`, {
    method: "DELETE",
    headers: { "X-Api-Key": SONARR_API_KEY },
  });
  if (!res.ok) {
    console.log(`  Failed to delete Sonarr series ${seriesId}: ${res.status} ${await res.text()}`);
  } else {
    console.log(`  Deleted Sonarr series ${seriesId}`);
  }
}

async function main() {
  // Find duplicates: same title + type
  const dupes = db.prepare(`
    SELECT title, type, COUNT(*) as cnt
    FROM media_requests
    GROUP BY LOWER(title), type
    HAVING cnt > 1
    ORDER BY cnt DESC, title
  `).all() as any[];

  console.log(`Found ${dupes.length} duplicate titles\n`);

  const allDeletedSonarrIds: number[] = [];

  for (const dupe of dupes) {
    const rows = db.prepare(`
      SELECT mr.*, 
        (SELECT COUNT(*) FROM release_candidates rc WHERE rc.request_id = mr.id) as rc_count
      FROM media_requests mr
      WHERE LOWER(mr.title) = LOWER(?) AND mr.type = ?
      ORDER BY mr.id ASC
    `).all(dupe.title, dupe.type) as any[];

    console.log(`"${dupe.title}" (${dupe.type}) — ${rows.length} entries:`);
    for (const r of rows) {
      console.log(`  id=${r.id} sonarr_id=${r.sonarr_id} radarr_id=${r.radarr_id} status=${r.status} season=${r.season} rc_count=${r.rc_count}`);
    }

    // Keep the one with most RCs, or earliest ID as tiebreaker
    const keep = rows.reduce((best: any, cur: any) => {
      if (cur.rc_count > best.rc_count) return cur;
      if (cur.rc_count === best.rc_count && cur.id < best.id) return cur;
      return best;
    }, rows[0]);

    const keepIds = new Set([keep.id]);
    const deleteRows = rows.filter((r: any) => !keepIds.has(r.id));
    const deleteIds = deleteRows.map((r: any) => r.id);
    const deleteSonarrIds = deleteRows.map((r: any) => r.sonarr_id).filter(Boolean);
    const deleteRadarrIds = deleteRows.map((r: any) => r.radarr_id).filter(Boolean);

    console.log(`  Keeping: id=${keep.id} (sonarr_id=${keep.sonarr_id})`);
    console.log(`  Deleting: ids=${deleteIds.join(",")}`);

    if (!DRY_RUN) {
      // Move any RCs from deleted requests to the kept request
      for (const delId of deleteIds) {
        const orphanRcs = db.prepare("SELECT id FROM release_candidates WHERE request_id = ?").all(delId) as any[];
        if (orphanRcs.length > 0) {
          console.log(`  Moving ${orphanRcs.length} RCs from request ${delId} → ${keep.id}`);
          db.prepare("UPDATE release_candidates SET request_id = ? WHERE request_id = ?").run(keep.id, delId);
        }
      }

      // Delete duplicate media_requests
      for (const delId of deleteIds) {
        db.prepare("DELETE FROM media_requests WHERE id = ?").run(delId);
        console.log(`  Deleted media_request id=${delId}`);
      }
    }

    allDeletedSonarrIds.push(...deleteSonarrIds);
    console.log("");
  }

  // Delete duplicate Sonarr series
  if (allDeletedSonarrIds.length > 0) {
    console.log(`\nDeleting ${allDeletedSonarrIds.length} duplicate Sonarr series...`);
    for (const sid of allDeletedSonarrIds) {
      await sonarrDelete(sid);
    }
  }

  // Cleanup orphaned release_candidates (request_id pointing to non-existent request)
  const orphaned = db.prepare(`
    SELECT rc.id, rc.request_id FROM release_candidates rc
    LEFT JOIN media_requests mr ON mr.id = rc.request_id
    WHERE mr.id IS NULL
  `).all() as any[];
  if (orphaned.length > 0) {
    console.log(`\nDeleting ${orphaned.length} orphaned release_candidates...`);
    if (!DRY_RUN) {
      db.prepare(`DELETE FROM release_candidates WHERE id IN (${orphaned.map((r: any) => r.id).join(",")})`).run();
    }
  }

  // Cleanup orphaned approval_history
  const orphanedAh = db.prepare(`
    SELECT ah.id, ah.request_id FROM approval_history ah
    LEFT JOIN media_requests mr ON mr.id = ah.request_id
    WHERE mr.id IS NULL
  `).all() as any[];
  if (orphanedAh.length > 0) {
    console.log(`Deleting ${orphanedAh.length} orphaned approval_history...`);
    if (!DRY_RUN) {
      db.prepare(`DELETE FROM approval_history WHERE id IN (${orphanedAh.map((r: any) => r.id).join(",")})`).run();
    }
  }

  db.close();
  console.log("\nDone.");
}

main().catch(console.error);
