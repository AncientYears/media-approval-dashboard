import path from "path";
import dotenv from "dotenv";

// Must run before any process.env read below. server.ts cannot do this for us:
// TypeScript emits its `require` calls above `dotenv.config()`, so config/paths
// is already evaluated (with an empty env) by the time server.ts loads .env.
// This is the only module that reads env at load time; everything else reads it
// inside functions, which run long after this.
dotenv.config();

const trimTrailingSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const rawRoot = process.env.MEDIA_ROOT || "/media";
if (!path.isAbsolute(rawRoot)) {
  throw new Error(`MEDIA_ROOT must be an absolute path, got: ${rawRoot}`);
}

export const MEDIA_ROOT = trimTrailingSlash(rawRoot);

export const DOWNLOADS_MOVIES = process.env.DOWNLOADS_MOVIES || `${MEDIA_ROOT}/Torrents/download/filmy`;
export const DOWNLOADS_TV = process.env.DOWNLOADS_TV || `${MEDIA_ROOT}/Torrents/download/serialy`;
export const PROCESSED_MOVIES = process.env.PROCESSED_MOVIES || `${MEDIA_ROOT}/Torrents/processed/filmy`;
export const PROCESSED_TV = process.env.PROCESSED_TV || `${MEDIA_ROOT}/Torrents/processed/serialy`;
export const PROCESSING_WORKSPACE = process.env.PROCESSING_WORKSPACE || `${MEDIA_ROOT}/Torrents/Workspace`;
export const TRACKERS_DIR = process.env.TRACKERS_DIR || `${MEDIA_ROOT}/Torrents/Trackers`;
export const MEDIA_MOVIES = process.env.MEDIA_MOVIES || `${MEDIA_ROOT}/Filmy`;
export const MEDIA_TV = process.env.MEDIA_TV || `${MEDIA_ROOT}/Serialy`;

// Path mapping between qBittorrent's view of the storage and the app's.
// Leave both empty (the default, and the recommended setup) when both
// processes mount the shared storage at the same absolute path — the
// conversions below are then no-ops.
//
// Set them only when qBittorrent is containerised with a different mount
// point. Legacy setup: the app sees /media/Torrents while the qBittorrent
// container sees the same directory as /Torrents.
const QBIT_PATH_PREFIX = trimTrailingSlash(process.env.QBIT_PATH_PREFIX || "");
const QBIT_HOST_PREFIX = trimTrailingSlash(
  process.env.QBIT_HOST_PREFIX || (QBIT_PATH_PREFIX ? MEDIA_ROOT : "")
);

export function fromQBittorrentPath(qbitPath: string): string {
  if (!QBIT_PATH_PREFIX || !qbitPath) return qbitPath;
  if (qbitPath === QBIT_PATH_PREFIX) return QBIT_HOST_PREFIX;
  if (qbitPath.startsWith(QBIT_PATH_PREFIX + "/")) {
    return QBIT_HOST_PREFIX + qbitPath.slice(QBIT_PATH_PREFIX.length);
  }
  return qbitPath;
}

export function toQBittorrentPath(hostPath: string): string {
  if (!QBIT_PATH_PREFIX || !hostPath) return hostPath;
  if (hostPath === QBIT_HOST_PREFIX) return QBIT_PATH_PREFIX;
  if (hostPath.startsWith(QBIT_HOST_PREFIX + "/")) {
    return QBIT_PATH_PREFIX + hostPath.slice(QBIT_HOST_PREFIX.length);
  }
  return hostPath;
}
