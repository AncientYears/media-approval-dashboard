import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fromQBittorrentPath, PROCESSED_MOVIES, PROCESSED_TV, MEDIA_MOVIES, MEDIA_TV } from "../config/paths";
import { identifyByPath, deriveIdentityFromFilename, registerVideoTree } from "../services/identity";

export interface DBInstance {
  db: Database.Database;
  close: () => void;
}

/** An explicit IMDb id embedded in a canonical name ("[imdbid-tt0110357]"). */
function nameImdbId(name: string): string | null {
  const m = name.match(/imdbid[-\s]*(tt\d{6,9})/i) || name.match(/\b(tt\d{6,9})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** The IMDb id a request owns, offline: cache first, then the id-anchored
 *  library_key, then an id already embedded in the stored title. */
function requestImdbId(db: Database.Database, req: { library_key?: string | null; title?: string | null }): string | null {
  if (req.library_key) {
    try {
      const row = db.prepare("SELECT imdb_id FROM tmdb_external_ids WHERE library_key = ?").get(req.library_key) as any;
      if (row?.imdb_id) return String(row.imdb_id).toLowerCase();
    } catch {}
    const fromKey = String(req.library_key).match(/\b(tt\d{6,9})\b/i);
    if (fromKey) return fromKey[1].toLowerCase();
  }
  return req.title ? nameImdbId(req.title) : null;
}

/** The library_key that owns an IMDb id, offline: cache first, then an
 *  id-anchored library_key. Null when unattributable. Lets a name's id veto a
 *  request even when THAT request has no resolved id of its own. */
function imdbIdOwnerKey(db: Database.Database, imdbId: string): string | null {
  const id = imdbId.toLowerCase();
  try {
    const row = db.prepare("SELECT library_key FROM tmdb_external_ids WHERE imdb_id = ? LIMIT 1").get(id) as any;
    if (row?.library_key) return row.library_key;
  } catch {}
  try {
    const row = db.prepare("SELECT library_key FROM media_requests WHERE library_key LIKE ? LIMIT 1").get(`%${id}%`) as any;
    if (row?.library_key) return row.library_key;
  } catch {}
  return null;
}

const TITLE_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "is", "it", "its", "vs", "part",
]);

function sharedTitleWords(a: string, b: string): number {
  const strip = (s: string) =>
    s
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(imdbid[-\s]*tt\d{6,9})\b/gi, " ")
      .replace(/\b(19|20)\d{2}\b/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !TITLE_STOP_WORDS.has(w));
  const setB = new Set(strip(b));
  const seen = new Set<string>();
  for (const w of strip(a)) if (setB.has(w)) seen.add(w);
  return seen.size;
}

/** The year a request is authoritative about: "(YYYY)" in the stored title, else
 *  the ":YYYY" tail of its library_key (which comes from TMDB). */
function requestYear(req: { title?: string | null; library_key?: string | null }): string | null {
  const inTitle = String(req.title || "").match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, -1);
  if (inTitle) return inTitle;
  return String(req.library_key || "").match(/:(\d{4})$/)?.[1] ?? null;
}

/** The year a name states: "(YYYY)" wins, else the first bare 4-digit year
 *  outside brackets (so a year inside "[DV 2019 HDR]" cannot pass as the film's). */
function nameYear(name: string): string | null {
  const base = path.basename(name, path.extname(name));
  const parenthesised = base.match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, -1);
  if (parenthesised) return parenthesised;
  return base.replace(/\[[^\]]*\]/g, " ").match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
}

/** True when a stored processed_files entry pins a film that is not this
 *  request's. Three signals, strongest first: the entry's own id against the
 *  request's id, that id's real owner against the request's library_key, and
 *  (movies only) a conflicting year on a name that shares the request's title
 *  words. Any signal unknown leaves the entry alone, so this only ever
 *  excludes - raw release names and unresolved requests are untouched. */
function processedFileContradicts(
  db: Database.Database,
  req: { type?: string | null; title?: string | null; library_key?: string | null },
  storedName: string,
): boolean {
  const mine = nameImdbId(storedName);
  if (mine) {
    const theirs = requestImdbId(db, req);
    if (theirs) return mine !== theirs;
    const owner = imdbIdOwnerKey(db, mine);
    if (owner && req.library_key) return owner !== req.library_key;
  }
  if (req.type !== "movie" || !req.library_key) return false;
  const myYear = requestYear(req);
  const theirYear = nameYear(storedName);
  if (!myYear || !theirYear || myYear === theirYear) return false;
  return sharedTitleWords(String(req.title || ""), storedName) >= 2;
}

