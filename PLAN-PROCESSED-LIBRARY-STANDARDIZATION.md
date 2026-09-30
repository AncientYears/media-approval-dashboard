# Plan: Standardize Processed vs Library Structure

Status: **proposal — not implemented**. Refs the deployed arr-free layout.

## Problem

Two trees, two conventions, reconciled loosely by inode + fuzzy folder matching:

| | `/media/Torrents/processed/…` (app-owned) | `/media/{Filmy,Serialy}` (Jellyfin-owned) |
|---|---|---|
| Show folder | fuzzy from stored title (release-flavoured, sometimes localized), `Title (Year)` | user/Jellyfin shelf name, usually localized (`Tajemnica Sagali`, `Sezon I`, bilingual) |
| Season folder | canonical `Sxx` (`S00` specials) written by the app | `Season 1`, `Sezon I`, `S01`, `specials` — whatever exists |
| File names | release basenames (never renamed) | same inodes / basenames (hardlinks, nothing renames) |
| Authority | **second source of truth**, the modifiable working set | presentation layer, scanned/parsed by Jellyfin |

Every feature that counts or navigates files (`coveredEpisodesForRequest`,
`unnumberedFilesInSeasonFolder`, `diskSeasonFolders`, structure-first franchises,
pills, episode grids, `import-library/native`, `adopt-into-processed`, destroy's
`renameSync`) resolves folders by fuzzy title matching against `PROCESSED_TV`
and re-validates by inode. The two trees are free to look completely different
because the app never assumes the library mirrors processed — but that tolerance
is what makes every lookup fuzzy, every coverage cell a scan, and every rename
risky.

**Hard constraint:** `approval_history.processed_files` stores
`PROCESSED_TV`-relative JSON paths (e.g. `"Fineasz i Ferb - Phineas and Ferb/S00/X.mkv"`).
Renaming processed folders invalidates those rows unless they are rewritten in
lockstep — coverage, processed panels, player open-links, import-library,
adoption and workspace-keep all read them.

## Invariants (do not violate)

1. `/Download` immutable, `/Processed` modifiable, `/Library` presentation layer.
2. Identity = inode (`stat().ino`), never title.
3. Hardlinks: all four trees on one filesystem.
4. **Library folder names are user-owned** (Jellyfin scrapes them). The app must
   not rename library folders.
5. All reads must keep working against a partially-migrated tree (rollback-safe).

## Recommendation: naming service + one-time processed normalization

Do NOT rename the library. Standardize **processed** to a machine-parseable
canonical form and stop inferring pathnames; make the library explicitly mapped.

### 1. Path kernel (`src/config/paths.ts` or new `src/config/naming.ts`)

- One helper for every path a feature computes:
  `processedShowDir(library_key|title, year)`, `processedSeasonDir(…, season)`,
  `libraryShowDir(…)`, `librarySeasonDir(…)`.
- Naming rules become the *only* place that formats a folder name. All fuzz
  (`normalizeFolder`, `matchShowFolders`, `findSeasonFolder`,
  `findExistingSeasonFolder`, `parseSeasonNumber`) stays as **fallback only**,
  used to *repair* the catalog, never as the primary read path.
- Format: show dir `Clean Title (<year>)`, season dir `Sxx` in processed;
  library dirs resolved via existing code but cached (see §2) and
  `findExistingSeasonFolder` receives the *localized* candidates.

### 2. Explicit catalog table (`media_catalog`)

```
library_key | season | processed_show_dir | processed_season_dir
           | library_show_dir | library_season_dir | extra_episodes
```

- Populated lazily: the first time any resolver locates a folder (or when
  move-to-processed/adopt/import create one) it writes the mapping.
- Reads go catalog-first (single indexed lookup, deterministic); the fuzzy
  scanners only run when a catalog row is missing, then backfill it.
- A `DELETE /maintenance/rebuild-catalog` (or startup) resyncs rows to disk and
  reports drifts — the audit replaces hand-running `library-audit`.
- This kills the "same-named show, different year" ambiguity,
  localised-vs-English title pairs, and the star-names that forced ambiguity
  everywhere else.

### 3. One-time processed normalization (maintenance tool)

Dry-run first, then apply, both idempotent inode-checked:

