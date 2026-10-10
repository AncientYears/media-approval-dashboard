import axios from "axios";

const API_BASE = "/api";

export const api = axios.create({
  baseURL: API_BASE,
  headers: {
    "Content-Type": "application/json",
  },
});

export async function fetchRequests() {
  const response = await api.get("/requests");
  return response.data;
}

export async function fetchManaged() {
  const response = await api.get("/requests/managed");
  return response.data;
}

export async function syncSeerr() {
  const response = await api.post("/requests/seerr/sync");
  return response.data;
}

export async function fetchRequestProcessed(requestId: number) {
  const response = await api.get(`/requests/${requestId}/processed`);
  return response.data;
}

export async function fetchFranchise(sonarrId: number) {
  const response = await api.get(`/requests/managed/${sonarrId}`);
  return response.data;
}

export async function fetchFranchiseSeasons(sonarrId: number) {
  const response = await api.get(`/requests/managed/${sonarrId}/seasons`);
  return response.data;
}

export async function fetchReleases(requestId: number) {
  const response = await api.get(`/requests/${requestId}`);
  return response.data;
}

export async function fetchRequestEpisodes(requestId: number) {
  const response = await api.get(`/requests/${requestId}/episodes`);
  return response.data;
}

export async function fetchNativeFranchise(requestId: number) {
  const response = await api.get(`/requests/native-franchise/${requestId}`);
  return response.data;
}

export async function fetchNativeSeasonEpisodes(requestId: number, season: number) {
  const response = await api.get(`/requests/native-franchise/${requestId}/episodes`, { params: { season } });
  return response.data;
}

export async function refreshRequestMetadata(requestId: number) {
  const response = await api.post(`/requests/${requestId}/refresh-metadata`);
  return response.data;
}

export async function refreshNativeSeasonMetadata(requestId: number, season: number) {
  const response = await api.post(`/requests/native-franchise/${requestId}/refresh`, null, { params: { season } });
  return response.data;
}

export async function fixNativeIdentity(requestId: number) {
  const response = await api.post(`/requests/native-franchise/${requestId}/fix-identity`);
  return response.data;
}

/** Shows this franchise could be, for the explicit "Re-attach" control. The
 *  series mirror of `getIdentityCandidates`: needed so a card whose key was
 *  repaired while its stored title stayed localized can still be corrected. */
export async function getNativeIdentityCandidates(requestId: number, term?: string) {
  const response = await api.get(`/requests/native-franchise/${requestId}/identity-candidates`, {
    params: term ? { q: term } : {},
  });
  return response.data;
}

/** Apply the show the user picked. Unlike fix-identity this also rewrites the
 *  stored franchise `title`, which is the mangled input that caused the wrong
 *  identity in the first place. Mirrors `retitleMovie`. */
export async function retitleSeries(requestId: number, tmdbId: number) {
  const response = await api.post(`/requests/native-franchise/${requestId}/retitle`, { tmdbId });
  return response.data;
}

/** Movie counterpart: re-resolve this movie on TMDB and rewrite its
 *  library_key to a clean `movie:<slug>:<year>`. */
export async function fixMovieIdentity(requestId: number) {
  const response = await api.post(`/requests/${requestId}/fix-identity`);
  return response.data;
}

/** Films this card could be, for the explicit "Re-attach" control. Needed
 *  because fix-identity only returns a shortlist when it REFUSES to act, and a
 *  card whose key was repaired while its title stayed mangled would otherwise
 *  have no way to correct the title card matching still reads. */
export async function getIdentityCandidates(requestId: number, term?: string) {
  const response = await api.get(`/requests/${requestId}/identity-candidates`, {
    params: term ? { q: term } : {},
  });
  return response.data;
}

/** Apply the film the user picked from the identity shortlist. Unlike fix-identity
 *  this also rewrites the stored `title`, which is the mangled input that caused
 *  the wrong identity in the first place. */
export async function retitleMovie(requestId: number, tmdbId: number) {
  const response = await api.post(`/requests/${requestId}/retitle`, { tmdbId });
  return response.data;
}

/** TMDB languages offered for episode/movie titles. Shared by the franchise and
 *  the movie page so both offer exactly the same set. */
