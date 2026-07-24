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

export async function fetchTorrentStatus(requestId: number) {
  const response = await api.get(`/requests/${requestId}/torrent-status`);
  return response.data;
}

export async function fetchTorrentStatuses(requestId: number) {
  const response = await api.get(`/requests/${requestId}/torrent-statuses`);
  return response.data;
}

export async function moveToLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/move-to-library`);
  return response.data;
}

export async function dismissRequest(requestId: number, releaseId?: number) {
  const params = releaseId ? `?releaseId=${releaseId}` : "";
  const response = await api.post(`/requests/${requestId}/dismiss${params}`);
  return response.data;
}

export async function removeFromLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/remove-from-library`);
  return response.data;
}

export async function pauseTorrent(requestId: number, releaseId?: number) {
  const params = releaseId ? `?releaseId=${releaseId}` : "";
  const response = await api.post(`/requests/${requestId}/torrent/pause${params}`);
  return response.data;
}

export async function resumeTorrent(requestId: number, releaseId?: number) {
  const params = releaseId ? `?releaseId=${releaseId}` : "";
  const response = await api.post(`/requests/${requestId}/torrent/resume${params}`);
  return response.data;
}

export async function testConnections() {
  const response = await api.post("/test-connections");
  return response.data;
}

export async function fetchSettings() {
  const response = await api.get("/settings");
  return response.data;
}
