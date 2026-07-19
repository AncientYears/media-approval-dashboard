import axios, { AxiosInstance } from "axios";

export interface TorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  num_seeds: number;
  num_leechs: number;
  ratio: number;
  save_path: string;
  content_path: string;
  added_on: number;
  completion_on: number;
  size: number;
  completed: number;
  category: string;
  tags: string;
}

export class QBittorrentService {
  private client: AxiosInstance;
  private sid: string | null = null;
  private user: string;
  private pass: string;

  constructor(baseURL: string, user: string, pass: string) {
    this.client = axios.create({
      baseURL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 5,
    });
    this.user = user;
    this.pass = pass;
  }

  async login(): Promise<void> {
    try {
      const response = await this.client.post(
        "/api/v2/auth/login",
        `username=${encodeURIComponent(this.user)}&password=${encodeURIComponent(this.pass)}`,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      const cookies = response.headers["set-cookie"];
      if (cookies) {
        const sidCookie = cookies.find((c: string) => c.startsWith("SID="));
        if (sidCookie) {
          this.sid = sidCookie.split(";")[0].split("=")[1];
        }
      }
      if (!this.sid) {
        console.warn("[qBittorrent] Login succeeded but no SID cookie found, will re-login as needed");
      }
    } catch (error) {
      console.error("[qBittorrent] Login failed:", error);
      throw error;
    }
  }

  private getHeaders() {
    return this.sid ? { Cookie: `SID=${this.sid}` } : {};
  }

  async ensureAuth() {
    if (!this.sid) await this.login();
  }

  async getTorrents(filter?: string): Promise<TorrentInfo[]> {
    await this.ensureAuth();
    try {
      const params: Record<string, string> = {};
      if (filter) params.filter = filter;
      const response = await this.client.get("/api/v2/torrents/info", {
        params,
        headers: this.getHeaders(),
      });
      return response.data as TorrentInfo[];
    } catch (error: any) {
      if (error?.response?.status === 403) {
        this.sid = null;
        await this.login();
        const response = await this.client.get("/api/v2/torrents/info", {
          params: filter ? { filter } : {},
          headers: this.getHeaders(),
        });
        return response.data as TorrentInfo[];
      }
      throw error;
    }
  }

  async getTorrentByHash(hash: string): Promise<TorrentInfo | null> {
    const torrents = await this.getTorrents();
    return torrents.find((t) => t.hash === hash) || null;
  }

  async findTorrentByTitle(title: string): Promise<TorrentInfo | null> {
    const torrents = await this.getTorrents();
    const normalized = title.toLowerCase().replace(/[.\-_\[\]]/g, " ");
    return (
      torrents.find((t) => {
        const tn = t.name.toLowerCase().replace(/[.\-_\[\]]/g, " ");
        return tn.includes(normalized) || normalized.includes(tn);
      }) || null
    );
  }

  async pauseTorrent(hash: string): Promise<void> {
    await this.ensureAuth();
    await this.client.post(
      "/api/v2/torrents/pause",
      `hashes=${hash}`,
      { headers: this.getHeaders() }
    );
  }

  async resumeTorrent(hash: string): Promise<void> {
    await this.ensureAuth();
    await this.client.post(
      "/api/v2/torrents/resume",
      `hashes=${hash}`,
      { headers: this.getHeaders() }
    );
  }

  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<void> {
    await this.ensureAuth();
    await this.client.post(
      "/api/v2/torrents/delete",
      `hashes=${hash}&deleteFiles=${deleteFiles}`,
      { headers: this.getHeaders() }
    );
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.login();
      await this.getTorrents();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}