export const LANGUAGES = [
  "pl-PL", "en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "ru-RU", "uk-UA",
  "cs-CZ", "sk-SK", "hu-HU", "nl-NL", "sv-SE", "no-NO", "da-DK", "fi-FI", "ro-RO",
  "tr-TR", "el-GR", "he-IL", "ja-JP", "ko-KR", "zh-CN", "ar-SA",
];

export async function setFranchiseLanguage(requestId: number, language: string | null) {
  const response = await api.post(`/requests/${requestId}/set-language`, { language });
  return response.data;
}

/** The episode ORDERS (TMDB episode groups) this show has — production order,
 *  Disney+, Netflix … — plus the one in force (`current`). */
export async function getEpisodeOrders(requestId: number) {
  const response = await api.get(`/requests/${requestId}/episode-orders`);
  return response.data;
}

/** Set (`groupId`) or clear (`null`) the franchise's episode ORDER: which
 *  numbering TMDB uses for its episodes. The backend re-validates the group
 *  against this show and drops the cached seasons. */
export async function setFranchiseEpisodeOrder(requestId: number, groupId: string | null) {
  const response = await api.post(`/requests/${requestId}/episode-order`, { groupId });
  return response.data;
}

export async function approveRelease(requestId: number, releaseId: number, reason?: string) {
  const response = await api.post(`/requests/${requestId}/approve`, {
    releaseId,
    reason,
  });
  return response.data;
}

export async function importTorrent(requestId: number, params: { magnetUrl?: string; torrentFileBase64?: string; torrentFilename?: string; bypassApproval?: boolean }) {
  const response = await api.post(`/requests/${requestId}/import`, params);
  return response.data;
}

export async function searchAgain(requestId: number, params: Record<string, any>) {
  const response = await api.post(`/requests/${requestId}/search`, params);
  return response.data;
}

export async function cleanupStaleRequests() {
  const response = await api.post("/requests/cleanup");
  return response.data;
}

export async function cleanupDuplicates(dryRun = false) {
  const response = await api.post("/requests/cleanup-duplicates", { dryRun });
  return response.data;
}

export async function removeTitles(titles: string[]) {
  const response = await api.post("/requests/remove-titles", { titles });
  return response.data;
}

export async function importMissingRequests() {
  const response = await api.post("/requests/import-missing");
  return response.data;
}

export async function fetchTorrentStatus(requestId: number) {
  const response = await api.get(`/requests/${requestId}/torrent-status`);
  return response.data;
}

export async function fetchTorrentStatuses(requestId: number) {
  const response = await api.get(`/requests/${requestId}/torrent-statuses`);
  return response.data;
}

export async function fetchFranchiseTorrentStatuses(sonarrId: number) {
  const response = await api.get(`/requests/managed/${sonarrId}/torrent-statuses`);
  return response.data;
}

export async function moveToProcessed(requestId: number, releaseId?: number) {
  const response = await api.post(`/requests/${requestId}/move-to-processed`, { releaseId });
  return response.data;
}

export async function moveToWorkspace(requestId: number, releaseId?: number, workspaceIndex?: number, wsConfig?: { name?: string; notes?: string; scripts?: string[] }) {
  const response = await api.post(`/requests/${requestId}/move-to-workspace`, { releaseId, workspaceIndex, ...wsConfig });
  return response.data;
}

export async function fetchWorkspaces(requestId: number) {
  const response = await api.get(`/requests/${requestId}/workspaces`);
  return response.data;
}

export async function updateWorkspaceMetadata(requestId: number, workspaceIndex: number, data: { name?: string; notes?: string; status?: string; scripts?: string[] }) {
  const response = await api.patch(`/requests/${requestId}/workspaces/${workspaceIndex}`, data);
  return response.data;
}

export async function fetchWorkspaceScripts() {
  const response = await api.get(`/requests/workspace-scripts`);
  return response.data as { scripts: { id: string; label: string; description: string }[] };
}

export async function runWorkspaceScripts(requestId: number, workspaceIndex: number, scripts?: string[]) {
  const response = await api.post(`/requests/${requestId}/workspaces/${workspaceIndex}/run`, scripts ? { scripts } : {});
  return response.data as {
    success: boolean;
    results: { id: string; label: string; success: boolean; message: string; extracted?: string[]; errors?: string[] }[];
  };
}

