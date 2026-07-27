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

export async function fetchRequestProcessed(requestId: number) {
  const response = await api.get(`/requests/${requestId}/processed`);
  return response.data;
}

export async function fetchFranchise(sonarrId: number) {
  const response = await api.get(`/requests/managed/${sonarrId}`);
  return response.data;
}

export async function fetchReleases(requestId: number) {
  const response = await api.get(`/requests/${requestId}`);
  return response.data;
}

export async function approveRelease(requestId: number, releaseId: number, reason?: string) {
  const response = await api.post(`/requests/${requestId}/approve`, {
    releaseId,
    reason,
  });
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

export async function updateWorkspaceMetadata(requestId: number, workspaceIndex: number, data: { name?: string; notes?: string; status?: string }) {
  const response = await api.patch(`/requests/${requestId}/workspaces/${workspaceIndex}`, data);
  return response.data;
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

export async function moveToLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/move-to-library`);
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

export async function deleteRequest(requestId: number) {
  const response = await api.delete(`/requests/${requestId}`);
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

export async function viewDbTable(table: string, limit = 100, offset = 0) {
  const response = await api.get(`/requests/db/${table}?limit=${limit}&offset=${offset}`);
  return response.data;
}

export async function deleteFranchise(sonarrId: number) {
  const response = await api.delete(`/requests/managed/${sonarrId}`);
  return response.data;
}

export async function removeFromLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/remove-from-library`);
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
