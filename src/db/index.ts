import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface DBInstance {
  db: Database.Database;
  close: () => void;
}

export function initializeDatabase(dbPath: string): DBInstance {
  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
      radarr_id INTEGER,
      sonarr_id INTEGER,
      season INTEGER,
      status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'APPROVED', 'DOWNLOADING', 'SEEDING', 'COMPLETED', 'REJECTED', 'DISMISSED')),
      requested_by TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      app_last_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS release_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      radarr_release_id TEXT NOT NULL,
      title TEXT NOT NULL,
      indexer TEXT NOT NULL,
      size_mb INTEGER,
      radarr_quality TEXT,
      radarr_custom_formats TEXT DEFAULT '[]',
      radarr_rank INTEGER,
      language TEXT DEFAULT '',
      info_url TEXT DEFAULT '',
      seeders INTEGER,
      leechers INTEGER,
      release_group TEXT DEFAULT '',
      edition TEXT DEFAULT '',
      protocol TEXT DEFAULT '',
      publish_date TEXT DEFAULT '',
      radarr_indexer_id INTEGER DEFAULT 0,
      torrent_hash TEXT DEFAULT '',
      save_path TEXT DEFAULT '',
      app_score INTEGER DEFAULT 0,
      positive_attrs TEXT DEFAULT '[]',
      negative_attrs TEXT DEFAULT '[]',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES media_requests(id) ON DELETE CASCADE,
      UNIQUE(request_id, radarr_release_id)
    );

    CREATE TABLE IF NOT EXISTS approval_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      release_id INTEGER,
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by TEXT,
      tweaked_params TEXT DEFAULT '{}',
      approval_reason TEXT,
      FOREIGN KEY (request_id) REFERENCES media_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (release_id) REFERENCES release_candidates(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      search_params TEXT DEFAULT '{}',
      results_count INTEGER DEFAULT 0,
      searched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES media_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS release_group_scores (
      group_name TEXT PRIMARY KEY,
      radarr_score INTEGER DEFAULT 0,
      your_bias REAL DEFAULT 1.0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS custom_rules (
      rule_name TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('require', 'exclude', 'prefer')),
      value TEXT NOT NULL,
      applies_to TEXT NOT NULL CHECK(applies_to IN ('movie', 'tv', 'all'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_requests_status ON media_requests(status);
    CREATE INDEX IF NOT EXISTS idx_release_candidates_request ON release_candidates(request_id);
    CREATE INDEX IF NOT EXISTS idx_approval_history_request ON approval_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_search_history_request ON search_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_release_candidates_torrent_hash ON release_candidates(torrent_hash);
  `);

    // Repair: if media_requests_new exists but media_requests does not,
    // the previous migration dropped the old table but failed to rename.
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const hasNewTable = tableNames.some((t: any) => t.name === "media_requests_new");
    const hasMainTable = tableNames.some((t: any) => t.name === "media_requests");
    if (hasNewTable && !hasMainTable) {
      db.exec(`ALTER TABLE media_requests_new RENAME TO media_requests`);
    } else if (hasNewTable && hasMainTable) {
      // Both exist — old migration leftover, safe to drop the temp table
      db.exec(`DROP TABLE IF EXISTS media_requests_new`);
    }

    // Migration: remove overly-strict UNIQUE(title, type, season)
    const indexes = db.prepare("PRAGMA index_list(media_requests)").all() as any[];
    const hasUniqueConstraint = indexes.some((idx: any) => idx.unique === 1 && idx.origin === "u");
    if (hasUniqueConstraint) {
      // Use a safe 3-step approach: create new, copy data, swap — never drop first
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
          radarr_id INTEGER,
          sonarr_id INTEGER,
          season INTEGER,
          status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW', 'SEARCHING', 'AWAITING_APPROVAL', 'APPROVED', 'DOWNLOADING', 'SEEDING', 'COMPLETED', 'REJECTED', 'DISMISSED')),
          requested_by TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          app_last_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          episode_count INTEGER
        );
        INSERT INTO media_requests_new SELECT * FROM media_requests;
      `);
      db.exec(`DROP TABLE media_requests`);
      db.exec(`ALTER TABLE media_requests_new RENAME TO media_requests`);
    }

    // Recreate indexes that may have been lost during migration
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_requests_status ON media_requests(status);
    `);

    // Migration: add info_url if missing
    const cols = db.prepare("PRAGMA table_info(release_candidates)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    for (const [name, type] of [
      ["info_url", "TEXT DEFAULT ''"],
      ["seeders", "INTEGER"],
      ["leechers", "INTEGER"],
      ["release_group", "TEXT DEFAULT ''"],
      ["edition", "TEXT DEFAULT ''"],
      ["protocol", "TEXT DEFAULT ''"],
      ["publish_date", "TEXT DEFAULT ''"],
      ["radarr_indexer_id", "INTEGER DEFAULT 0"],
      ["torrent_hash", "TEXT DEFAULT ''"],
      ["save_path", "TEXT DEFAULT ''"],
    ] as [string, string][]) {
      if (!colNames.includes(name)) {
        db.exec(`ALTER TABLE release_candidates ADD COLUMN ${name} ${type}`);
      }
    }

    // Migration: add episode_count to media_requests
    const mrCols = db.prepare("PRAGMA table_info(media_requests)").all() as any[];
    const mrColNames = mrCols.map((c: any) => c.name);
    if (!mrColNames.includes("episode_count")) {
      db.exec(`ALTER TABLE media_requests ADD COLUMN episode_count INTEGER`);
    }

    // Migration: add parsed_episodes to release_candidates
    if (!colNames.includes("parsed_episodes")) {
      db.exec(`ALTER TABLE release_candidates ADD COLUMN parsed_episodes TEXT DEFAULT ''`);
    }

    // Migration: add last_searched_at to media_requests
    if (!mrColNames.includes("last_searched_at")) {
      db.exec(`ALTER TABLE media_requests ADD COLUMN last_searched_at TEXT`);
    }

    // Migration: add processed_files to approval_history
    const ahCols = db.prepare("PRAGMA table_info(approval_history)").all() as any[];
    const ahColNames = ahCols.map((c: any) => c.name);
    if (!ahColNames.includes("processed_files")) {
      db.exec(`ALTER TABLE approval_history ADD COLUMN processed_files TEXT DEFAULT '[]'`);
    }

    // Migration: make release_id nullable in approval_history (for system/library-imported entries)
    const releaseIdCol = ahCols.find((c: any) => c.name === "release_id");
    if (releaseIdCol && releaseIdCol.notnull === 1) {
      console.log("[DB] Migrating approval_history: making release_id nullable...");
      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE approval_history_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id INTEGER NOT NULL,
          release_id INTEGER,
          approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          approved_by TEXT,
          tweaked_params TEXT DEFAULT '{}',
          approval_reason TEXT,
          processed_files TEXT DEFAULT '[]',
          FOREIGN KEY (request_id) REFERENCES media_requests(id) ON DELETE CASCADE,
          FOREIGN KEY (release_id) REFERENCES release_candidates(id) ON DELETE SET NULL
        );
        INSERT INTO approval_history_new (id, request_id, release_id, approved_at, approved_by, tweaked_params, approval_reason, processed_files)
          SELECT id, request_id, release_id, approved_at, approved_by, tweaked_params, approval_reason, processed_files FROM approval_history;
        DROP TABLE approval_history;
        ALTER TABLE approval_history_new RENAME TO approval_history;
        CREATE INDEX IF NOT EXISTS idx_approval_history_request ON approval_history(request_id);
      `);
      db.pragma("foreign_keys = ON");
      console.log("[DB] Migration done: release_id is now nullable.");
    }

    // Dedup processed_files arrays across all approval_history rows
    const dupRows = db.prepare("SELECT id, processed_files FROM approval_history WHERE processed_files IS NOT NULL AND processed_files != '[]'").all() as any[];
    for (const r of dupRows) {
      try {
        const arr = JSON.parse(r.processed_files);
        if (!Array.isArray(arr)) continue;
        const deduped = [...new Set(arr)];
        if (deduped.length !== arr.length) {
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(deduped), r.id);
          console.log(`[DB] Deduped processed_files for approval_history id=${r.id}: ${arr.length} -> ${deduped.length}`);
        }
      } catch {}
    }

    // Clean dangling filenames from processed_files that no longer exist on disk
    const processedMoviesDir = process.env.PROCESSED_MOVIES || "/media/Torrents/processed/filmy";
    const processedTvDir = process.env.PROCESSED_TV || "/media/Torrents/processed/serialy";
    const ahWithRequest = db.prepare(`
      SELECT ah.id, ah.processed_files, mr.type FROM approval_history ah
      JOIN media_requests mr ON mr.id = ah.request_id
      WHERE ah.processed_files IS NOT NULL AND ah.processed_files != '[]'
    `).all() as any[];
    for (const r of ahWithRequest) {
      try {
        const arr = JSON.parse(r.processed_files);
        if (!Array.isArray(arr)) continue;
        const baseDir = r.type === "series" ? processedTvDir : processedMoviesDir;
        const filtered = arr.filter((f: string) => fs.existsSync(path.join(baseDir, f)));
        if (filtered.length !== arr.length) {
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(filtered), r.id);
          console.log(`[DB] Cleaned dangling processed_files for approval_history id=${r.id}: ${arr.length} -> ${filtered.length}`);
        }
      } catch {}
    }

  return {
    db,
    close: () => db.close(),
  };
}