export async function previewNormalizeProcessed() {
  const response = await api.get(`/requests/normalize-processed/preview`);
  return response.data as {
    processedDir: string;
    items: {
      file: string;
      source: string;
      destination: string;
      ownerRequestId: number;
      ownerTitle: string;
      season: number;
      evidence: "association" | "identity" | "name";
      warning: string | null;
    }[];
    staleIdentity: {
      dev: number;
      inode: number;
      path: string;
      tree: "processed" | "library";
      folder: string;
      season: number;
      claimedKey: string;
      claimedTitle: string;
      action: "repoint" | "clear";
      ownerKey: string | null;
      ownerTitle: string | null;
      evidence: string;
      warning: string | null;
    }[];
    skips: { file: string; source: string; reason: string }[];
  };
}

export async function applyNormalizeProcessed(
  files: string[],
  identities: { dev: number; inode: number }[] = [],
) {
  const response = await api.post(`/requests/normalize-processed/apply`, { files, identities });
  return response.data as {
    success: boolean;
    moved: { file: string; destination: string }[];
    failed: { file: string; error: string }[];
    identityApplied: { dev: number; inode: number; path: string; action: "repoint" | "clear"; ownerKey: string | null; error?: string }[];
    identityFailed: { dev: number; inode: number; path: string; action: "repoint" | "clear"; ownerKey: string | null; error?: string }[];
  };
}

export async function completeWorkspace(requestId: number, workspaceIndex: number) {
  const response = await api.post(`/requests/${requestId}/workspaces/${workspaceIndex}/complete`);
  return response.data;
}

export async function cleanWorkspaceInputs(requestId: number, workspaceIndex: number) {
  const response = await api.post(`/requests/${requestId}/workspaces/${workspaceIndex}/clean`);
  return response.data;
}

export async function deleteWorkspaceFile(requestId: number, workspaceIndex: number, subDir: "inputs" | "output", fileName: string) {
  const response = await api.delete(`/requests/${requestId}/workspaces/${workspaceIndex}/file/${subDir}/${encodeURIComponent(fileName)}`);
  return response.data;
}

export async function deleteWorkspace(requestId: number, workspaceIndex: number) {
  const response = await api.delete(`/requests/${requestId}/workspaces/${workspaceIndex}`);
  return response.data;
}

export async function fetchMoveStatus(requestId: number) {
  const response = await api.get(`/requests/${requestId}/move-status`);
  return response.data;
}

export async function fetchContentInfo(requestId: number, releaseId?: number) {
  const params = releaseId ? `?releaseId=${releaseId}` : '';
  const response = await api.get(`/requests/${requestId}/content-info${params}`);
  return response.data;
}

export async function moveToLibrary(requestId: number, fileName?: string) {
  const response = await api.post(`/requests/${requestId}/move-to-library`, { fileName });
  return response.data;
}

export async function deleteProcessedFile(requestId: number, fileName: string) {
  const response = await api.delete(`/requests/${requestId}/processed/${encodeURIComponent(fileName)}`);
  return response.data;
}

export async function scanProcessedDir(requestId: number) {
  const response = await api.post(`/requests/${requestId}/processed/scan`);
  return response.data;
}

export async function associateProcessedFiles(requestId: number, fileNames: string[]) {
  const response = await api.post(`/requests/${requestId}/processed/associate`, { fileNames });
  return response.data;
}

export async function processedToWorkspace(requestId: number, fileName: string, wsConfig?: { name?: string; notes?: string; scripts?: string[]; workspaceIndex?: number }) {
  const response = await api.post(`/requests/${requestId}/processed/${encodeURIComponent(fileName)}/to-workspace`, wsConfig || {});
  return response.data;
}

export async function fetchActiveWorkspaces() {
  const response = await api.get(`/requests/workspaces/active`);
  return response.data;
}

export async function processToLibrary(requestId: number, options?: { stripAudioTracks?: number[]; keepAudioTracks?: number[]; removeSubtitles?: boolean; audioCodec?: string }) {
  const response = await api.post(`/requests/${requestId}/process`, options || {});
  return response.data;
}

