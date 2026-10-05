# AGENTS.md — Development Guide

## Quick Start

```bash
npm install                  # Install backend deps
cd frontend && npm install   # Install frontend deps
cp .env.example .env         # Configure env vars
npm run dev                  # Backend on :3000
cd frontend && npm run dev   # Frontend on :5173 (proxies to :3000)
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Frontend   │────▶│   Backend    │────▶│  Prowlarr     │
│   (React)    │     │   (Express)  │     │  (search)     │
└─────────────┘     └──────┬───────┘     └───────────────┘
                           │
              ┌────────────┼───────────┬────────────┐
              ▼            ▼           ▼            ▼
         ┌─────────┐ ┌────────────┐ ┌─────────┐ ┌──────────┐
         │  TMDB   │ │   Seerr    │ │qBittorrent│ │ Jellyfin │
         │(metadata)│ │(requests) │ │(torrents)│ │ (library)│
         └─────────┘ └────────────┘ └─────────┘ └──────────┘
```

> **The deployed mode is fully arr-free.** Radarr/Sonarr appear throughout this
> doc as optional legacy: they boot only when `RADARR_URL`+`RADARR_API_KEY` /
> `SONARR_URL`+`SONARR_API_KEY` are both set. Requests originate in **Seerr**
> (synced into `media_requests`) or **TMDB Discover**; search is Prowlarr;
> grabs go straight to qBittorrent via magnet; COMPLETED is a manual
> move-to-library signal.

## ROADMAP — Processed ⇄ Library standardization (P0–P2)

**Next planned work block.** Goal: stop keying on folder name + filename; make
identity ride the file, then optionally normalize names. Written down so a fresh
session can start with P0 without re-deriving the design.

### Design decisions (agreed with user)

- **Identity-first, inode primary**: new `media_files` table keyed by
  `(dev, inode)` → `{library_key, season, episode_nums, role (numbered |
  unnumbered special | extra), release_name}`. Registered on every write path
  (move-to-processed, move-to-library, import-library/adopt, workspace
  Complete & Import — moves create NEW inodes so register there — and destroy's
  renameSync). Reads (coverage, pills, episode grids, processed panels) resolve
  by inode; `approval_history.processed_files` (PROCESSED_TV-relative JSON
  paths, ~25 read/write sites) **self-heals** on access via inode lookup when a
  stored path is missing (folder renamed).
- **Names are the BACKUP, not the source**: matching order = (dev,ino) →
  canonical-name (IDs embedded) → fuzzy title, so a file that was **copied**
  instead of hardlinked (doomed inode) still resolves by name. User explicitly
  wanted this fallback.
- **`/download` is completely isolated — the last line of defence.** Never
  write inside it: no xattrs, no renames, no metadata, no reorganization, ever
  (qBittorrent seeds from there forever). Identity is **DB-only** — the app
  never touches a download file beyond read-only `stat()`; even the `media_files`
  row for a download twin is written only because the processed hardlink shares
  the same inode. Existing flows that remove download content do so by design:
  destroy's `renameSync` moves it to `/Processed` only *after* the torrent is
  deleted from qBittorrent. No xattr mirror was ever added and one must not be.
