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

export async function fetchTorrentStatus(requestId: number) {
  const response = await api.get(`/requests/${requestId}/torrent-status`);
  return response.data;
}

export async function moveToLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/move-to-library`);
  return response.data;
}

export async function dismissRequest(requestId: number) {
  const response = await api.post(`/requests/${requestId}/dismiss`);
  return response.data;
}

export async function removeFromLibrary(requestId: number) {
  const response = await api.post(`/requests/${requestId}/remove-from-library`);
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