export async function dismissRequest(requestId: number, releaseId?: number) {
  const params = releaseId ? `?releaseId=${releaseId}` : "";
  const response = await api.post(`/requests/${requestId}/dismiss${params}`);
  return response.data;
}

export async function reactivateRequest(requestId: number) {
  const response = await api.post(`/requests/${requestId}/reactivate`);
  return response.data;
}

export async function reactivateAllRequests() {
  const response = await api.post("/requests/reactivate-all");
  return response.data;
}

export async function deleteDismissedRequests() {
  const response = await api.post("/requests/delete-dismissed");
  return response.data;
}

export async function deleteRequest(requestId: number, deleteFiles = false) {
  const response = await api.delete(`/requests/${requestId}`, { params: { deleteFiles } });
  return response.data;
}

export async function destroyRelease(requestId: number, releaseId: number, deleteFiles = false) {
  const response = await api.post(`/requests/${requestId}/destroy/${releaseId}`, { deleteFiles });
  return response.data;
}

export async function detectTorrents() {
  const response = await api.post("/requests/detect-torrents");
  return response.data;
}

export async function scanDownloads() {
  const response = await api.post("/requests/scan-downloads");
  return response.data;
}

export async function importLibrary() {
  const response = await api.post("/requests/import-library");
  return response.data;
}

export async function importLibraryNative(opts?: { apply?: boolean }) {
  const response = await api.post("/requests/import-library/native", opts || {});
  return response.data;
}

export async function scanDownloadDirs() {
  const response = await api.post("/requests/scan-download-dirs");
  return response.data;
}

export async function applyDownloadDirsActions(payload: {
  items: { path: string; action: "attach" | "link" | "hardlink-process" | "move-process" | "delete"; magnet?: string; torrentFileBase64?: string; torrentFilename?: string; force?: boolean }[];
}) {
  const response = await api.post("/requests/scan-download-dirs/apply", payload);
  return response.data;
}

export async function scanWorkspaces() {
  const response = await api.post("/requests/workspaces/scan");
  return response.data;
}

export async function cleanupWorkspaces(dirNames: string[]) {
  const response = await api.post("/requests/workspaces/cleanup", { dirNames });
  return response.data;
}

export async function viewDbTable(table: string, limit = 100, offset = 0) {
  const response = await api.get(`/requests/db/${table}?limit=${limit}&offset=${offset}`);
  return response.data;
}

export async function deleteFranchise(sonarrId: number) {
  const response = await api.delete(`/requests/managed/${sonarrId}`);
  return response.data;
}

export async function removeFromLibrary(requestId: number, fileName?: string) {
  const response = await api.post(`/requests/${requestId}/remove-from-library`, { fileName });
  return response.data;
}

export async function pauseTorrent(requestId: number | undefined, releaseId?: number) {
  if (requestId) {
    const params = releaseId ? `?releaseId=${releaseId}` : "";
    const response = await api.post(`/requests/${requestId}/torrent/pause${params}`);
    return response.data;
  }
  if (releaseId) {
    const response = await api.post(`/requests/0/torrent/pause?releaseId=${releaseId}`);
    return response.data;
  }
}

export async function resumeTorrent(requestId: number | undefined, releaseId?: number) {
  if (requestId) {
    const params = releaseId ? `?releaseId=${releaseId}` : "";
    const response = await api.post(`/requests/${requestId}/torrent/resume${params}`);
    return response.data;
  }
  if (releaseId) {
    const response = await api.post(`/requests/0/torrent/resume?releaseId=${releaseId}`);
    return response.data;
  }
}

export async function testConnections() {
  const response = await api.post("/test-connections");
  return response.data;
}

export async function fetchSettingsEnv() {
  const response = await api.get("/settings/env");
  return response.data;
}

export async function fetchNamingSettings() {
  const response = await api.get("/settings/naming");
  return response.data;
}

export async function saveNamingSettings(patch: Record<string, any>) {
  const response = await api.put("/settings/naming", patch);
  return response.data;
}

export async function searchAllSeasons(sonarrId: number, searchTerm?: string) {
  const response = await api.post(`/requests/managed/${sonarrId}/search-all`, { searchTerm });
  return response.data;
}