/**
 * Relocate a stored processed_files relative path whose file is missing at boot.
 * Startup cleanup runs before any read-time self-heal, so instead of just
 * dropping the dangling entry we try to find the file's current home by its
 * registered inode identity (manual mv/rename keeps the inode). Candidates:
 * the request's season folder (series — every show dir owning the Sxx folder)
 * or the processed movies root. Accepts the first file whose identity row
 * matches library_key (+ season for series) AND whose derived episode
 * numbers/role agree with the stored basename. Returns the new rel path,
 * else null (caller falls back to dropping). Names are never trusted —
 * identity row agreement is the gate.
 */
function relocateProcessedFile(
  db: Database.Database,
  req: { type: string; library_key?: string | null; season?: number | null },
  baseDir: string,
  storedRel: string,
): string | null {
  const season = req.season ?? 0;
  const candidates: string[] = [];
  if (req.type === "series") {
    const Sxx = `S${String(season).padStart(2, "0")}`;
    try {
      for (const showDir of fs.readdirSync(PROCESSED_TV)) {
        const sf = path.join(PROCESSED_TV, showDir, Sxx);
        try {
          if (fs.statSync(sf).isDirectory()) candidates.push(sf);
        } catch {}
      }
    } catch {}
  } else {
    candidates.push(PROCESSED_MOVIES);
  }
  const stored = deriveIdentityFromFilename(path.basename(storedRel));
  for (const folder of candidates) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() || !/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(e.name)) continue;
      const row = identifyByPath(db, path.join(folder, e.name));
      if (!row) continue;
      if (req.library_key && row.library_key !== req.library_key) continue;
      if (req.type === "series" && row.season !== season) continue;
      const cur = deriveIdentityFromFilename(e.name);
      const sameNums = stored.episodeNumbers.length > 0 && cur.episodeNumbers[0] === stored.episodeNumbers[0];
      if (!sameNums && !(stored.role === "extra" && cur.role === "extra")) continue;
      return path.relative(baseDir, path.join(folder, e.name));
    }
  }
  return null;
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

    CREATE TABLE IF NOT EXISTS tmdb_season_cache (
      library_key TEXT NOT NULL,
      season INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'en-US',
      tmdb_show_id INTEGER,
      show_name TEXT,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (library_key, season, language)
    );

    CREATE TABLE IF NOT EXISTS tmdb_franchise_prefs (
      library_key TEXT PRIMARY KEY,
      language TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tmdb_external_ids (
      library_key TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      tmdb_id INTEGER,
      imdb_id TEXT,
      tvdb_id TEXT,
      title TEXT,
      year INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tmdb_external_ids_imdb ON tmdb_external_ids(imdb_id);

CREATE TABLE IF NOT EXISTS unmatched_torrents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torrent_name TEXT NOT NULL,
      torrent_hash TEXT NOT NULL UNIQUE,
      save_path TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
      size INTEGER DEFAULT 0,
      lookup_title TEXT NOT NULL,
      candidate_results TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      matched_at TEXT,
      matched_id INTEGER,
      matched_title TEXT,
      skipped INTEGER DEFAULT 0
    );

    -- Identity layer: every processed/library/workspace inode gets registered
    -- here on each write path so reads (coverage, pills, grids, panels) can
    -- resolve by inode instead of filename. Names are a backup, not the source.
    CREATE TABLE IF NOT EXISTS media_files (
      dev INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      library_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      season INTEGER NOT NULL DEFAULT 0,
      episode_nums TEXT NOT NULL DEFAULT '[]',
      role TEXT NOT NULL DEFAULT 'extra' CHECK(role IN ('numbered', 'special', 'extra')),
      release_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (dev, inode)
    );

    CREATE INDEX IF NOT EXISTS idx_media_requests_status ON media_requests(status);
    CREATE INDEX IF NOT EXISTS idx_release_candidates_request ON release_candidates(request_id);
    CREATE INDEX IF NOT EXISTS idx_approval_history_request ON approval_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_search_history_request ON search_history(request_id);
    CREATE INDEX IF NOT EXISTS idx_release_candidates_torrent_hash ON release_candidates(torrent_hash);
    CREATE INDEX IF NOT EXISTS idx_media_files_library_key ON media_files(library_key, season);
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
          library_key TEXT,
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

    // Migration: add library_key to media_requests (native arr-free identity)
    if (!mrColNames.includes("library_key")) {
      db.exec(`ALTER TABLE media_requests ADD COLUMN library_key TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_media_requests_library_key ON media_requests(library_key)`);
    }

    // Migration: add seerr_request_id to media_requests (link used by the
    // Seerr API sync so deletions/cancellations propagate to the dashboard)
    if (!mrColNames.includes("seerr_request_id")) {
      db.exec(`ALTER TABLE media_requests ADD COLUMN seerr_request_id INTEGER`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_media_requests_seerr_request_id ON media_requests(seerr_request_id)`);
    }

    // Migration: add processed_files to approval_history
    const ahCols = db.prepare("PRAGMA table_info(approval_history)").all() as any[];
    const ahColNames = ahCols.map((c: any) => c.name);
    if (!ahColNames.includes("processed_files")) {
      db.exec(`ALTER TABLE approval_history ADD COLUMN processed_files TEXT DEFAULT '[]'`);
    }

    // Migration: key tmdb_season_cache by language as well. It used to be
    // (library_key, season) only, so a fetch in one language overwrote the other
    // and the same request's episode titles flipped between e.g. Polish and
    // English depending on which endpoint wrote last. Rows are copied into the
    // language they were actually fetched in.
    const tscCols = db.prepare("PRAGMA table_info(tmdb_season_cache)").all() as any[];
    if (tscCols.length && !tscCols.some((c: any) => c.name === "language")) {
      console.log("[DB] Migrating tmdb_season_cache: adding language to primary key...");
      const rows = db.prepare("SELECT library_key, season, tmdb_show_id, show_name, payload, fetched_at FROM tmdb_season_cache").all() as any[];
      db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_season_cache_new (
          library_key TEXT NOT NULL,
          season INTEGER NOT NULL,
          language TEXT NOT NULL DEFAULT 'en-US',
          tmdb_show_id INTEGER,
          show_name TEXT,
          payload TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (library_key, season, language)
        )
      `);
      const ins = db.prepare(
        "INSERT OR REPLACE INTO tmdb_season_cache_new (library_key, season, language, tmdb_show_id, show_name, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        let lang = "en-US";
        try {
          const meta = JSON.parse(r.payload);
          if (meta && typeof meta.language === "string" && meta.language) lang = meta.language;
        } catch {}
        ins.run(r.library_key, r.season, lang, r.tmdb_show_id, r.show_name, r.payload, r.fetched_at);
      }
      db.exec("DROP TABLE tmdb_season_cache");
      db.exec("ALTER TABLE tmdb_season_cache_new RENAME TO tmdb_season_cache");
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

    // Clean dangling filenames from processed_files that no longer exist on disk.
    // Try inode-identity relocation FIRST (a manual mv/rename keeps the inode and
    // the file is still findable in the request's season folder); only drop the
    // entry when nothing can be relocated.
    const processedMoviesDir = PROCESSED_MOVIES;
    const processedTvDir = PROCESSED_TV;
    const ahWithRequest = db.prepare(`
      SELECT ah.id, ah.processed_files, mr.type, mr.id as request_id, mr.library_key, mr.season, mr.title FROM approval_history ah
      JOIN media_requests mr ON mr.id = ah.request_id
      WHERE ah.processed_files IS NOT NULL AND ah.processed_files != '[]'
    `).all() as any[];
    for (const r of ahWithRequest) {
      try {
        const arr = JSON.parse(r.processed_files);
        if (!Array.isArray(arr)) continue;
        const baseDir = r.type === "series" ? processedTvDir : processedMoviesDir;
        const filtered: string[] = [];
        const relocated: string[] = [];
        const contradicted: string[] = [];
        for (const f of arr) {
          // A stored path that pins a DIFFERENT film is a forged link from an
          // earlier title-only fuzzy match ("Mufasa The Lion King (2024)" listed
          // under "The Lion King (1994)"). The file exists on disk, so neither the
          // existence check nor inode relocation would drop it - it must be
          // dropped explicitly and re-attributed to its real owner.
          if (processedFileContradicts(db, r, f)) {
            contradicted.push(f);
            try {
              const filePath = path.join(baseDir, f);
              const fileImdb = nameImdbId(path.basename(f));
              const ownerKey = fileImdb ? imdbIdOwnerKey(db, fileImdb) : null;
              const owner = ownerKey
                ? (db.prepare("SELECT library_key, title, type, season FROM media_requests WHERE library_key = ? LIMIT 1").get(ownerKey) as any)
                : null;
              if (owner?.library_key) {
                registerVideoTree(db, filePath, {
                  library_key: owner.library_key,
                  title: owner.title || "",
                  season: owner.season ?? (owner.type === "movie" ? 0 : 1),
                });
              } else if (fileImdb) {
                // The file's id belongs to nobody we can name (cold cache, slug-only
                // key), but the request we are repairing is provably NOT it. A
                // disproven media_files row is worse than none: identity outranks
                // every other signal, so a stale row would keep claiming the inode
                // for the wrong film. Drop it and let the name/id fallback own the
                // file until TMDB can attribute the id.
                const st = fs.statSync(filePath);
                db.prepare("DELETE FROM media_files WHERE dev = ? AND inode = ?").run(st.dev, st.ino);
              }
            } catch {}
            continue;
          }
          if (fs.existsSync(path.join(baseDir, f))) {
            filtered.push(f);
            continue;
          }
          const rel = relocateProcessedFile(db, r, baseDir, f);
          if (rel) {
            relocated.push(`${f} -> ${rel}`);
            filtered.push(rel);
          }
        }
        const deduped = [...new Set(filtered)];
        if (relocated.length > 0 || contradicted.length > 0 || deduped.length !== arr.length) {
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(deduped), r.id);
          console.log(`[DB] Cleaned processed_files for approval_history id=${r.id}: ${arr.length} -> ${deduped.length}${relocated.length ? ` (relocated: ${relocated.join(", ")})` : ""}${contradicted.length ? ` (cross-franchise dropped: ${contradicted.join(", ")})` : ""}`);
        }
      } catch {}
    }

    // Merge multiple release_id IS NULL AH rows per request into one (old scan-import + move-to-processed rows)
    const multiAhRequests = db.prepare(`
      SELECT request_id, COUNT(*) as cnt FROM approval_history
      WHERE release_id IS NULL AND processed_files IS NOT NULL AND processed_files != '[]'
      GROUP BY request_id HAVING cnt > 1
    `).all() as any[];
    for (const mr of multiAhRequests) {
      const rows = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL AND processed_files IS NOT NULL AND processed_files != '[]' ORDER BY approved_at ASC").all(mr.request_id) as any[];
      if (rows.length < 2) continue;
      const mergedSet = new Set<string>();
      for (const r of rows) {
        try { JSON.parse(r.processed_files).forEach((f: string) => mergedSet.add(f)); } catch {}
      }
      if (mergedSet.size === 0) continue;
      const keepId = rows[0].id;
      const deleteIds = rows.slice(1).map((r: any) => r.id);
      db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify([...mergedSet]), keepId);
      for (const did of deleteIds) {
        db.prepare("UPDATE approval_history SET processed_files = '[]' WHERE id = ?").run(did);
      }
      console.log(`[DB] Merged ${rows.length} release_id IS NULL rows for request ${mr.request_id} into id=${keepId} (${mergedSet.size} unique files)`);
    }

    // Migrate processed_files from non-null release_id rows to null-release_id rows
    // (import-library was wrongly appending to torrent's AH row instead of creating a null-release_id row)
    const nonNullRows = db.prepare(`
      SELECT id, request_id, processed_files FROM approval_history
      WHERE release_id IS NOT NULL AND processed_files IS NOT NULL AND processed_files != '[]'
    `).all() as any[];
    for (const row of nonNullRows) {
      try {
        const files: string[] = JSON.parse(row.processed_files);
        if (files.length === 0) continue;
        // Find or create null-release_id row for this request
        let nullRow = db.prepare("SELECT id, processed_files FROM approval_history WHERE request_id = ? AND release_id IS NULL ORDER BY approved_at DESC LIMIT 1").get(row.request_id) as any;
        if (nullRow) {
          const existing: string[] = JSON.parse(nullRow.processed_files || "[]");
          const merged = new Set([...existing, ...files]);
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify([...merged]), nullRow.id);
        } else {
          db.prepare("INSERT INTO approval_history (request_id, release_id, approved_by, processed_files) VALUES (?, NULL, 'system', ?)").run(row.request_id, JSON.stringify(files));
        }
        db.prepare("UPDATE approval_history SET processed_files = '[]' WHERE id = ?").run(row.id);
        console.log(`[DB] Migrated ${files.length} file(s) from approval_history id=${row.id} (release_id NOT NULL) to null-release_id row for request ${row.request_id}`);
      } catch {}
    }

    // Remove processed files that are hardlinks to torrent download files (share same inode)
    // These are the torrent's own files that were hardlinked to /processed via MoveToProcessed,
    // then re-imported via import-library — they shouldn't count as separate versions.
    const nullRowsForInode = db.prepare(`
      SELECT ah.id, ah.request_id, ah.processed_files, mr.type
      FROM approval_history ah
      JOIN media_requests mr ON mr.id = ah.request_id
      WHERE ah.release_id IS NULL AND ah.processed_files IS NOT NULL AND ah.processed_files != '[]'
    `).all() as any[];
    const moviesDir = PROCESSED_MOVIES;
    const tvDir = PROCESSED_TV;
    for (const nRow of nullRowsForInode) {
      try {
        const files: string[] = JSON.parse(nRow.processed_files);
        if (files.length === 0) continue;
        // Get all RC download paths for this request
        const rcs = db.prepare("SELECT save_path, title FROM release_candidates WHERE request_id = ? AND torrent_hash != ''").all(nRow.request_id) as any[];
        if (rcs.length === 0) continue;
        // Collect download inodes
        const downloadInodes = new Set<number>();
        for (const rc of rcs) {
          const rawPath = rc.save_path || "";
          const hostPath = fromQBittorrentPath(rawPath);
          const downloadPath = path.join(hostPath, rc.title);
          try {
            if (fs.existsSync(downloadPath)) {
              downloadInodes.add(fs.statSync(downloadPath).ino);
            }
          } catch {
            // try without title (if save_path already includes filename or is a directory)
            try {
              if (fs.existsSync(hostPath)) {
                const stat = fs.statSync(hostPath);
                if (stat.isDirectory()) {
                  // Directory content_path — scan for video files
                  for (const entry of fs.readdirSync(hostPath)) {
                    if (!/\.(mkv|mp4|avi|mov|ts|wmv)$/i.test(entry)) continue;
                    try { downloadInodes.add(fs.statSync(path.join(hostPath, entry)).ino); } catch {}
                  }
                } else {
                  downloadInodes.add(stat.ino);
                }
              }
            } catch {}
          }
        }
        if (downloadInodes.size === 0) continue;
        // Check each processed file's inode against download inodes
        const kept: string[] = [];
        const removed: string[] = [];
        for (const f of files) {
          let filePath: string;
          if (nRow.type === "series") {
            filePath = path.join(tvDir, f);
          } else {
            filePath = path.join(moviesDir, f);
          }
          try {
            if (fs.existsSync(filePath) && downloadInodes.has(fs.statSync(filePath).ino)) {
              removed.push(f);
              continue;
            }
          } catch {}
          kept.push(f);
        }
        if (removed.length > 0) {
          db.prepare("UPDATE approval_history SET processed_files = ? WHERE id = ?").run(JSON.stringify(kept), nRow.id);
          console.log(`[DB] Removed ${removed.length} torrent-hardlink file(s) from approval_history id=${nRow.id} for request ${nRow.request_id}: ${removed.join(", ")}`);
        }
      } catch {}
    }

    // Cleanup degenerate request rows: empty/NULL status ghosts left by old
    // import paths (e.g. a batch of native series rows at S00/S01 with no real
    // state). They carry no arr link, no Seerr link and no content — pure
    // display junk that the managed-card group-split would otherwise resurrect
    // as amber "requested" pills for seasons that were never requested.
    const ghostRows = db.prepare(`
      SELECT mr.id, mr.title, mr.type, mr.season, mr.status, mr.library_key FROM media_requests mr
      WHERE (mr.status IS NULL OR mr.status = '')
      AND mr.sonarr_id IS NULL AND mr.radarr_id IS NULL
      AND mr.seerr_request_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM approval_history ah
        WHERE ah.request_id = mr.id
        AND (ah.release_id IS NOT NULL OR (ah.processed_files IS NOT NULL AND ah.processed_files != '[]'))
      )
    `).all() as any[];
    for (const g of ghostRows) {
      db.prepare("DELETE FROM media_requests WHERE id = ?").run(g.id);
      console.log(`[DB] Removed degenerate request #${g.id} "${g.title}" (${g.type}, season=${g.season}, status="${g.status}", key=${g.library_key}) — no content, no links`);
    }
    if (ghostRows.length > 0) console.log(`[DB] Cleaned up ${ghostRows.length} degenerate request row(s).`);

    // Identity rows left pointing at a library_key NO request holds. These are the
    // residue of a retitle/fix-identity performed before media_files was migrated
    // alongside the key: the request moved, the row did not. Because every read is
    // inode-first, such a row vetoes its own file for every card ("Nothing to
    // rename in this layer" while the file still sits in /Processed), and identity
    // outranks every weaker signal, so nothing downstream can rescue it. Deleting
    // is the honest repair — the row asserts an owner that does not exist, and the
    // name/id fallback re-claims the inode on the next read. Files on disk are
    // never touched.
    const orphanIdentities = db
      .prepare(
        `SELECT mf.dev, mf.inode, mf.library_key FROM media_files mf
         WHERE mf.library_key != ''
           AND NOT EXISTS (SELECT 1 FROM media_requests mr WHERE mr.library_key = mf.library_key)`,
      )
      .all() as any[];
    for (const o of orphanIdentities) {
      db.prepare("DELETE FROM media_files WHERE dev = ? AND inode = ?").run(o.dev, o.inode);
    }
    if (orphanIdentities.length > 0) {
      const keys = Array.from(new Set(orphanIdentities.map((o) => o.library_key)));
      console.log(
        `[DB] Cleared ${orphanIdentities.length} orphaned identity row(s) pointing at ${keys.length} unowned key(s): ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}`,
      );
    }

    // media_files.release_name is refreshed after every Fix Names rename, but that
    // UPDATE briefly ran with the wrong column name ("ino" instead of "inode") behind
    // a bare catch {}, so the SQL error was swallowed and every renamed file kept its
    // PRE-rename name. That matters beyond cosmetics: storedNameMatchesRow() compares
    // this value against a real on-disk basename to self-heal stale approval_history
    // paths, so a stale release_name silently disables that recovery.
    // media_files has no path column, so recover the truth by stat: walk the managed
    // trees, map dev:ino -> basename, and refresh only rows that disagree. Idempotent
    // (writes on mismatch only) and a no-op once names are correct.
    const nameByInode = new Map<string, string>();
    const walkForNames = (dir: string, depth = 0): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walkForNames(full, depth + 1);
        } else if (e.isFile() && /\.(mkv|mp4|avi|mov|ts|wmv|m4v)$/i.test(e.name)) {
          try {
            const st = fs.statSync(full);
            if (st.ino) nameByInode.set(`${st.dev}:${st.ino}`, e.name);
          } catch {}
        }
      }
    };
    for (const root of [PROCESSED_MOVIES, PROCESSED_TV, MEDIA_MOVIES, MEDIA_TV]) walkForNames(root);
    if (nameByInode.size > 0) {
      const refreshName = db.prepare(
        "UPDATE media_files SET release_name = ?, updated_at = datetime('now') WHERE dev = ? AND inode = ?",
      );
      const renamed: string[] = [];
      const allRows = db.prepare("SELECT dev, inode, release_name FROM media_files").all() as any[];
      for (const r of allRows) {
        const actual = nameByInode.get(`${r.dev}:${r.inode}`);
        if (actual && actual !== r.release_name) {
          refreshName.run(actual, r.dev, r.inode);
          renamed.push(`${r.release_name || "(null)"} -> ${actual}`);
        }
      }
      if (renamed.length > 0) {
        console.log(`[DB] Refreshed ${renamed.length} stale media_files.release_name value(s) from disk:`);
        for (const line of renamed) console.log(`[DB]   ${line}`);
      }
    }

    // Migration: create unmatched_torrents table if not exists
    db.exec(`CREATE TABLE IF NOT EXISTS unmatched_torrents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torrent_name TEXT NOT NULL,
      torrent_hash TEXT NOT NULL UNIQUE,
      save_path TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('movie', 'series')),
      size INTEGER DEFAULT 0,
      lookup_title TEXT NOT NULL,
      candidate_results TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      matched_at TEXT,
      matched_id INTEGER,
      matched_title TEXT,
      skipped INTEGER DEFAULT 0
    )`);

  return {
    db,
    close: () => db.close(),
  };
}