- **Canonical naming (both trees, name-for-name so they track visually)** — user
  confirmed this convention (ID-anchored, Jellyfin-friendly):
  - Series show dir: `Title (YYYY) [tvdbid-####]`; movie: `Title (YYYY) [imdbid-tt####]`
    (IDs from TMDB `external_ids`; we already resolve the TMDB id).
  - Season dirs: `S00`/`S01`/… (`parseSeasonNumber` already accepts
    `Season N`/`Sezon N` variants too).
  - S00 movies/specials file: `Title (YYYY) [imdbid-tt####] - [PL] [Src-1080p] ... [GROUP].mkv`
    (user's example: `Mister Blots Academy (1984) [imdbid-tt0086863] - [PL]
    [Bluray-1080p][AC3 2.0][x264]-DENDA`). Numbered episodes keep
    `Show - SxxExx - Name …` style. Tags (language/source/audio/video/group) are
    already parsed by scoring.
  - `/download` keeps original release names forever; the original name is also
    preserved in `release_candidates.title`.
- **Naming configurable in Settings** (like Sonarr/Radarr name-format): a
  template with tokens stored in the `settings` table, defaults = above, plus a
  `naming.vendors` list (comma-separated, default `Bajeczki24,FGT`) for platform
  watermarks. A vendor arrives as a **bare trailing word** — no hyphen, no
  bracket — which is why it was silently dropped: the group rule only matches a
  `-WORD` tail and the tokenizer discards unknown words. It's matched
  case-insensitively anywhere in the name and re-attached **at the very end**,
  where those rips put it and where it round-trips. A `-Vendor` tail is peeled
  off **before** the group rule runs, otherwise the canonical form (`-Vendor`,
  which matches `-WORD`) would be re-read as a release group on the next pass and
  a rename would not be idempotent. Recognition is case-insensitive but the
  NAME's own spelling is rendered, so the mixed-case rule that protects groups
  protects vendors. Being name-only, a vendor joins source/group/edition in
  `inheritReleaseFacts`. `{Vendor}` is a documented token, but a template stored
  before it existed still gets the vendor appended — otherwise enabling the list
  would silently do nothing on any deployment that already saved a template.
  Clearing the list persists as **empty** rather than snapping back to the
  default, so "attach none" is expressible.
- **What sits AFTER the group hides it** — both tail rules anchor at
  end-of-string. A ` (1)` collision suffix (bare parenthesised digits only, so
  `(2015)` and an edition in parentheses are safe) is peeled first. A trailing
  **language/dub word** (` - polish`, `-polish`) is never peeled blindly, because
  it is real evidence: it is consumed *only* when removing it actually uncovers a
  group, and is then applied as the language it is; otherwise it stays for the
  tokenizer. That also stops `-GRP-polish` being read as a group named "polish".
- **`Atmos` rides a CARRIER, and the carrier is named in the same bracket.** It is a
  mixing format, not a codec, and ffprobe cannot see it at all (it lives in stream
  metadata), so the title is the only evidence. Two carriers are real: **TrueHD**
  (disc) and **E-AC3** (streaming — Netflix/Disney+/Max). A bare `Atmos` may only
  claim a codec named in the *same* bracket, which makes `[EAC3 Atmos 5.1]`
  round-trip as itself. Matching any family instead attached it to whichever entry
  sat first, so Soul's DTS track claimed it and rendered a non-existent
  `[DTS-HD MA Atmos]` beside a correct `[TrueHD Atmos 7.1]`. A bare `Atmos` in its
  OWN bracket may still fall back across to TrueHD (the one disc carrier), and with
  no carrier at all it stays standalone. Because the loose dotted tail has no
  bracket to scope it, each loose token is its own group — otherwise
  `DTS-HD.MA.TrueHD.7.1.Atmos` let the bare `Atmos` reach back to the DTS. And a
  bracketed `[Atmos]` is read *before* the dotted tail that may hold its carrier,
  so the TrueHD fallback is re-run once every token is parsed.
- **A channel number must land on a CODEC.** `Atmos` is not a layout, so letting
  `5.1` append to a standalone `[Atmos]` rendered a meaningless `[Atmos 5.1]` —
  which is exactly what a name saying `[EAC3 Atmos 5.1]` produced. A bare channel
  number attaches to the nearest entry naming a real codec family, or is dropped
  when the name states none.
- **A probed codec does not inherit an Atmos from a DIFFERENT family's track.** The
  flag describes the track it was written beside, so the Polish Soul dub (measured
  AAC 2.0, named after a TrueHD Atmos remux) rendered `[AAC Atmos 2.0]`. The flag
  is read off the *same-family* title entry only.
- **One stream cannot have two video codecs.** Only the first video stream is
  probed, so a title codec from a *different* family is dropped rather than kept
  beside the probed one (a Polish mp4 inherited `[HEVC]` from the remux it was
  dubbed from, printing `[x264][HEVC]`). Within a family the title still refines
  the probe (`DivX` over generic `mpeg4`), and same-family labels collapse to
  one. `mediaProbe` reports `video.streamCount` so a genuinely two-stream file —
  where the title's second codec is the only evidence of it — keeps both; cover
  art (`mjpeg` `attached_pic`) is excluded from that count.
- **The probe outranks the title, and `source` is refutable.** Two long-standing
  rules said "probe wins for codec/resolution/channels, title keeps source", but
  the code only consulted the probe when the title was *silent* — Soul's Polish
  dub was named after the 43.6 GB remux and kept `[Remux-2160p]` at 1.9 GB /
  measured 720p. Fixed in two parts:
  - **Resolution**: the measured frame now **overrides** a title claim
    (`probeResolution(v?.width, v?.height) ?? t.resolution`). A measurement is
    ground truth; a name is not. No probe ⇒ title still used, since then it's all we have.
  - **The tier is read from WIDTH, with height only able to raise it.** Height
    alone cannot classify: a 2.40:1 scope film is letterboxed inside a 1080p or
    2160p transfer, so the cropped height lands a full tier or two low, and the
    old height-only ladder called 1920×800 a `720p` — ranking **1.54 megapixels
    below 1280×720's 0.92** — and a 3840×800 4K scope remux a `480p`. A name
    states the release's resolution *class*, not its pixel count. Each dimension
    is classified independently (`resolutionFromWidth` /
    `resolutionFromHeight`) and **the higher estimate wins** (`RES_RANK`): a
    cropped height may understate the tier, but the width still states it, and a
    format only height can identify (2560×1440) is not lost to a width ladder
    with no 1440p band. Reference outcomes: 1920×800 → `1080p`, 3840×1610 →
    `2160p`, 1280×532 → `720p`, 2560×1440 → `1440p`, 720×576 → `480p`. Missing
    width falls back to height, so nothing regresses for streams that report one.
  - **`Remux` is a claim about provenance, and provenance has consequences**: a
    remux is a bit-exact copy of a disc's main track, so it is never below 1080 and
    its main audio is always a disc codec. `sourceRefutedByProbe` drops the label
    when the stream's measured **tier** is under 1080, or its primary audio is one
    of `NON_DISC_AUDIO` (`aac|mp3|opus|vorbis|flac|alac|amr|wmav`). It is **dropped,
    not replaced** — deriving Bluray/WEBDL from a contradiction would be inventing
    provenance. Deliberately scoped to `Remux` only: `Bluray` alone survives a
    720p transcode (720p BDs exist, and discs may carry an AAC secondary), and
    `AC3`/`DD` is mandatory on Blu-ray so it refutes nothing. The tier test (not a
    raw `height < 1080`) matters here: a letterboxed 1920×800 or 3840×800 remux is
    exactly the kind of file the claim is about, and raw height discarded it.
  - The check runs **again after `inheritReleaseFacts`**, because a `Remux` arriving
    from a same-inode twin lands after the reconciliation inside
    `assembleCanonicalTags` and would otherwise re-label a transcode. The probe is
    therefore threaded through `inheritReleaseFacts(target, sibling, vendors, probe)`
    at its one call site.
- **"Fix Names" UI (Layer 2, cosmetic)** — user-confirmed shape: a modal listing
  each processed file + its linked library twin (same inode, shown only if
  already in the library) + lone processed files; per-row checkbox to apply the
  canonical name; old→new preview; renames inode-verified (hardlinked entries at
  different paths each renamed independently, inode unchanged). Manual `mv`/
  renames are equally safe after P0 (reads recover by inode). The app must never
  depend on names; this tool only tidies.

### Build order

- **P0 — identity layer (DONE, pending VM verification)**: `media_files` table +
  registration on all write paths + inode-first coverage/pills/grids/panels reads
  (`coveredEpisodesForRequest`, `unnumberedFilesInSeasonFolder`, episode-grid
  extras) + `processed_files` self-heal on access (`healProcessedFilesForRequest`
  in `src/routes/requests.ts`, wired into `GET /:id/processed` and every coverage
  read). No renames performed. Verify with the deployed coverage counts unchanged
  for a sample franchise before/after. Optional leftover: `user.nad.identity`
  xattr mirror (best-effort, skip `download/`). — **superseded: xattr was dropped
  on user request; identity is DB-only.**
- **P1 — canonical writes (DONE, verified on VM) + P1b probing (DONE, verified on VM)**: naming kernel
  `src/config/naming.ts` (token templates, tag/group extraction, canonical dir +
  file builders, collision-safe `uniqueDestPath`) + tmdb external-id resolution
  (`resolveExternalIds` in `src/services/tmdb.ts`, `tmdb_external_ids` cache,
  offline fallback parses ids from an already-canonical target folder) + naming
  templates stored in the `settings` table and editable at
  `GET`/`PUT /api/settings/naming` (Settings → Naming Templates). Applied to NEW
  files only: single-file `move-to-processed` and native (arr-free)
  `move-to-library` (per-file + torrent paths) name files per template
  (`{Title} ({Year}) [imdbid-tt{ImdbId}] - {Tags}{Group}`,
  `{Title} - S{Season:02}E{Episode:02} - {EpisodeTitle} {Tags}{Group}`);
  `{EpisodeTitle}` fills from `tmdb_season_cache` (offline). **P1b: playback
  tags are probed from the source file with ffprobe
  (`src/services/mediaProbe.ts` → `assembleCanonicalTags`) before title
   inference — resolution TIER from the measured frame (width-primary, so a
   letterbox crop cannot lower it), video codec + bit depth, HDR
  flags (DV/HDR10+/HDR10/HLG from `side_data_list`/`color_transfer`), primary
audio codec + channel layout (`Atmos` still only from the title, and only from
    the same-family entry). Probe wins for codec/resolution/channels; title keeps
    source/language/group. Multi-word brackets (`[DV HDR10+]`,
    `[TrueHD Atmos 7.1]`, `[EAC3 Atmos 5.1]`, `[AC3 2.0]`) are split and merged, channel numbers are
kept intact (`DD+5.1`). A bracketed `[Unknown]`/`[Group]` is a "not stated"
    placeholder and is dropped as **neither a tag nor a group** (`PLACEHOLDER_WORDS`) — an earlier
    version promoted it to the group and wrote `-Unknown` to disk, where it then
    re-parsed as a group on every pass and reached the same-inode twin, so the
    rename could never converge.** One tag per fact: the HDR bracket prints `[DV HDR10]` or
   `[HDR10+]`, never a redundant member — a bare `HDR` is the umbrella word and
   is dropped once any specific flag is present (the title claiming `HDR` next
   to a probed `HDR10` used to render `[HDR10 HDR]`). HDR10+ is read from
   `HDR10P`/`HDR10Pr`/`HDR10Plus`/`HDR10+`, and within the HDR10 family the TITLE
   refines the probe rather than fighting it: HDR10+ is dynamic metadata layered
   on the ST 2086 base, and ffprobe reports only that base unless it survived
   muxing as ST 2094 side data, so a name saying `HDR10P` is the better evidence
   where the probe saw plain `HDR10`. Across transfer functions it IS a conflict
   and the probe wins: a title claiming `DV`/`HDR10+` on a stream measured as
   `HLG` is dropped instead of printing `[DV HDR10+ HLG]`. `WCG`/`BT2020` is a
   gamut rather than a transfer, so it coexists with everything. Language is the exception to "title keeps language": a Polish
   dub says nothing in its file NAME, so the stream tag outranks it — but ONLY
   while exactly one foreign language sits beside English (`pol + eng` → `[PL]`).
   Two or more foreign languages is a **multi** release: no single one
   identifies it, so the tag is the enumeration the streams actually name
   (`[EN+FR+ES+DE+JA+KO+ZH+PL]`, distinct codes in track order — not
   whichever the encoder listed first; the Lion King 8-track remux was
   `[FRA]` for that reason). A title that already enumerates them is kept
   (`parseReleaseTags` reads `+` lists, guarded so `x264+x265` is never one);
   a title saying only `MULTI`, or naming one language that eight tracks
   contradict, defers to the probe. Bare `[MULTI]` remains for a Matroska `mul`
   track, whose sub-languages are unknown. ISO-639 codes are folded to the
   same two-letter alphabet `LANG_TAGS` uses, so `[FRE]` normalises to `[FR]`
   and canonical names round-trip. **The probe must collect every audio track**:
   capping it made an 8-language remux look like `eng + one foreign` (a French
   dub) simply because only the first 4 of 12 tracks were read. Languages named
   only in a track's free-text title (`7.1 fr`, `pl ac3 6ch 48 khz`) count too,
   via `PROBE_LANG_NAMES` (kept out of `LANG_ALIASES`, which the file-name
   parser shares and where "English" is a title, not a tag). Folders keep their
   structure; `move-to-library` dirs,
  workspace outputs, adopt and library-import are NOT renamed (P2's Fix Names
  owns existing trees). Native requests only — arr-linked moves still defer
  naming to Radarr/Sonarr. `uniqueDestPath` idempotently reuses same-inode
  destinations and suffixes `-2/-3` different ones so multiple versions of a
  movie/special coexist. Naming stays cosmetic: reads remain inode-keyed and
  request.library_key-driven.
- **P2 — standardize tool (DONE, committed `0b6a48c`, pending VM verification)**: "Fix Names"
  modal + HTTP surface (`POST /:id/fix-names/preview` + `POST /:id/fix-names/apply` in
  `src/routes/requests.ts`, helpers `buildFixNameGroups`/`proposeCanonicalName`/
  `applyFixNameRename` after `canonicalFileBase`). Preview returns grouped rows —
  each processed file (matched via AH `processed_files`/identity/title fallback) plus its
  library twin by inode (`nativeMovieLibraryFolders`/`resolveLibraryFolder`); proposal
  reuses the naming kernel + `assembleCanonicalTags`, one ffprobe per `(dev,ino)` (pool of
  4). Names are recomputed server-side on apply (client sends only paths), and
  apply snapshots every proposal from ONE `buildFixNameGroups` run *before* the
  first rename — so preview and apply are the same computation and a batch
  cannot half-apply (recomputing per file meant the first rename moved the
  sibling out from under the rest). **Each row is named from its own name, then
  inherits the gaps from its same-inode twin** (`inheritReleaseFacts`): source,
  group and edition can only come from a name, and a twin an arr had named
  without them would otherwise drop them silently and rename a release group out
  of existence. Inheritance only FILLS — a name that states its own
  source/group/edition/Atmos keeps it, and nothing ffprobe measures is ever
  inherited. Only EDITION labels cross over, not misc generally (`[Dual Audio]`
  belongs to the name that said it). renames are
  collision-safe (`uniqueDestPath`), inode-verified (`renameSync` + pre/post `stat`),
  refresh `media_files.release_name` + AH `processed_files` basenames. **Folder renames
  added alongside (files first, then dirs deepest-first)**: processed-tree (show/season
  dirs under `PROCESSED_TV`, movie dirs under `PROCESSED_MOVIES`) AND library-tree (same
  shapes under `MEDIA_TV`/`MEDIA_MOVIES` — series via `resolveLibraryShowFolder` + the
  request's season dir, movies via `nativeMovieLibraryFolders`, never the roots), candidates
  discovered on the same scan that matched the files; each folder must be owned outright
  (`folderOwnedExclusively` — no registered file inside maps to a DIFFERENT `library_key`),
  canonical dir recomputed server-side from `canonicalSeriesDir`/`canonicalMovieDir`/
  `canonicalSeasonDir`, `isDirectChildOfRoot` position checks (library-aware),
  destination collisions abort
  (never merge), `renameSync` + post-stat verification, and `rewriteProcessedFilesPrefix`
  relocates AH `processed_files` prefixes for ALL requests living under the moved PROCESSED
  folder (library folders have no bookkeeping — Jellyfin rescans)
  (multi-season franchises share the show dir). File-level too; library files remain optional
  (user-selected); movie/series/season NEW dir creation deferred.
- Verify with `npm run type-check` + deployed coverage counts unchanged for a
  sample franchise before/after.

### P2b — explicit IMDb id veto (cross-franchise same-title movies)

Mufasa (2024) and The Lion King (1994) are the movie-space version of the
DuckTales 1987/2017 problem: movies live **flat** in `PROCESSED_MOVIES`, so
`titlesMatch` word overlap happily matches them to each other. Because canonical
names embed `[imdbid-ttNNNNNNN]`, that id is deterministic and outranks every
fuzzy signal:

- `nameImdbId(name)` — pull an embedded id out of a name (`[imdbid-tt0110357]`
  or a bare `tt0110357`). `requestImdbId(db, request)` — the request's own id,
  offline: `tmdb_external_ids` cache → id-anchored `library_key`
  (`movie:tt0110357:1994`) → id in the stored title →
  `requestImdbIdFromProcessedNames` (last resort, see below).
  `imdbIdOwnerKey(db, id)` — the key that **owns** an id (cache, then any
  id-anchored `library_key`).
- **A canonical FILE NAME is the final offline id source.** A slug-keyed row
  whose title is localized can find no id in its key or its title, and losing
  the id is not cosmetic: the folder veto, the canonical name and "in library"
  all key off it. `requestImdbIdFromProcessedNames` reads the ids embedded in
  the request's own accepted file names and returns one **only if they all
  agree** — conflicting ids mean attribution was wrong, so it stays inert rather
  than picking one. This is also the heal for a row whose cache was lost.
- `nameContradictsRequest(...)` — a name pinning a DIFFERENT film is rejected
  **before** identity, `approval_history` names and title fallback. **Symmetric
  by design**: comparing ids only when *both* sides are known made the veto inert
  whenever the request had no resolved id (cold cache, TMDB down, slug-only
  `library_key`) — the file then vanished from one card while still sitting in
  the other's. So the file's id alone is enough: resolve it to its owner and
  compare keys. Every signal unknown ⇒ false, so it can only exclude, never
  admit (raw release names keep working as before).
- **Year fallback** for files that predate canonical naming and carry no id
  (`The Lion King 1994 MULTI REMUX …`): a name whose year disagrees with the
  request's authoritative year (`(YYYY)` in the title, else the `:YYYY` tail of
  `library_key`) contradicts, but only when it shares ≥2 significant title words.
  Movies only — episode files carry no film year, so series is untouched. A year
  inside brackets (`[2019 HDR DV]`) is not read as the film's year.
- Applied in `processedFileMatchesRequest`, `GET /:id/processed`,
  `backfillRequestIdentity` (movie branch), `POST /:id/processed/scan` (picker
  no longer offers it), `POST /:id/processed/associate` (**409** with the
  rejected names), `findBestRequestForDownload`, scan-downloads native match,
  remove-from-library size-based twin lookup, and `nativeMovieLibraryFolders`
  (library folder resolution skips foreign-id dirs).
- `autodetectIdentity` resolves the embedded id through `imdbIdOwnerKey` first
  (cache, then id-anchored key), so adopt/import cannot claim a foreign film
  either — and works with TMDB unset.
- **Repair**: `healProcessedFilesForRequest` drops forged
  `approval_history.processed_files` entries and re-attributes the inode;
  startup cleanup in `db/index.ts` does the same in bulk, before the read-time
  heal (`processedFileContradicts`). When the file's id is **unattributable**
  (cold cache + slug-only key) the wrong `media_files` row is **deleted** rather
  than left in place or guessed: identity outranks every signal, so a disproven
  row is worse than no row, and the name/id fallback owns the file until TMDB can
  attribute it. Files are never touched on disk — only bookkeeping.
  `idx_tmdb_external_ids_imdb` backs the id→owner lookups.
- **Known limit**: the flat `PROCESSED_MOVIES` layout is the root cause — every
  movie in one directory, so correctness depends on these signals rather than on
  the filesystem. Per-movie subfolders (`filmy/<Title> (Year) [imdbid-tt…]/`)
  would make the folder itself the disambiguator; deferred as P3 (a migration of
  existing files plus a change to every flat-dir scan).

## Folder Structure

```
/media/Torrents/
├── Download/              # IMMUTABLE — qBittorrent seeds from here forever
│   ├── Filmy/             #   Movies download destination
│   └── Serialy/           #   TV shows download destination
│
├── Workspace/             # EPHEMERAL — scratch space for processing jobs
│   └── {request_id}-{sanitized_name}/
│       ├── inputs/        #   Hardlinks from Download (read-only source)
│       └── output/        #   Processed files (mkvmerge/ffmpeg output)
│
├── Processed/             # STAGING — ready for Sonarr/Radarr import
│   ├── Filmy/             #   Processed movies awaiting library import
│   └── Serialy/           #   Processed TV shows awaiting library import
│
└── Trackers/              # PER-TORRENT METADATA — exported on destroy
    └── {info_hash}/
        ├── *.torrent      #   Exported .torrent file
        └── trackers.json  #   Tracker list

/media/
├── filmy/                 # LIBRARY — Radarr-managed movie library
└── serialy/               # LIBRARY — Sonarr-managed TV library
```

### Data Flow

`/Download` is the **primary source of truth** and is read-only: qBittorrent seeds from it
forever, so nothing may modify or delete files there. `/Processed` is the **modifiable
second source of truth** — the working set the app owns and edits. `/Library` is the
presentation layer, normally hardlinked from `/Processed`.

Identity is the **inode**, not the path or filename. The same file can appear at
several paths (download release name, processed name, library name) and stays one file
until something is actually copied or moved. This is why reconciliation must compare
`stat().ino` and never match on title — library names are localized (e.g. `Xiaolin
Showdown`, `Tajemnica Sagali`) while download/processed names are English release names.

```
qBittorrent
     │
     ▼
/Download (PRIMARY source, READ-ONLY while seeding)
     │
     ├────── [no processing needed] ────── hardlink to /Processed ──┐
     │                                                             │
     └────── [processing needed] ── hardlink to /Workspace ────┐    │
              │                                                │    │
              ▼                                                │    │
         /Workspace/{id}-{name}/                               │    │
              inputs/ → mkvmerge/ffmpeg → output/             │    │
              │                                                │    │
              └──── delete inputs, MOVE output ───────────────┘    │
                    (new files, different inodes) ── MOVES to /Processed
                                                                 │
                                          /Processed (SECOND source, modifiable)
                                             │        │
                                             │        └── may also be hardlinked
                                             │            from an existing /Library file
                                             │            (see Adoption)
                                             ▼
                                          /Library (hardlinked from /Processed)
```

### Adoption (Library → Processed)
Libraries imported before the app existed can hold files that never made it into
`/Processed`. Adoption hardlinks those back into `/Processed` so the tree is
reconcilable, without touching the library, the download, or any data.

- `GET /api/requests/library-audit` — read-only report: per-show inode attribution,
  which library files are missing from processed, and which are recoverable from download
- `POST /api/requests/adopt-into-processed` — `planAdoption()` + `executeAdoption()`
  in `src/services/adopt.ts`. **Dry run unless `apply: true`.**
- Only creates new links under `/Processed`. Never modifies library/processed/download
  contents, never overwrites, never copies.
- **No copy fallback on `EXDEV`**, unlike `processor.ts:hardlinkFile` — a copy would
  triple the disk usage of exactly the largest files, so it is reported as an error
- A destination that already exists with a **different inode is a collision**: reported,
  never overwritten. Same inode is a no-op (idempotent).
- `requireDownloadOrigin` defaults true, so only files traceable to a download inode
  are adopted. Pass `includeUnbacked: true` to include hand-placed library files.
- Series land in `/Processed/serialy/<show title> (<year>)/Sxx/<basename>`, with
  `S00` for specials. Movies are flat in `/Processed/filmy` under the library basename.
  Multiple versions per movie are expected and are not deduplicated.

### Manual Preprocessing Flow (TorrentPanel UI)
```
Download (100% complete)
     │
     ├── [checkbox OFF] "Move to Processed"
     │     → hardlink Download/* to /Processed/
     │     → file appears in processed panel as independent
     │     → "To Library" button sends to Radarr/Sonarr
     │
     └── [checkbox ON] "To Workspace" → opens WorkspacePickerModal
           → select existing workspace or create new (name, notes, scripts)
           → hardlink Download/* to workspace/inputs/
           → user processes files manually (mux/merge)
           → "Complete & Import" deletes inputs, MOVEs outputs to /Processed/
           → file appears in processed panel as independent (different inode)
           → "To Library" button sends to Radarr/Sonarr
```

### Re-processing Flow
```
/Processed file (independent)
     │
     └── "To Workspace" → opens WorkspacePickerModal
           → hardlink /Processed/* to workspace/inputs/
           → user re-processes (different mux, audio tracks, etc.)
           → "Complete & Import" MOVEs outputs to /Processed/
           → file replaced as independent
```

### Key Principles
- **Download is immutable**: never modify, never delete while seeding
- **Workspace is ephemeral**: cleaned up after each processing job
- **Processed is the modifiable working set**: second source of truth the app owns; may hold hardlinks back-linked from the library (Adoption)
- **Workspace outputs are MOVED** (renameSync) to Processed — not hardlinked — different inodes
- **No-preprocess hardlinks** are treated as independent even though they share inodes with Download
- **Library managed by Sonarr/Radarr**: they handle renaming and organization

## Search Flow

### Single Request Search (POST /:id/search)
1. User clicks "Search" or types custom term
2. Backend `POST /:id/search` endpoint
3. **If PROWLARR_API_KEY is set**: queries Prowlarr directly (`GET /api/v1/search?query=...&categories=2000|5000`)
4. **Fallback**: queries Sonarr/Radarr `/api/v3/release` (ignores custom terms)
5. Results mapped to `RadarrSearchResult` format, scored, stored in `release_candidates`
6. SSE streams progress to frontend

### Franchise Search All (POST /managed/:sonarrId/search-all)
1. User types search term in franchise overview, clicks "Search All Seasons"
2. Backend queries Prowlarr once per season (concurrency 3)
3. **Season filter**: Prowlarr results parsed with `/\bS(\d{1,2})(?:E\d|\b)/` — only results matching the target season are inserted
4. SSE streams per-season `found` events with live release counts
5. Skip guard: 5-minute cooldown via `last_searched_at` column

## Approval Flow

1. User clicks "Approve" on a release
2. Backend `POST /:id/approve` endpoint
3. Creates `approval_history` record
4. **If release has Prowlarr infoHash (40-char)**: grabs via qBittorrent directly using magnet URL
5. **Otherwise**: grabs via Radarr/Sonarr `/api/v3/release` (their native flow)
6. Detects new torrent in qBittorrent, updates `release_candidates.torrent_hash`
7. Status transitions to DOWNLOADING
## Unmatched Flow (Scan Downloads)

### Automatic Match (POST /scan-downloads)
1. Button "Scan Downloads" in Dashboard toolbar
2. Backend scans ALL qBittorrent torrents
3. For each torrent, tries `titlesMatch()` against existing Sonarr/Radarr series
4. **Match found**: creates/reuses `media_requests`, creates RC + approval_history, status DOWNLOADING
5. **Multi-season packs**: scans `content_path` for season subdirectories → one request per season
6. **No match**: inserts into `unmatched_torrents` table with pre-fetched candidates (10+ per lookup)
7. Results displayed in modal; unmatched entries shown in inline panel below

### Manual Match (Inline Panel)
1. `<UnmatchedTorrentsPanel />` renders below managed cards if unmatched entries exist
2. Each entry shows torrent name, type badge, size, candidate buttons
3. **Click a candidate**: `POST /unmatched/:id/match` — creates RC + request via Sonarr/Radarr lookup
4. **Skip**: `POST /unmatched/:id/skip` — marks as skipped, removed from panel
5. Matched entries immediately appear as managed cards with DOWNLOADING status

### Arr-less request creation (Phase B)
- **`POST /unmatched/:id/match` falls back to native when arrs are down/unconfigured**: a `radarrProfileId || radarrRootPath` (or sonarr equivalent) missing from the profile fetch, or any throw inside the arr path, redirects to a native branch. The pick is resolved on TMDB via `searchTMDB()` → `library_key` (`movie:<slug>:<year>` / `series:<slug>:<year>`, slug from the **resolved TMDB name**, matching fix-identity). Creates/updates `media_requests` (status DOWNLOADING), inserts RC + approval_history, marks `unmatched_torrents` matched. Response carries `native: true`.
- **Scan-downloads matches existing native requests** (Step 1b): when no Radarr/Sonarr match exists, torrents whose title matches a `library_key` row are attached (existing or newly-created per-season rows under the same key) with a status of DOWNLOADING — no arr call needed.
- **TMDB candidate pre-fill**: when profiles are unavailable (`!radarrProfileId` / `!sonarrProfileId`) and no native match, scan-downloads fills `candidate_results` straight from `searchTMDB(cleanFranchiseTitle(lookupTitle), …)` so the unmatched panel still offers pick buttons. Candidate `id` is the TMDB id.
- `searchTMDB(query, mediaType)` lives in `src/services/tmdb.ts`; returns `{id,title,year,overview}` capped at 10. Requires `TMDB_API_KEY`; returns `[]` when unset.

### Disk COMPLETED (Phase C)
- `POST /:id/move-to-library` promotes a DOWNLOADING/SEEDING request to COMPLETED when its content is placed into the library (native AND arr-linked, since the "To Library" action is the user's explicit completion signal). The three "already exists" short-circuits (same path, inode match, BDMV inode) also mark COMPLETED — heals requests whose files reached the library through an earlier flow.
- Per-file moves (processed panel `fileName`) append the moved basename to the request's `release_id IS NULL` approval_history `processed_files`.
- `markCompleted()` helper is scoped to the move-to-library route; guard is `status IN ('DOWNLOADING','SEEDING')`. SEARCHING/APPROVED/REJECTED/DISMISSED are never touched.

### TMDB Discovery (Phase D)
- **`DiscoverModal`** (frontend "Discover" button in the Dashboard toolbar) searches TMDB and turns a pick into a native request — the arr-free way to request new media when there's no Seerr/Overseerr.
- `GET /api/requests/discover?q=` — runs `searchTMDB(query, "movie")` + `searchTMDB(query, "series")` in parallel, returns combined `{type,id,title,year,overview,poster}`.
- `GET /api/requests/discover/tv/:tmdbId/seasons` — `fetchTMDBTVSeasons()` from `/tv/{id}` (filters out S00 grip rows, `season_number > 0`).
- `POST /api/requests/discover/request` `{type, tmdbId, title, year, season?}` — builds `movie:<slug>:<year>` / `series:<slug>:<year>` via `slugForKeyTitle(cleanFranchiseTitle(title))`, inserts a native `media_requests` row with `status='NEW'` (movie) or key+season (series, default S01). **Idempotent**: returns existing `request_id` with `existed: true` when the same key (movie) or key+season (series) is already tracked. Frontend then navigates to `/requests/:id` (RequestDetail) where the existing `POST /:id/search` (Prowlarr, already arr-free) takes over.
- `searchTMDB` now also returns `poster` (`poster_path`, used for thumbnails; frontend builds `https://image.tmdb.org/t/p/w92{poster}`).

### Seerr Sync (arr-free request portal)
- Seerr (Upstream of Jellyseerr, port 5055) runs with **zero Sonarr/Radarr** and yet can still create requests; it also has **no webhook event for deleting a request**, so the app uses a periodic **API reconcile** instead of webhooks.
- `src/services/seerr.ts`: `fetchSeerrRequests()` paginates `GET /api/v1/request` (X-Api-Key header), `syncSeerr(db)` upserts each live request into `media_requests` as a native row — identity resolved via `fetchTMDBById()` (title/year from tmdbId) then `library_key = movie:<slug>:<year>` / `series:<slug>:<year>` (shares `cleanFranchiseTitle`/`slugForKeyTitle` exports from `requests.ts`), status `NEW`, `seerr_request_id` stored. `type` comes from `request.type` (`movie`/`tv`), the user from `requestedBy.jellyfinUsername`/`displayName`. **One Seerr request = one season**: seasons live in `request.seasons[]`, so create a row per season (never collapse onto S01). Already-tracked rows are backfilled with `seerr_request_id` and get `requested_by` refreshed when it held the placeholder "Seerr".
- **Seerr status treatment**: DECLINED/FAILED (status 3/4 or string) are inactive — not created, and removed like deletions. PENDING and APPROVED are active.
- **Seerr availability is NOT used to complete rows**: Seerr's Jellyfin scan sees the whole library, but releases often need the app's preprocessing before they belong there — so `media.status`/`seasons[].status` availability is ignored and COMPLETED stays a manual "move to library" signal for Seerr-sourced rows just like manual ones.
- **Deletion reconcile**: rows with a `seerr_request_id` missing from Seerr's list are deleted **only when content-less** (no torrent RC, no processed files, status not DOWNLOADING/SEEDING/COMPLETED/AWAITING_APPROVAL/APPROVED). Anything with content is kept (`contentKept`) — a Seerr-side delete never destroys downloaded/processed/library data.
- Wired in `server.ts`: `POST /api/requests/seerr/sync` manual trigger (Dashboard calls it on mount via `syncSeerr()` in `api.ts`) + a background `setInterval` poll (`POLL_INTERVAL_SEERR`, default 60s) guarded on `SEERR_URL && SEERR_API_KEY`. `isSeerrConfigured()` keeps it a no-op when unset.

### Startup Cleanup
- Startup iterates all RCs with torrent hashes
- **Skips title check** for RCs where request has `sonarr_id`/`radarr_id` (ID link trusted)
- Uses `titlesMatch()` for remaining unlinked RCs
- Season check uses `\bS{req_season}\b` to handle multi-season packs
- Removes RCs where torrent is gone from qBittorrent



### Layer 1 — Franchise Overview (`/franchise/:sonarrId`)
- Shows all seasons as clickable rows with colored filled/missing badges (e.g. `12/24` green, `8 missing` red)
- Expandable episode grid: Sonarr episode list with titles, FILLED/MISSED badges, quality tags, per-episode Search button
- Search term input (default: franchise title, editable) — custom queries go to Prowlarr
- "Search All Seasons" button: fires background SSE search-all, navigates to first season's SeasonDetail
- Per-season Search button in header: navigates to SeasonDetail with season-specific auto-search
- Click a season → Layer 2

### Layer 2 — Season Detail (SeasonDetail component)
- Full release table/list with toggle (table default, card alternative)
- Score breakdown (quality, CF, size, rank) with expandable details
- Episode filter and sort controls (score, size, seeders)
- Search mode toggle (Season pack | Individual episodes)
- Auto-triggers search on mount when navigated with `initialSearch`
- Approve → grab via magnet or Sonarr/Radarr
- Torrent panel: progress bar, stats grid, source/library paths
- Preprocessing checkbox + "Move to Processed" / "Move to Workspace" button
- Move to Library (hardlink) / Process (remux/repack) / Remove from Library

## Processing Pipeline

### Workspace Naming
- Folder: `{request_id}-{sanitized_title}` (e.g. `42-LEGO.Ninjago.Dragons.Rising.S02`)
- Subdirs: `inputs/` (hardlinks from Download) and `output/` (processed files)
- Cleaned up automatically after each processing job

### Hardlink Processing (POST /:id/process)
1. Gets content path from qBittorrent
2. Creates workspace folder: `{PROCESSING_WORKSPACE}/{request_id}-{name}/`
3. Hardlinks source files to `workspace/inputs/`
4. **mkvmerge**: strip/keep audio tracks, remove subtitles
5. **ffmpeg**: audio codec conversion (fallback)
6. Output files written to `workspace/output/`
7. Hardlinks output to Processed folder
8. Cleans up workspace

### Move to Processed (POST /:id/move-to-processed)
1. Gets content path from qBittorrent
2. Hardlinks files from Download to Processed folder
3. Processed files await Sonarr/Radarr import to Library

### Move to Workspace (POST /:id/move-to-workspace)
1. Gets content path from qBittorrent
2. Creates workspace: `{PROCESSING_WORKSPACE}/{request_id}-{sanitized_title}/inputs/` and `output/`
3. Hardlinks files from Download to workspace `inputs/`
4. User manually processes files (mux/merge) in workspace
5. Output can be hardlinked to Processed folder when ready

### Move to Library (POST /:id/move-to-library)
1. Hardlinks files from Processed folder to Sonarr/Radarr library path
2. Falls back to copy on cross-device (EXDEV)
3. Checks existing files before creating links

## Torrent Import (POST /:id/import)

1. User pastes magnet link OR uploads `.torrent` file + optional bypassApproval toggle
2. Backend adds to qBittorrent using `toQBittorrentPath()` for save path
3. Creates `release_candidate` with magnet/URL, status NEW, `torrent_hash = ''`
4. If `bypassApproval=true`: creates `approval_history` + sets status AWAITING_APPROVAL immediately
5. Polls qBittorrent up to 30s (1s intervals) waiting for torrent hash to appear
6. When detected: updates RC hash, and if bypassed, calls `approveRelease()` to grab + transition to DOWNLOADING
7. Frontend auto-closes modal and refreshes data

## Per-Torrent Destroy (POST /:id/destroy/:releaseId)

1. User clicks "Destroy" on TorrentPanel → opens modal explaining options
2. Modal shows: release title, "Delete downloaded files from disk?" checkbox, "Remove from qBittorrent?" checkbox
3. Backend: exports `.torrent` + `trackers.json` to `/media/Torrents/Trackers/{hash}/` (keeps metadata)
4. If remove from qBittorrent: calls `deleteTorrent(hash, deleteFiles)` — qBittorrent optionally deletes downloaded files
5. Moves content to /Processed via renameSync (NOT hardlink — torrent is gone, files are now independent)
6. Cleans up release_candidates, approval_history for that release
7. Does NOT touch Sonarr/Radarr (they remain as-is)

## Request Grouping (Dashboard)

- Series requests are grouped by `sonarr_id` in the Requests section
- Each franchise shows as a card with season pills fetched from Sonarr (`GET /managed/:sonarrId/seasons`)
- Requested seasons show status (SEARCHING/AWAITING_APPROVAL); unrequested seasons shown dimmed (opacity 0.4)
- Title shows "X/Y requested" count
- Clicking a requested season navigates to its request detail

## Native Franchise Metadata (Specials, Identity, Language)

Native (arr-free) franchises get their season list and episode names from TMDB. A
few rules that matter when touching this code:

### Clean titles before TMDB lookups
`cleanFranchiseTitle` (`src/routes/requests.ts` ~594) strips release-name tails
(` S01E01 PL 768p WEB-DL H.264-AL3X`, `-AL3X`-style junk) from the stored request
title to get a searchable base title. Use it for **every** title passed to TMDB
(display, S00 injection, episode grids, refresh, fix-identity). It preserves
`Mufasa: The Lion King (2024)` / `Station 19` / `Death in Paradise (2011)`.

### Disk-title fallback (`altTitle`)
Row titles are user/import-time mangled (e.g. stored `Ninjago: Dragon Rising` vs
the real `LEGO Ninjago: Dragons Rising` on disk), so TMDB search alone misses.
`fetchTMDBSeason(db, key, season, title, { altTitle })` retries resolution with
`altTitle` before giving up. Call sites pass the on-disk processed folder name:
- S00 injection in `/managed` + `/native-franchise`: `fallbackShowDir` basename
- Episode grids (`/:id/episodes`, `/native-franchise/:id/episodes`) and
  `refresh` endpoints: `path.basename(path.dirname(seasonFolder))`
`resolveShowIdentity` also strips a bracketed year from the query and retries a
yearless search when the slug's year is best-effort/wrong.

### Show-dir resolution order
When title-matching the `Sxx` folder fails (localized/mangled titles),
`fallbackShowDir` is derived from: `processedShowDirFromFiles` (now scans ALL
`approval_history` rows, not just `release_id IS NULL`) → `showDirByStructure`
(last resort: scan `PROCESSED_TV` for a folder containing the requested `Sxx`
subdirs). Both are wired into `/managed` and `/native-franchise`.

### Specials injection
- Disk-season injection (folders **with video files**) runs for **all**
  franchises (sonarr-linked and native).
- A TMDB-only `S00` pill is injected for **native** franchises when the show has
  an `S00` folder on disk (`seasonFolderOnDisk`) even if it's an empty grip
  (Death in Paradise, The Smurfs, Ninjago), actively `fetchTMDBSeason(...S00...)`
  and counting `namedSpecialCount`. Sonarr-linked groups get the disk injection
  but NOT this TMDB-only path (no library_key).
- The Specials pill is honest: numerator = counted files/coverage, denominator =
  TMDB named specials exposed as `nativeSpecialDenominator`. Never hide a pill
  just because it has no fill (no ghost rows).
- Injected seasons have `request_id: null` — consumers must skip those (e.g. the
  language select uses the first season **with** a `request_id`, not `seasons[0]`,
  since injected `S00` sorts first).

### Fix Identity repair
`POST /api/requests/native-franchise/:id/fix-identity` (frontend: "Fix identity"
button in `NativeFranchise.tsx`) rewrites a polluted
`library_key` (`series:tajemnica-sagali-264-al3x:0` → `series:<tvdbId>:2016`):
1. Resolves on TMDB from `cleanFranchiseTitle`; if that misses, retries with the
   disk-derived show folder name.
2. Builds `series:<tvdbId|imdbId|slug>:<year>` via `seriesKeySegment` — **TVDB
   first** (the id the canonical `[tvdbid-####]` dir names embed), then IMDb,
   then the title slug. A slug is a **lossy artifact of a title**, so it is the
   last resort and is always built from the **resolved** name, never the stored
   row title (which is routinely localized — "Kacze opowiesci" used to mint a
   Polish slug). `applySeriesIdentity` is the series mirror of
   `applyMovieIdentity`, and because the id segment wins, an already id-anchored
   key is a no-op — the repair can never **downgrade** a TVDB key to a slug.
3. Refuses (`409`) if another franchise owns the target key; no-ops when already
   canonical.
4. Migrates `media_requests`, `tmdb_season_cache`, `tmdb_franchise_prefs`
   (language pref) and — unlike the original series repair — `media_files`, so the
   identity layer moves WITH the key (a skipped migration orphaned every
   registered inode until a read re-registered it). Drops the stale
   `tmdb_external_ids` row for the old key and repopulates under the new one.
Keys carry a fragile `:0` year when the lookup didn't produce one — the
yearless-search retry and disk-title fallback exist precisely to fix those.

**Series now carries the movie's Re-attach pair too** (mirroring `RequestDetail`):
`GET /api/requests/native-franchise/:id/identity-candidates` searches the readable
stored title AND the lossy key slug (merged), and accepts a free-text `?q=` because
TMDB indexes a show under its ORIGINAL name — a localized card title can be
unsearchable in any spelling we derive. `POST /api/requests/native-franchise/:id/retitle { tmdbId }`
applies the pick, rewriting the franchise `title` (the mangled *input* that caused
the bad identity) alongside the key across every season. Both take a `:id` that is
any one of the franchise's season requests (the UI seeds from the first season with
a `request_id`, since injected rows have `request_id: null`).

**Movies have their own endpoint**, `POST /api/requests/:id/fix-identity`
(`RequestDetail.tsx`, the movie card's header next to the TMDB language select —
series repairs stay on `NativeFranchise.tsx`, and this route 400s on a series
row). Same three steps via `resolveMovieIdentity`, plus two deliberate
differences:
- The id anchor is the **IMDb** id, not TVDB (`movieKeySegment`), because a movie
  has no TVDB id. Both now build the slug from the **resolved TMDB name**, never
  the stored row title: a key is what Fix Names mints the canonical filename and
  folder from, so keying it off a localized/mangled title would only relocate the
  junk.
- It **deletes** the `tmdb_external_ids` row for the OLD key and then
  re-resolves under the new one. Carrying the old row across is wrong (it holds
  the pre-fix resolved title, so the next preview would keep printing it), but
  simply deleting it and leaving the new key bare is worse: a slug-keyed row for
  a localized movie (`Niekonczaca sie opowiesc III` →
  `movie:the-neverending-story-iii:1994`) can find no id in its key or its stored
  title, and losing the id silently cost the card its library folder and its
  "in library" state. So `resolveExternalIds(db, newKey, …, { ignoreCache: true })`
  repopulates it. The series repair now does the same (`tmdb_external_ids` keyed
  by `library_key`), so `[tvdbid-####]`/`[imdbid-tt…]` stay resolvable offline.
- The **identity is displayed, and the button is always available**. The card
  header shows the raw `library_key` next to "Fix identity" (which is no longer
  gated on `keyNeedsIdentityRepair`). That gate was wrong: a key built from a
  mangled title is *well-formed and wrong* — `movie:hobbit:2012` and
  `movie:hobbit:2014` both parse cleanly — and hiding the button there meant the
  only way to see a bad identity was to already suspect one. The key is what
  Fix Names, the folder veto and the canonical filename all key off, so it is
  worth reading. `identityKeyIssue` only colours it for the unambiguous failures
  (`:0` year, unparseable key) rather than guessing at the rest.

#### A movie identity repair must never guess
Fixing a key *is* re-attributing files, and identity outranks every read-time
signal afterwards, so a wrong binding is far harder to undo than an unrepaired
one. The resolver used to take `search/results[0]`, which for a shared franchise
title binds the card to whichever film TMDB happened to rank first. `fix-identity`
now hands the decision to `decideMovieIdentity` (exported, pure, unit-tested) and
returns `{ ambiguous: true, candidates: [...] }` instead of applying, in two cases:
1. **the resolution contradicts a year the request already states** — `ownYear`
   is `requestYear(seed)` (the `(1994)` in the title or the `:2012` tail of the
   key) falling back to `nameYear` of the on-disk folder. A stated year is
   evidence, so a match that disagrees with it is a guess about a *different*
   film; and
2. **no year to disambiguate with and several films match the title** — "Hobbit"
   is three films, so only TMDB's ranking separates them and that ranking is
   arbitrary.

A candidate is *plausible* only when it carries **every** significant word of the
stored title (`plausibleMovieCandidate` / `titleWords`): partial overlap must not
read as confirmation, or "Hobbit" would match the franchise once and be taken as
decided. Conversely a stated year makes ambiguity moot, which is exactly why the
two real Hobbit rows (`movie:hobbit:2012` / `movie:hobbit:2014`) repair
unattended — TMDB's `year=` filter already separated them, and the rule only
interferes when the year is absent or contradicted.

`POST /api/requests/:id/retitle { tmdbId }` applies the user's pick and is the
**only** path that rewrites `media_requests.title`. Repairing just the key is not
enough: a mangled title is the *input* that produced the bad identity, and a card
still titled `Hobbit` goes on matching its sibling's files no matter how canonical
its key is. It shares `applyMovieIdentity` with `fix-identity` (single migration
transaction, plus the cache repopulate above); only the title column differs.
Both still 409 rather than merge when the target key is already taken.

Its disk fallback is `processedMovieDirFromFiles` — which returns a folder only
when the movie is **foldered**, since movies are mostly flat in
`PROCESSED_MOVIES` and that root names nothing.

#### Keys fold diacritics
`slugForKeyTitle` strips accents via `foldDiacritics` before its `[^a-z0-9]`
sweep. It did not, and that sweep turned **every** non-ASCII letter into a
separator: `Niezwykła podróż` → `niezwyk-a-podr`, so a movie resolved under a
Polish TMDB language minted a garbage identity. `ł` (U+0142) is mapped
explicitly because NFD has no canonical decomposition for it. This is on the
identity path (fix-identity, retitle, discover, seerr sync, import), so a key
minted before the fix may be junk for a diacritic title and is repaired by
re-running the repair.

- The **folder veto** (`folderOwnedExclusively`) is the same idea at directory
  level, and the two Hobbit library folders (`Hobbit (2012)` / `Hobbit (2014)`)
  showed why it has to exist: a flat, one-word franchise means folder ownership
  is only ever established by what is inside.

#### The twin's folder is the last place the year is written down
`siblingRequestClaimsYear` needs the file to state a year. Some releases do not:
`Hobbit Niezwykła podróż Dubbing PL - Video w Resetoff.pl.mp4` has no year, no
IMDb id, and a Polish title sharing one word with both Hobbit films, so every
name-based signal is silent and the file lands on all three cards at once. Its
library twin is in `Hobbit (2012)/` — a folder whose name states the film outright,
which is where a human (or an arr) already put it.

`libraryFolderYear` reads that year, and `libraryFolderContradicts` vetoes a file
whose twin's year a *sibling* owns. Guarded hard, because a folder name is weaker
evidence than a deliberate `(YYYY)`: a bare media root (`Filmy/`) and any folder
without a bracket/space/dash yield null, both the folder year and the request's
own year must be known and must differ, a sibling must actually claim that year,
and series are exempt entirely. Null on any signal means admitted, so it can only
ever exclude. `reassignFileByLibraryFolder` then re-points the stale `media_files`
row at the owning key, so the misattribution is fixed at its source instead of
being filtered at every read.

**The year alone never names an owner** — `siblingOwningYear` requires the
sibling's title to share a significant word with the *folder* as well. There is
always an unrelated film from the same year in the table, and matching on the
year alone handed a Hobbit file to whichever 2012 movie was inserted first
(Skyfall), which then dropped the file from Fix Names entirely because a
registered `media_files` row is an absolute veto there. The word test is what
makes it a same-franchise rival rather than a coincidence.

**Fix Names must read exactly what the panel reads.** The twin map is built
*before* the processed scan and threaded into `processedFileMatchesRequest`, so
both surfaces veto on the same folder evidence. Otherwise the panel lists a file
its Fix Names refuses to propose — the divergence that made the Polish dub
"disappear" from the 2012 card while still being listed on it. An unregistered
twin of one of this request's own library files also counts as *ours* (adoption
leaves inodes unregistered), which is the panel's `linkedToLibrary` rule.

**A sibling's folder is not listed at all.** `nativeMovieLibraryFolders` matches
the whole franchise, so a one-word title returns every Hobbit folder — and
offering `Hobbit (2014)` on the 2012 card, even struck through with a refusal,
reads as "this card should own it". The refusal note stays for a folder that is
genuinely ambiguous; a sibling's folder is simply not this request's business.

`folderOwnedExclusively` was the same bug one level up: a file inside
`Hobbit (2014)/` still registered to the 2012 key made the **2014** card refuse to
rename its own folder ("Folder holds files of another franchise"). A folder whose
name states the request's year now **re-registers** the stale rows instead of
refusing — the folder is the better evidence there, since the rename is about that
folder's contents specifically. But a file carrying **its own embedded id** still
outranks that year: a folder can be mis-filed, a name this app minted cannot name
the wrong film, so the id check moved ahead of the year-trust.

#### Word overlap cannot separate a flat franchise — the year can
`siblingRequestClaimsYear` is the id-less branch of `nameContradictsRequest`. The
pre-existing year fallback needed `>= 2` shared title words to confirm the two
names were about the same franchise, and that threshold is wrong for exactly the
case this feature exists for: `Hobbit Bitwa Pięciu Armii 2014 …` shares **one**
word (`hobbit`) with `The Hobbit: An Unexpected Journey`, because a Polish release
*translates the subtitle* and every distinguishing English word is gone. So the
veto stayed silent and Fix Names offered to rename a Five Armies file to the
Unexpected Journey name — the destructive outcome a veto exists to prevent.
The fix is not to lower the threshold but to add a **stronger** signal beside the
year: if a *sibling* movie request (different `id`, same stated year) shares even
one word with the file, that sibling owns this year and the file contradicts.
One word suffices **because the year already agrees** — the pair is what carries
the decision, and lowering the shared-word threshold alone would have started
vetoing unrelated films. Guarded so it stays off the hot path: it is only reached
once the years actually disagree, is movies-only (a series' seasons share the
show's title and must not steal each other's files), and never fires without a
sibling (a lone one-word franchise still falls through to the `>= 2` rule).

### Language pref
`tmdb_franchise_prefs` is keyed by `library_key` (post-fix-identity key, i.e.
the message handles both row data and cache/prefs migration). `set-language`
uses `request.library_key` and returns 400 for sonarr-linked rows. `altTitle`/
resolution inherits the pref through every call site.

## Key Files

| File | Purpose |
|------|---------|
| `src/config/paths.ts` | All filesystem path config + qBittorrent path translation |
| `src/services/prowlarr.ts` | Prowlarr API client (search indexers) |
| `src/services/sonarr.ts` | Sonarr API client (search, grab, unmonitor, delete) |
| `src/services/radarr.ts` | Radarr API client (search, grab, unmonitor, delete) |
| `src/services/qbittorrent.ts` | qBittorrent Web API v2 (torrents, auth) |
| `src/services/scoring.ts` | Release scoring engine |
| `src/services/processor.ts` | Hardlink processing (mkvmerge/ffmpeg), workspace management |
| `src/services/libraryImport.ts` | Arr-free library reconcile: plans/creates COMPLETED `media_requests` keyed by `library_key`, inode-links library files to their processed counterparts. Dry run unless `apply: true` (endpoint `POST /api/requests/import-library/native`) |
| `src/services/identity.ts` | Identity layer (P0): `media_files` registration keyed by `(dev, inode)`, inode lookups (`identifyByPath`, `identifySeasonFolderFiles`), `registerVideoTree` on write paths, `autodetectIdentity` for adopt/import (title+season matched against `media_requests`), `deriveIdentityFromFilename` (S0X → unnumbered special) |
| `src/config/naming.ts` | Naming kernel (P1 + P1b): token templates + `loadNamingConf`/`saveNamingConf` (Settings → Naming Templates), `parseReleaseTags` (language/source/res/audio/HDR/video/group, `+`-joined language enumerations, channel-number + multi-word bracket merging, `[Unknown]` placeholder → dropped, never a group), `assembleCanonicalTags` (probe-over-title merge; probe language enumerates 2+ foreign streams in track order, dub only when exactly one), `inheritReleaseFacts` (fills source/group/edition gaps from a same-inode twin's name — never overriding, never inheriting probe facts), canonical dir + file builders, `uniqueDestPath` collision suffixes, `sanitizeSegment`. `xvid`/`divx`/`mpeg-4` are MPEG-4 Part 2 (`videoFamilyOf`), so a title-branded label is kept instead of being flattened to the probe's generic `Xvid` — which used to render `[Xvid][Xvid]`. **Encode-quality modifiers** (`Proper`, `Repack`, `Rerip`, `Reencode`/`Reenc`) are held in `ReleaseTags.qualityMods` and rendered *inside* the source-resolution bracket (`[Remux-2160p Proper]`), because that is where groups write them: they claim the encode was fixed, which is a property of the resolution group, so isolating them in their own bracket mis-ranks them as an unrelated edition. They are name-only, so they are inherited from a same-inode twin — but as a *set*, not per item, since a repack is not a proper release and a name that states its own keeps it whole (`[Proper Repack]` is never synthesized). With no resolution anywhere the modifier is dropped rather than orphaned as a bare `[Proper]` |
| `src/services/mediaProbe.ts` | ffprobe probe (P1b): raw stream facts — frame width/height (the resolution TIER is read from width; height only raises it), video+audio codecs, channel layout, bit depth, HDR flags (DV/HDR10+/HDR10/HLG), and **every** audio track's `language`/`title` (the language tag reads all of them — never truncate, a 12-track remux read as 4 tracks looked like a single-language dub) |
| `src/services/tmdb.ts` | TMDB client: `fetchTMDBSeason` (per-key season cache + `altTitle` fallback), `resolveShowIdentity` (`{id,name,year,via}`), yearless retry |
| `src/routes/requests.ts` | All API endpoints (~7200 lines) |
| `src/jobs/pollRadarr.ts` | Discovers wanted movies, searches |
| `src/jobs/pollSonarr.ts` | Discovers wanted series (no auto-search) |
| `src/jobs/pollStatus.ts` | Tracks torrent status, state transitions |
| `src/db/index.ts` | Schema, migrations, auto-repair |
| `src/server.ts` | App entry, startup stale RC cleanup |
| `frontend/src/components/TorrentPanel.tsx` | Shared torrent panel (progress, stats, move actions) |
| `frontend/src/components/WorkspacePickerModal.tsx` | Shared workspace picker modal (select existing + create new) |
| `frontend/src/components/WorkspaceManagerModal.tsx` | Shared workspace manager (name, notes, scripts, complete & import, delete) |
| `frontend/src/components/ScriptDropdown.tsx` | Multi-select dropdown for workspace scripts |
| `frontend/src/pages/FranchiseDetail.tsx` | Franchise overview + SeasonDetail |
| `frontend/src/pages/RequestDetail.tsx` | Single request view (movies) |
| `frontend/src/pages/Dashboard.tsx` | Requests list + filters + managed media |
| `frontend/src/pages/NativeFranchise.tsx` | Native (arr-free) franchise view: seasons, Specials pill, language select, "Fix identity" + "Re-attach" repair |
| `frontend/src/api.ts` | Axios client + all API functions |

## Environment Variables

All path config lives in `src/config/paths.ts` and is read once at boot. Defaults derive from `MEDIA_ROOT`; per-directory overrides are optional. See `.env.example`.

```env
# Storage
MEDIA_ROOT=/media
# Leave empty unless qBittorrent's view of the storage differs from
# the app's (legacy container: /media/Torrents → /Torrents).
# QBIT_PATH_PREFIX=/Torrents
# QBIT_HOST_PREFIX=/media/Torrents

# Prowlarr (search indexers directly)
PROWLARR_URL=
PROWLARR_API_KEY=

# Radarr/Sonarr (metadata, episode model, library import)
RADARR_URL=
RADARR_API_KEY=
SONARR_URL=
SONARR_API_KEY=

# qBittorrent (download)
QBIT_URL=http://127.0.0.1:8080
QBIT_USER=
QBIT_PASS=

# Paths — Download (immutable, seeds forever)
DOWNLOADS_MOVIES=/media/Torrents/download/filmy
DOWNLOADS_TV=/media/Torrents/download/serialy

# Paths — Processed (staging for Sonarr/Radarr import)
PROCESSED_MOVIES=/media/Torrents/processed/filmy
PROCESSED_TV=/media/Torrents/processed/serialy

# Paths — Workspace (ephemeral processing scratch space)
PROCESSING_WORKSPACE=/media/Torrents/Workspace

# Paths — Trackers (per-torrent metadata, exported on destroy)
TRACKERS_DIR=/media/Torrents/Trackers

# Paths — Library (final destination, managed by Sonarr/Radarr)
MEDIA_MOVIES=/media/Filmy
MEDIA_TV=/media/Serialy

# Polling
POLL_INTERVAL_RADARR=60
POLL_INTERVAL_SONARR=60
POLL_INTERVAL_STATUS=30
# Seerr request-sync poll (seconds). Only used when SEERR_URL + SEERR_API_KEY are set.
POLL_INTERVAL_SEERR=60

# Notifications
NTFY_URL=
NTFY_TOPIC=

# Seerr (arr-free request portal) — the app syncs Seerr's own request list into
# media_requests. URL + API Key from Seerr Settings -> Main -> API Key.
SEERR_URL=
SEERR_API_KEY=
```

## DB Schema Notes

- `release_candidates.torrent_hash` — stores infoHash from Prowlarr (40-char hex) or hash from qBittorrent
- `release_candidates.info_url` — stores magnet URI for Prowlarr results (starts with `magnet:`), or info page URL for Sonarr/Radarr results
- `release_candidates.radarr_release_id` — stores Prowlarr's `infoHash` or `guid`, or Sonarr/Radarr's release `guid`
- `release_candidates.parsed_episodes` — extracted episode codes (e.g. "E01E02E03")
- `media_requests.last_searched_at` — used by search-all skip guard (5 min cooldown)
- `media_requests.episode_count` — total episodes for the season
- Status enum: NEW → SEARCHING → AWAITING_APPROVAL → DOWNLOADING → SEEDING

## Common Gotchas

- Express v5 routing: `/{*path}` for catch-all, not `/*`
- `better-sqlite3` v12: `lastInsertRowid` returns BigInt, never extract `.get`/`.run` from prepared statements (loses `this` binding → `Illegal invocation`)
- Sonarr's `/api/v3/release` ignores `term` parameter — use Prowlarr instead
- Dismiss blocked for DOWNLOADING/SEEDING/COMPLETED (backend guard)
- SSE: use `Connection: close` header, parse `eventType` across chunks
- Poller `pollStatus.ts` uses `torrentMatchesTitle()` for fuzzy matching when hash fails
- Season regex: `\bS(\d{1,2})(?:E\d|\b)` — plain `\b` after digits fails on `S02E12` format
- Startup stale RC cleanup: check each RC individually (not per-hash) to avoid deleting valid RCs
- Managed media: series show always if DOWNLOADING/SEEDING; movies require `release_count > 0`. **Group-based split**: a content-less requested season of a series joins the managed card (as a `requested-empty` amber-pending pill) once *any* sibling season under the same `library_key` has content, and disappears from the Requests list — the Requests section only holds franchises with zero content anywhere. **Only genuinely-active rows join the card**: the sibling clause requires the row's own `status` to be a real state (`NEW`..`COMPLETED`), and `db/index.ts` startup repair deletes empty/NULL-status ghost rows (no arr/seerr link, no content) so legacy junk never surfaces as an amber "requested" pill.
- `franchise-season-row` uses flex layout with expandable inner content (click row header to toggle)
- Hardlinks cannot cross filesystem boundaries — Download, Workspace, Processed, and Library must all be on the same volume
- Cross-owner hardlinks (EPERM): library files owned by root (Radarr imports as root) fail adoption's `linkSync` with EPERM when the app runs as a normal uid and `fs.protected_hardlinks=1` (Debian default). `setup.sh` writes `fs.protected_hardlinks=0` to `/etc/sysctl.d/99-media-hardlinks.conf`. If adoption suddenly EPERMs again, check `/proc/sys/fs/protected_hardlinks` and the app user's uid vs the source file's owner.
- qBittorrent and the app must mount the shared storage at the **same absolute path**. `fromQBittorrentPath()` / `toQBittorrentPath()` live in `src/config/paths.ts` and are no-ops unless `QBIT_PATH_PREFIX`/`QBIT_HOST_PREFIX` are set — never hardcode a path prefix at a call site
- Hardlinks are created by the filesystem/NFS server, so qBittorrent may run in a different VM than the app as long as both mount the same export. A *path* mismatch is the real risk: it silently triggers the `EXDEV` → `copyFileSync` fallback in `processor.ts` and triples disk usage
- Import endpoint FK fix: uses SELECT-then-INSERT (not INSERT OR IGNORE) to avoid `lastInsertRowid=0` causing FOREIGN KEY constraint failure on approval_history
- `form-data` npm package used for qBittorrent multipart file upload (already a direct dependency)
- Import endpoint uses `toQBittorrentPath()` for save path, `fromQBittorrentPath()` for content_path/save_path from qBittorrent
- Destroy modal is a proper modal (not 3-click confirm), shows options for delete files vs keep files
- Destroy moves Download content to /Processed via renameSync (NOT hardlink — since torrent is removed anyway)
- Processed files in /Processed are preserved by destroy either way
- `--card-bg: #1e293b` CSS variable fixes transparent modals
- **Import-library processed_files**: Always targets/creates `release_id IS NULL` AH rows (not torrent-linked rows). Skips adding files already in /processed by inode check (`alreadyImported`).
- **A packed episode file moves the whole tail of the season.** When a release packs
  TMDB's double episode into one file it keeps only the FIRST number (DuckTales
  S01E51 "Magicas Magic Mirror Take Me Out of the Ballgame" is E51 AND E52), so
  every later file is numbered one behind. `resolveEpisodeSpan` fixes both halves
  from one piece of evidence — the file's own title — and they only work TOGETHER:
  the packed file becomes `S01E51-52` while the next file moves to E53. Crediting the
  range alone claims E52 twice; moving the tail alone leaves the packed file hiding
  an episode. Number+title previously came from different sources (code from the
  filename, title from the cache at that number) with no cross-check, which labelled
  E52–E65 with the PREVIOUS episode's title.
  Three guards keep the inference honest, each answering a real false positive:
  - **A packed file's extra title must TRAIL** (`titleStartsWith` + `titleEndsWith`,
    not word overlap). The DuckTales pilot's E01 filename carries both halves'
    wording while the release ships a separate E02 file — overlap alone turned that
    into a bogus `S01E01-02`.
  - **A shift needs EXACTLY ONE matching neighbour.** E01's own title overlaps both
    "Don't Give Up the Ship (1)" and "(2)"; a shift that merely found a match moved
    that file onto a number a sibling already held. Zero matches (a translated or
    reworded title) likewise leaves the number alone — which is what keeps a Polish
    release on an `en-US` cache (`episodeTitleFromCache` defaults to `en-US`) from
    being renumbered wholesale.
  - **An explicit `S01E01-02` range in the name is authoritative** and never
    re-inferred; the release already declared its own span.
- **A Fix Names batch renames in two phases, because a season-wide renumber is a
  permutation.** Every file's canonical name can be the name another file in the same
  folder is about to vacate, and `uniqueDestPath` answers a collision with a `-2`
  suffix rather than an error — so an in-place loop silently produces suffixed names
  instead of failing. `stageFixName` parks every file that must move under
  `.fixnames-tmp-<dev>-<ino><ext>` in its OWN directory (same filesystem, dot-prefixed
  so a media scanner ignores it), and only then is each destination computed, which
  makes the outcome independent of the order the rows arrive in. A failed landing
  renames the file back rather than leaving a dotfile behind, and the inner listings
  skip dotfiles so a leftover can never be offered as a renamable row.
  Honest scope: this only helps when the cycle is **within the batch**, and that is
  rare — a canonical name rarely equals any release name already on disk. The
  DuckTales renumber changed the prefix (`DuckTales - ` vs `DuckTales (1987) - `) and
  the tags (`[PL] [x264]` vs `[h264]`) at once, so every destination was free and the
  old in-place loop would have been fine there. A name held by a file *outside* the
  batch still yields `-2`, which is the intended multi-version behaviour.
- **Native identity (`library_key`)**: `media_requests.library_key` is the arr-free identity (`movie:<imdb|slug>:<year>` / `series:<tvdb|imdb|slug>:<year>`). `/managed` groups series by `sonarr_id` OR `library_key`. Reconcile (`POST /import-library/native`) only creates/adopts dormant rows; rows in DOWNLOADING/SEEDING/SEARCHING/AWAITING_APPROVAL/APPROVED are never touched. Native series cards have no sonarr_id — frontend "Manage" falls back to `/requests/{first_request_id}`, and the Delete button is hidden (needs Sonarr).
- **A movie repair PREFERS the IMDb id, never the slug.** `movieKeySegment`
  (`requests.ts`) takes the id whenever TMDB returns a real one (`^tt\d{6,}$`),
  so a re-attach cannot *downgrade* an id-anchored key
  (`movie:tt0100240:1990`) into a slug one — which is what `applyMovieIdentity`
  used to do unconditionally, on every retitle. The id is the deterministic anchor
  `imdbIdOwnerKey` and the folder veto depend on; a slug key leaves both leaning on
  the `tmdb_external_ids` cache alone. The id is resolved **fresh** for the film the
  user actually picked, never read from the old key's cache row: that row describes
  whatever film the key used to name, which is exactly what the repair disputes.
  The slug stays the fallback when TMDB has no id (or the lookup fails), and a slug
  key still resolves — `requestImdbId` reads the cache this path repopulates.
- **Scan endpoint movie import**: Skips importing the main movie file from Radarr library if the request already has a tracked torrent (`torrent_hash != ''`). Extras still imported.
- **Dashboard version count**: `release_count + processed_count`. `processed_count` queries only `release_id IS NULL` AH rows. Startup inode-dedup removes processed files that are hardlinks of torrent download files (same inode → not a separate version).
- **Processed endpoint series scanning**: Only scans the specific season subfolder matching the request's season (e.g. only `S02/` for season 2), not all seasons. No longer adds directory entries as files.
- **PollRadarr reliability**: Uses `getAllMovies()` with JS filtering instead of `getWantedMovies()` to avoid Radarr server-side filtering inconsistencies.
- **Startup DB cleanup order**: Dedup → dangling cleanup → merge null-release_id rows → migrate non-null processed_files to null rows → inode dedup → release_name reconcile → **processed_files rebuild from identity**
- **The dangling `processed_files` cleanup must never run against unreadable storage.** It drops any entry whose file is missing under the processed root, and it runs at every boot. If `/media` isn't mounted yet (NFS timing) or the app user can't read it, `existsSync` fails for *every* entry and relocation has nothing to read, so one bad startup wipes every request's `processed_files` at once. The cleanup is now gated per type on the processed root actually holding videos (`rootHasVideos`) — an empty/unreadable root means "not mounted", not "all deleted". Recovery is immediate: the next boot's **processed_files rebuild** walks the processed trees, maps each video's `media_files` identity row (`dev,inode → library_key+season`) to its request, and repopulates any request whose lists are entirely empty. `media_files` is the source of truth and lives in the DB, so a storage blip costs only the path cache, never identity or files.
- **Startup season mismatch check**: Uses `\\bS{req_season}\\b` regex to check if the specific season string exists in the torrent name, instead of matching the first S## — prevents deleting RCs for S02/S03 in multi-season packs like `S01-S03`.
- **titlesMatch stop word filter**: Common English stop words (`the`, `a`, `an`, `and`, `or`, `of`, `in`, `on`, `at`, `to`, `for`, `with`, `by`, `is`, `it`, `its`) excluded from word overlap count — prevents false positives like "The Adventures of the Mole" matching "Puss in Boots".
- **Roman numerals are sequels too.** The sequel guard that keeps "moana 2" from
  matching "moana" only knew arabic digits, so *The NeverEnding Story II* matched
  NES III: NES III's freshly-canonical name is a **prefix** of the NES II title
  ("The NeverEnding Story III (1994) [imdbid-tt0110647] - …" starts with "The
  NeverEnding Story II"), the digit test could not see the trailing `iii`, and NES
  II's Fix Names then proposed renaming NES III's file and folder.
  `trailingSequelNumber` (anchored at the end, canonical roman spellings 1–10 only)
  plus `SEQUEL_EXTENSION` fix both halves: a numeral both sides carry must agree,
  and a sequel extension on a prefix match is now a **final** rejection — falling
  through to word overlap readmitted it, because the two titles share two of three
  words and three-word titles carry a one-word tolerance.
- **Folder ownership reads ids out of names, not just `media_files`.**
  `folderOwnedExclusively` treated a file with no registered identity as *owned*,
  so one card could rename a sibling's folder whenever the other card's file had
  no `media_files` row. It now also refuses when a file inside pins a **different**
  `[imdbid-tt…]` than the request's own id — a canonical name states identity
  outright, settling what a missing row could not. Applied at all four preview
  sites *and* the apply path, or preview and apply would disagree.
- **`ino` is `fs.Stats`, `inode` is the column.** `media_files` is keyed
  `(dev, inode)`, but the inode value itself comes from `st.ino` — Node's
  `fs.Stats` property. Mixing the two in SQL throws `no such column: ino` at
  prepare time. The post-rename `release_name` refresh did exactly that behind a
  bare `catch {}`, so every Fix Names rename reported success while the UPDATE
  never ran and `release_name` kept the PRE-rename name. That is not cosmetic:
  `storedNameMatchesRow()` compares `release_name` against a real on-disk
  basename to self-heal stale `approval_history` paths, so a stale value
  silently disables that recovery. Two rules follow: a `catch {}` around a write
  must log, and startup re-derives the truth by stat anyway — `reconcile` in
  `db/index.ts` walks the four managed trees, maps `dev:ino -> basename`, and
  rewrites only rows that disagree (idempotent, no-op once clean). It exists
  because `media_files` stores no path, so the disk is the only source for a
  name the app may have failed to write. Retitle/fix-identity repairs the same
  value through a different path: re-registering inodes hits the
  `release_name = excluded.release_name` upsert in `identity.ts`.
- **Version count excludes DOWNLOADING**: `release_count` and `total_size_mb` subqueries add `AND mr.status != 'DOWNLOADING'` so in-progress torrents are not counted as versions. Dashboard outer WHERE includes `IN ('DOWNLOADING', 'COMPLETED')` to keep visible. Managed endpoint at line 646-660.
- **Unmatched match (series) multi-season**: `POST /unmatched/:id/match` for series scans `content_path` for season subdirectories, creates one request per detected season. Response includes `seasons` array.
- **isSeasonPackTitle range patterns**: Handles `S##-S##` and `S##-##` ranges in torrent names (e.g. `[S01-S03]` covers S01, S02, S03). Used by franchise coverage detection.
- **Startup title cleanup**: Skips title check for RCs where the request has `sonarr_id` or `radarr_id` — ID-based link is more reliable than string matching (handles bilingual titles). Uses `titlesMatch()` for remaining unlinked RCs.
- **Arr-less is a supported state**: `pollRadarr`/`pollSonarr` only boot when `RADARR_URL+RADARR_API_KEY` / `SONARR_URL+SONARR_API_KEY` are both set (`server.ts`); otherwise they're no-op pollers with `stop()`. Prowlarr search gates check `PROWLARR_URL` **and** `PROWLARR_API_KEY` (not just the key).
- **Search-all reports config honestly**: `POST /managed/:sonarrId/search-all` and `/managed/search-all-movies` now short-circuit with an SSE `error` + `done(success:false)` when Prowlarr is unconfigured, instead of flipping every request to AWAITING_APPROVAL, writing a 5-min cooldown, and claiming 0 found.
- **Arr deletes are best-effort + loud**: cleanup-duplicates, remove-titles, `DELETE /managed/:sonarrId`, and destroy now check `res.ok` on their raw-`fetch` deletes, log `HTTP <status>` on failure, and report `arrDeleteFailures`/`sonarrDeleteFailed` in the response — DB rows are still removed regardless so a down arr never blocks local deletion.
- **Dismiss never deletes library files**: a season-less series dismiss uses `sonarr.unmonitorSeries()` (unmonitor all seasons, keep files) matching movie dismiss's `unmonitorMovie` — it no longer calls `deleteSeries(..., deleteFiles=true)`.

## Testing Checklist

- [ ] Prowlarr search returns results with custom terms
- [ ] Quality parsing checks source (WEBDL/WEBRip/Bluray) before resolution
- [ ] Approve grabs torrent via magnet URL
- [ ] Status poller detects Prowlarr-grabbed torrents by infoHash
- [ ] Dismiss blocked for active downloads
- [ ] Fallback to Sonarr/Radarr when PROWLARR_API_KEY not set
- [ ] Search-all reports error (not "0 found") + writes no cooldown when Prowlarr unconfigured
- [ ] pollRadarr/pollSonarr don't boot when arr URL/key unset
- [ ] Season regex handles S##E## format correctly
- [ ] Startup cleanup doesn't nuke valid RCs for same hash
- [ ] Franchise search-all filters results by season number
- [ ] Franchise overview shows colored filled/missing badges per season
- [ ] Franchise episode grid shows Sonarr episode titles with FILLED/MISSED badges
- [ ] Per-season Search navigates to SeasonDetail with auto-search
- [ ] Per-episode Search includes episode name in query
- [ ] "Search All Seasons" fires background search + navigates to first season
- [ ] SeasonDetail search mode toggle (Season | Episodes) works
- [ ] Season packs (S## without E##) cover all episodes in coverage display
- [ ] Season pack quality parsed from torrent title (not hardcoded "unknown")
- [ ] Scan Downloads: status fix JOIN uses `ah.request_id = rc.request_id`
- [ ] Scan Downloads: season mismatches detected and re-imported
- [ ] Scan Downloads: stale approvals cleaned (torrent gone from qBittorrent)
- [ ] titlesMatch: "Mufasa: The Lion King" does NOT match "The Lion King" torrents
- [ ] Processing pipeline creates workspace with inputs/output dirs
- [ ] Move to Processed hardlinks from Download to Processed
- [ ] Move to Workspace hardlinks from Download to Workspace inputs/ (with output/ pre-created)
- [ ] Move to Library hardlinks from Processed (not Download)
- [ ] Workspace cleaned up after processing completes
- [ ] TorrentPanel checkbox toggles between "Move to Processed" and "Move to Workspace"
- [ ] TorrentPanel shared component renders correctly in both RequestDetail and FranchiseDetail
- [ ] TorrentPanel shows content info badge (video/bluray/multi/none) at 100%
- [ ] Content-info endpoint scans content_path for video files and BDMV directories
- [ ] titlesMatch rejects sequel numbers (e.g. "moana 2" does NOT match "moana")
- [ ] titlesMatch tolerates 1 missing word for 3+ word titles (e.g. "LEGO Ninjago" matches "Ninjago Dragons Rising")
- [ ] Embedded `[imdbid-tt…]` veto: Mufasa's file is rejected under The Lion King (1994) and vice versa, in the processed panel, Fix Names, the scan picker and library folder resolution
- [ ] Embedded-id veto is inert when either side has no id (raw release names still match)
- [ ] Embedded-id veto is **symmetric**: works even when the request's own id is unresolved (cold cache / slug-only key), via the file id's owner
- [ ] Year fallback rejects a no-id raw name whose year disagrees (`The Lion King 1994 MULTI …` under Mufasa 2024) but only with ≥2 shared title words
- [ ] Startup repair drops forged `processed_files` entries and re-attributes the inode under the real owner (no file touched on disk)
- [ ] Import: magnet link adds to qBittorrent and polls for hash
- [ ] Import: .torrent file upload creates RC and polls for hash
- [ ] Import: bypassApproval creates AWAITING_APPROVAL status immediately
- [ ] Destroy: exports .torrent + trackers.json to /Trackers/{hash}/
- [ ] Destroy: removes from qBittorrent, moves content to /Processed
- [ ] Destroy: preserves processed files in /Processed either way
- [ ] Dashboard: franchise grouping shows all seasons from Sonarr (X/Y requested)
- [ ] Dashboard: unrequested seasons shown dimmed (opacity 0.4)
- [ ] Scan Downloads: title+season mismatch detection frees wrongly-linked RCs
- [ ] Multi-season pack (S01-S03) shows all seasons covered in franchise view
- [ ] isSeasonPackTitle handles S##-## range (e.g. "S01-S03" covers season 2)
- [ ] Specials pill shows honest numerator/denominator (native shows: TMDB named specials), never hidden when unfilled
- [ ] Empty S00 grip (no video files) still gets a TMDB-only Specials pill for native franchises (DiP/Smurfs/Ninjago)
- [ ] `fetchTMDBSeason` altTitle fallback resolves mangled row titles from the on-disk folder name ("Ninjago: Dragon Rising" → "LEGO Ninjago: Dragons Rising")
- [ ] Fix identity rewrites `series:<junk>-264-al3x:0` → `series:<tvdbId|imdbId|slug>:<year>` (TVDB first), migrating requests/cache/language pref/**media_files**, 409 on clash
- [ ] Pressing "Fix identity" on an already TVDB-anchored series is a no-op (never downgrades the id key to a slug), and `seriesKeySegment` prefers TVDB then IMDb then the resolved-name slug (`series_key_segment.test.js`)
- [ ] `GET /native-franchise/:id/identity-candidates` lists shows (title + key slug, plus free-text `?q=`), and "Re-attach" applies one via `POST /native-franchise/:id/retitle` — rewriting the franchise title + key across every season
- [ ] Language select uses the first season with a `request_id` (injected S00 rows sort first but have `request_id: null`)
- [ ] Startup cleanup doesn't delete RCs for bilingual/alternate-title series
- [ ] Unmatched match creates multi-season requests from content_path scan
- [ ] Unmatched match returns 400 with a clear "Could not resolve on TMDB" when TMDB_API_KEY unset and arrs are down
- [ ] Scan Downloads pre-fills TMDB candidates when arr profiles unavailable (panel still shows pick buttons)
- [ ] Scan Downloads attaches torrents to existing native `library_key` rows (Step 1b) without calling arrs
- [ ] Move to Library marks DOWNLOADING/SEEDING requests COMPLETED (all three already-exists short-circuits included)
- [ ] Discover searches TMDB (movie+series combined), shows date badges/posters/overviews
- [ ] Discover series pick shows the season selector (lazy-loaded from `/discover/tv/:id/seasons`, S00 excluded)
- [ ] Discover request creates native `NEW` request; duplicate pick returns `existed: true` + existing request_id
- [ ] Discover navigation lands on RequestDetail where `POST /:id/search` (Prowlarr) takes over
- [ ] Movie card header shows the raw `library_key`, and "Fix identity" is present on every native movie (not just `:0` keys)
- [ ] `decideMovieIdentity`: a resolution contradicting the request's own year is refused (`ambiguous`, no write)
- [ ] `decideMovieIdentity`: no stated year + several plausible films is refused rather than taking TMDB's first hit
- [ ] `plausibleMovieCandidate` requires EVERY significant title word ("Hobbit" does not "match" the franchise once and read as decided)
- [ ] A stated year DOES disambiguate: `movie:hobbit:2012` and `movie:hobbit:2014` both repair unattended to distinct keys
- [ ] `POST /:id/retitle` rewrites title + key, migrates requests/cache/prefs, and repopulates `tmdb_external_ids`
- [ ] `retitle` and `fix-identity` 409 when the target key is already owned by another movie (never merge)
- [ ] `slugForKeyTitle` folds diacritics: `Niezwykła podróż` → `niezwykla-podroz` (incl. `ł`), and leaves ASCII keys unchanged
- [ ] `GET /:id/identity-candidates` lists candidate films, and "Re-attach" applies one via `POST /:id/retitle` (a card whose key was repaired but whose TITLE stayed mangled has no other route to a correct title)
- [ ] The candidate picker searches the stored TITLE **and** the key slug, merging both — never picks the slug merely because it is longer (a slug is lossy: `służbie` → `s u bie`, which found nothing for `Asterix … W służbie Jej Królewskiej Mości`)
- [ ] The picker accepts a free-text `?q=` term, because TMDB indexes a film under its ORIGINAL name — a localized card title can be unsearchable in any spelling we derive (`Asterix … W służbie Jej Królewskiej Mości` → TMDB's "Asterix & Obelix: Mission Britain")
- [ ] `SDR UPSCALING` is ONE tag: a multi-word MISC phrase re-joins across the bracket whitespace split, so `[10Bit SDR UPSCALING]` does not print `[SDR][UPSCALING]` (the upscale staying SDR is the whole claim). `10bit` stays its own tag beside the codec — ffprobe measures it, so it is not a name-only phrase
- [ ] A group written INSIDE a bracket (`[2160p.BluRay.H265.AC3-AS76-FT]`) is read even when more brackets follow — the anchored tail rule only ever saw end-of-string, so it dropped the release group out of existence
- [ ] `LEKTOR` is a VOICEOVER, not a DUB, and the two must not collapse: `[Lektor PL]` renders `[PL LEKTOR]` while `[Dubbing PL]` renders `[PL DUB]`. A lektor is one narrator's monotone voice over the picture (characters not voiced); a dub voices them — different audio tiers, so merging them made two releases of one film that differ only in this render as the same name. `ReleaseTags.dubbed: boolean` became `dubKind: "DUB" | "LEKTOR" | null` (naming.ts is its only consumer). `LEKTOR_WORDS` also covers the Polish adjectives `lektorski`/`lektorskie`; `NAUKA` stays a plain `DUB`, being a studio name with no voiceover meaning
- [ ] A hyphenated group round-trips: the tail rule accepts internal hyphens, or `-AS76-FT` re-reads as `FT` and every later pass shortens it again
- [ ] `retitle`/`fix-identity` migrate `media_files.library_key` with the rest of the key — reads are inode-first, so a row left on the old key made the file vanish from its own card ("Nothing to rename in this layer") while a registered row is an absolute veto in Fix Names
- [ ] An identity row naming a library_key **no request holds** is unattributable, not a statement: it vetoes nothing, and startup clears it (`NOT EXISTS` in `media_requests`). This is the residue of a retitle performed before the migration above landed, and nothing downstream can rescue it while it stands
- [ ] Admitting a file **claims its inode**: the name/twin fallback registers `media_files` rather than only admitting it. Startup clears unowned rows, so a file left unregistered is never re-attributed — and an unregistered inode cannot be found by identity from the library side, which is the only signal that can reach a folder whose name states neither the card title nor an id. Fix Names registers the approval_history inodes BEFORE resolving library folders, because the two lookups otherwise deadlock (folder reachable only by identity, identity registered only by a read that runs later)
- [ ] The processed panel registers them too, and the panel reads exactly what Fix Names reads: the same pre-pass runs in `GET /:id/processed`, or "is it already in the library?" is answered from an empty library scan and the panel offers **To Library** for a file already sitting in `/Filmy`
- [ ] A library movie folder is identified by the ids of the video files DIRECTLY inside it, so a mis-titled folder ("Akademia pana Kleksa (2023)" holding the 2024 film) is still found; a folder holding a foreign film's id is rejected, and a folder with no readable files falls through to title matching
- [ ] `folderOwnedExclusively` trusts a file that names OUR id over a disagreeing registered row, exactly as it already trusts the id over the folder's year for exclusion — otherwise a mis-titled folder blocks its rightful card forever
- [ ] Re-attaching to the film the key already names still rewrites the title (`applyMovieIdentity` is a no-op on the key only when `alsoSetTitle` is off)
- [ ] Cross-franchise veto: a 2014 Hobbit file is never attributed to the 2012 card even when it shares only ONE title word — the Polish name translates the subtitle, so `siblingRequestClaimsYear` (sibling request states the same year) is what vetoes it
- [ ] A lone one-word franchise with no sibling is NOT over-vetoed (no sibling claims the year ⇒ falls through to the old `>= 2` shared-word rule)
- [ ] Sibling-year veto is movies-only: two `series` seasons never take each other's files
- [ ] `libraryFolderYear` reads the year off a twin's folder (`Hobbit (2012)/`) — the only signal left for a release that states no year in its own name
- [ ] The 2012 Polish dub (`Hobbit Niezwykła podróż … Resetoff.pl.mp4`) appears on the 2012 card ONLY, not the 2014 or 2013 cards
- [ ] A bare media root (`Filmy/`) and an unyeared folder are NOT read as evidence (otherwise every flat file would be vetoed)
- [ ] `folderOwnedExclusively`: a folder whose name states the request's year RE-REGISTERS stale `media_files` rows instead of refusing, so the rightful card can rename `Hobbit (2014)/`
- [ ] Re-attaching to the key the row already holds does NOT 409 (the clash count excludes the row's own key)
- [ ] `siblingOwningYear` requires a shared title WORD with the folder, so an unrelated same-year film (Skyfall 2012) never claims a Hobbit file
- [ ] Fix Names and the processed panel veto on the SAME folder-year evidence (a file listed on the card is never refused as a rename proposal)
- [ ] A sibling's library folder is not listed as a candidate at all (no `Hobbit (2014)` row on the 2012 card)
- [ ] `nativeMovieLibraryFolders` falls back to IDENTITY when no name signal can reach a folder: a Polish-titled folder holding an id-less file (`Asterix i Obelix W sluzbie Jej Krolewskiej Mosci (2012)`) is found via a registered hardlink twin, so Fix Names proposes the FOLDER and not just the file. Deliberately last — it walks every library folder, so title/id matching still wins; a twin registered to another `library_key` is never claimed
- [ ] A file with an embedded id still blocks folder ownership even when the folder's year matches the request's
- [ ] `[EAC3 Atmos 5.1]` round-trips as itself (streaming Atmos ships as E-AC3, so Atmos is not TrueHD-only)
- [ ] A channel number never renders as `[Atmos 5.1]` — it lands on the nearest codec, or is dropped
- [ ] A bare `[Atmos]` never attaches to a non-TrueHD family (Soul's DTS must stay `[DTS-HD MA 7.1]`)
- [ ] A bare `[Atmos]` still merges into a TrueHD track regardless of token order (`...TrueHD.7.1.[Atmos]`)
- [ ] A probed codec does not inherit Atmos from another family's track (AAC 2.0 Polish dub stays `[AAC 2.0]`)
- [ ] version count excludes DOWNLOADING torrents from release_count and total_size_mb