export async function searchAllMovies(searchTerm?: string) {
  const response = await api.post("/requests/managed/search-all-movies", { searchTerm });
  return response.data;
}

export async function fetchSettings() {
  const response = await api.get("/settings");
  return response.data;
}

export async function setRequestStatus(requestId: number, status: string) {
  const response = await api.post(`/requests/${requestId}/set-status`, { status });
  return response.data;
}

export async function fetchSeasonEpisodes(sonarrId: number, season: number) {
  const response = await api.get(`/requests/managed/${sonarrId}/season/${season}/episodes`);
  return response.data;
}

export async function fetchLibraryAudit() {
  const response = await api.get("/requests/library-audit");
  return response.data;
}

export async function adoptIntoProcessed(opts?: { apply?: boolean; includeUnbacked?: boolean; onlyMovies?: boolean; onlySeries?: boolean }) {
  const response = await api.post("/requests/adopt-into-processed", opts || {});
  return response.data;
}

export async function fixNamesPreview(requestId: number) {
  const response = await api.post(`/requests/${requestId}/fix-names/preview`);
  return response.data;
}

export async function fixNamesApply(requestId: number, paths: string[]) {
  const response = await api.post(`/requests/${requestId}/fix-names/apply`, { paths });
  return response.data;
}

export async function fixNamesPreviewNative(seedId: number, season: number) {
  const response = await api.post(`/requests/native-franchise/${seedId}/fix-names/preview`, { season });
  return response.data;
}

export async function fixNamesApplyNative(seedId: number, season: number, paths: string[]) {
  const response = await api.post(`/requests/native-franchise/${seedId}/fix-names/apply`, { season, paths });
  return response.data;
}

export async function ensureNativeSeason(seedId: number, season: number) {
  const response = await api.post(`/requests/native-franchise/${seedId}/ensure-season`, { season });
  return response.data;
}

export async function fetchUnmatched() {
  const response = await api.get("/requests/unmatched");
  return response.data;
}

export async function matchUnmatched(id: number, candidateIndex: number, season?: number) {
  const response = await api.post(`/requests/unmatched/${id}/match`, { candidateIndex, season });
  return response.data;
}

export async function skipUnmatched(id: number) {
  const response = await api.post(`/requests/unmatched/${id}/skip`);
  return response.data;
}

export async function discover(q: string) {
  const response = await api.get("/requests/discover", { params: { q } });
  return response.data;
}

export async function discoverTVSeasons(tmdbId: number) {
  const response = await api.get(`/requests/discover/tv/${tmdbId}/seasons`);
  return response.data;
}

export async function discoverRequest(payload: { type: "movie" | "series"; tmdbId: number; title: string; year: number | null; season?: number; seasons?: number[] }) {
  const response = await api.post("/requests/discover/request", payload);
  return response.data;
}

export async function fetchTorrents() {
  const response = await api.get("/requests/torrents");
  return response.data;
}

export async function torrentAction(hash: string, action: "start" | "stop" | "recheck" | "delete", deleteFiles = false) {
  const response = await api.post(`/requests/torrents/${encodeURIComponent(hash)}/${action}`, { deleteFiles });
  return response.data;
}

export async function scanTrackers() {
  const response = await api.get("/requests/trackers/scan");
  return response.data;
}

export async function restoreTrackers(items: { infoHash: string; type: "movie" | "series" }[]) {
  const response = await api.post("/requests/trackers/restore", { items });
  return response.data;
}

/** Link a fully-verified torrent to its best matching request (RC + AH). */
export async function linkTrackerTorrent(hash: string, type: "movie" | "series") {
  const response = await api.post("/requests/trackers/link", { hash, type });
  return response.data;
}

export async function moveOrphans(items: { path: string; type: "movie" | "series" }[]) {
  const response = await api.post("/requests/trackers/orphans/move", { items });
  return response.data;
}

/** Delete the redundant same-hash .torrent copies the scan reports (one copy per hash always survives). */
export async function removeDuplicateTrackers() {
  const response = await api.post("/requests/trackers/duplicates/remove");
  return response.data;
}