1. **Show dirs**: rename processed show folders to `Clean Title (Year)`.
   Clean title from `cleanFranchiseTitle` over stored request titles
   (prefer the *canonical* TMDB name after `fix-identity`), year from the
   `library_key`. No copy — `renameSync` only; EXDEV is fatal + loud.
2. **Season dirs**: rename any processed `Season 1`/`Sezon I`/`specials`
   folder to `Sxx` (parsing with the existing `parseSeasonNumber`).
   Structure-first folders stay untouched (already `Sxx`).
3. **DB rewrite, same pass**: rewrite the `PROCESSED_TV`-relative prefix of
   every `approval_history.processed_files` entry for renamed folders,
   verifying each rewritten path still resolves to the same inode as the
   pre-rename path (skip + report if not).
4. **Catalog**: after apply, upsert `media_catalog` from the final tree.

### 4. What deliberately does NOT change

- Library tree: zero renames. `resolveLibraryFolder` keeps preferring existing
  localized season folders; the mapping just becomes durable in `media_catalog`.
- `processed_files` semantics (relative JSON) — only the stored *values* are
  rewritten once. No schema change to approval_history.
- Inode reconcile logic (`import-library/native`, `adopt`, startup dedup) —
  they operate on inodes, unaffected by naming; the catalog only shortens their
  *discovery*.

## Breakage inventory (what a raw rename would hit today)

| Site | Why it breaks |
|---|---|
| `approval_history.processed_files` (write + read sites, ~25) | relative paths go stale → coverage/panels/reconcile see zero files |
| `coveredEpisodesForRequest` disk scan | `findSeasonFolder` misses a renamed show dir |
| `unnumberedFilesInSeasonFolder` / S00 pills | specials discovered by folder scan |
| `diskSeasonFolders` (structure-first seasons) | scans `PROCESSED_TV` show dirs for parsing |
| managed/native-franchise pills + episode grids | all folder-derived counts |
| `resolveLibraryFolder` / `findExistingSeasonFolder` | re-resolves library on every move |
| destroy `renameSync`, workspace keep, multi-version movies | path building, no catalog |

Exit criteria for each phase: `npm run type-check` + the deployed app shows the
same coverage counts as pre-migration for a sample of 3 franchises.

## Phases

- **P0 (audit, no writes)** — CLI/dry-run:
  `npx tsx scripts/stdcheck.ts --dry-run`: list proposed show/season renames,
  count affected `processed_files` rows, detect EXDEV/EACCES/EPERM risks, report
  catalog candidates, print the test-franchise before/after coverage delta.
- **P1 (plumbing)** — naming helpers + `media_catalog` table + catalog-first
  read path; fuzzy scanners reduced to catalog-repair; writes create catalog
  rows. Deployable state: nothing renamed yet, behaviour identical.
- **P2 (rename pass)** — `--apply` with inode-checked DB rewrite, per-show
  batch, re-runnable/idempotent, logs every rename + row rewrite. Contained
  breakage window: PBS-covered polling can keep running; reads before/after
  within a batch are tolerated because catalog is repaired lazily.
- **P3 (collapse)** — remove now-dead fuzz (or gate behind
  `CATALOG_ONLY=1`), delete dead code, update AGENTS/README. Verify cleanup
  tools, delete flows, and startup repairs still run with the catalog.

## Risks & rollback

- **Mid-pass crash**: `--apply` is logged per entry and invertible
  (`--rollback` replays the log with inode verification); startup unused-row
  cleanup is unchanged, nothing invalidates RCs.
- **Library-only shows** (media in library but not processed): unaffected —
  adoption already requires a download-origin inode; catalog records them as
  library-only.
- **Multi-version movies**: flat in processed, no renames, unaffected.
- **Seerr/manual requests mid-flight**: downloads land via `download/`
  folders, processed staging unchanged until their show is renamed; the batch
  runs while `POLL_INTERVAL_STATUS` is paused to avoid racing coverage writes.

## Open questions (needs user input)

1. Processed show dirs: keep release-flavoured stored titles, or prefer the
   canonical TMDB name (post-`fix-identity`)? Preferred: TMDB name — one
   identity per franchise everywhere.
2. Should `media_catalog` also capture the library folder mapping now, or defer
   until the rename pass proves itself? Preferred: capture in P1.
3. Tests: is a `npx tsx` CLI acceptable, or do we want these as HTTP
   maintenance endpoints gated behind a secret (`POST /maintenance/...`)?