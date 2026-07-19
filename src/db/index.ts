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
      app_last_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(title, type, season)
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
      release_id INTEGER NOT NULL,
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by TEXT,
      tweaked_params TEXT DEFAULT '{}',
      approval_reason TEXT,
      FOREIGN KEY (request_id) REFERENCES media_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (release_id) REFERENCES release_candidates(id) ON DELETE CASCADE
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

  return {
    db,
    close: () => db.close(),
  };
}
