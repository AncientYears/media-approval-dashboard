import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
import { mergeDottedAbbreviations } from "../utils/dottedAbbrev";

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
  uploaded: number;
  seeding_time: number;
  save_path: string;
  content_path: string;
  added_on: number;
  completion_on: number;
  size: number;
  completed: number;
  category: string;
  tags: string;
  eta: number;
}

/** qBittorrent's session cookie is named `SID` up to 5.1 and `QBT_SID_<port>`
 *  from 5.2 (the port suffix makes it instance-specific; the rename is upstream
 *  commit 753fb80 and is not configurable back). The login reply is `200 Ok.`
 *  before 5.2 but `204 No Content` from 5.2, so the cookie is the only success
 *  signal there. The FULL `name=value` pair is kept, because qBittorrent looks up
 *  the exact cookie NAME — sending `SID=…` when it expects `QBT_SID_8080` is a
 *  403 with a valid-looking login. */
function extractSessionCookie(setCookie: string[] | string | undefined): string | null {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const m = /^\s*(?:QBT_SID_\d+|SID)=[^;]+/.exec(c);
    if (m) return m[0].trim();
  }
  return null;
}

export class QBittorrentService {
  private client: AxiosInstance;
  private cookie: string | null = null;
  private user: string;
  private pass: string;

  constructor(baseURL: string, user: string, pass: string) {
    // qBittorrent >= 4.6 enables CSRF protection by default and rejects requests
    // whose Origin/Referer does not match the WebUI host ("Origin header & Target
    // origin mismatch"), so both are sent on every call. Set here, not just on
    // login: the session cookie alone is not enough with CSRF on.
    const origin = baseURL.replace(/\/+$/, "");
    this.client = axios.create({
      baseURL: origin,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Referer: origin + "/",
      },
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
      this.cookie = extractSessionCookie(cookies);
      if (!this.cookie) {
        // No cookie is set when the client is on a WebUI auth-bypass subnet;
        // those requests authenticate by IP and still succeed, so this is only a
        // warning. A genuinely failed login is a non-2xx status and throws above.
        console.warn("[qBittorrent] Login succeeded but no session cookie was returned");
      }
    } catch (error) {
      console.error("[qBittorrent] Login failed:", error);
      throw error;
    }
  }

  private getHeaders() {
    return this.cookie ? { Cookie: this.cookie } : {};
  }

  async ensureAuth() {
    if (!this.cookie) await this.login();
  }

  private async post(url: string, data: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.client.post(url, data, { headers: this.getHeaders() });
    } catch (error: any) {
      console.error(`[qBittorrent] POST ${url} failed:`, error?.response?.status, error?.response?.data || error.message);
      if (error?.response?.status === 403) {
        this.cookie = null;
        await this.login();
        await this.client.post(url, data, { headers: this.getHeaders() });
      } else {
        throw error;
      }
    }
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
        this.cookie = null;
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
    const normalized = mergeDottedAbbreviations(title.toLowerCase()).replace(/[.\-_\[\]]/g, " ");
    return (
      torrents.find((t) => {
        const tn = mergeDottedAbbreviations(t.name.toLowerCase()).replace(/[.\-_\[\]]/g, " ");
        return tn.includes(normalized) || normalized.includes(tn);
      }) || null
    );
  }

  async pauseTorrent(hash: string): Promise<void> {
    await this.post("/api/v2/torrents/stop", `hashes=${hash}`);
  }

  async resumeTorrent(hash: string): Promise<void> {
    await this.post("/api/v2/torrents/start", `hashes=${hash}`);
  }

  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<void> {
    await this.post("/api/v2/torrents/delete", `hashes=${hash}&deleteFiles=${deleteFiles}`);
  }

  async exportTorrent(hash: string): Promise<Buffer | null> {
    await this.ensureAuth();
    try {
      const response = await this.client.get("/api/v2/torrents/export", {
        params: { hash },
        headers: this.getHeaders(),
        responseType: "arraybuffer",
      });
      return Buffer.from(response.data);
    } catch (error: any) {
      console.error(`[qBittorrent] Export torrent failed for ${hash}:`, error?.response?.status || error.message);
      return null;
    }
  }

  async getTrackers(hash: string): Promise<{ url: string; status: string }[]> {
    await this.ensureAuth();
    try {
      const response = await this.client.get("/api/v2/torrents/trackers", {
        params: { hash },
        headers: this.getHeaders(),
      });
      return (response.data as any[]).filter((t: any) => t.url && !t.url.startsWith("**")).map((t: any) => ({ url: t.url, status: t.status === 0 ? "working" : t.status === 1 ? "updating" : t.status === 2 ? "disabled" : "error" }));
    } catch (error: any) {
      console.error(`[qBittorrent] Get trackers failed for ${hash}:`, error?.response?.status || error.message);
      return [];
    }
  }

  async addTorrent(urls: string, savePath?: string, category?: string): Promise<void> {
    let data = `urls=${encodeURIComponent(urls)}`;
    if (savePath) data += `&savepath=${encodeURIComponent(savePath)}`;
    if (category) data += `&category=${encodeURIComponent(category)}`;
    await this.post("/api/v2/torrents/add", data);
  }

  async addTorrentFile(
    buffer: Buffer,
    filename: string,
    savePath?: string,
    opts?: { paused?: boolean; skipCheck?: boolean; category?: string; rename?: string },
  ): Promise<void> {
    await this.ensureAuth();
    const form = new FormData();
    form.append("torrents", buffer, { filename, contentType: "application/x-bittorrent" });
    if (savePath) form.append("savepath", savePath);
    if (opts?.category) form.append("category", opts.category);
    if (opts?.paused) form.append("paused", "true");
    if (opts?.rename) form.append("rename", opts.rename);
    // skipCheck defaults to false = qBittorrent verifies the placed files.
    if (opts?.skipCheck) form.append("skip_checking", "true");
    try {
      await this.client.post("/api/v2/torrents/add", form, {
        headers: { ...this.getHeaders(), ...form.getHeaders() },
      });
    } catch (error: any) {
      if (error?.response?.status === 403) {
        this.cookie = null;
        await this.login();
        await this.client.post("/api/v2/torrents/add", form, {
          headers: { ...this.getHeaders(), ...form.getHeaders() },
        });
      } else {
        throw error;
      }
    }
  }

  /** Force qBittorrent to re-hash the on-disk files for the given torrent(s). */
  async recheck(hash: string): Promise<void> {
    await this.post("/api/v2/torrents/recheck", `hashes=${encodeURIComponent(hash)}`);
  }

  /** Set the download priority of specific file indexes (0 = skip). qBittorrent
   *  counts only *wanted* files toward 100%, so a restore that legitimately
   *  lacks sidecar files (nfo/txt/jpg) can still recheck to verified by
   *  dropping them out of the wanted set. `fileIndexes` are the 0-based
   *  positions in the torrent's file list. */
  async setFilePrio(hash: string, fileIndexes: number[], prio: number): Promise<void> {
    if (fileIndexes.length === 0) return;
    await this.post(
      "/api/v2/torrents/filePrio",
      `hash=${encodeURIComponent(hash)}&id=${fileIndexes.join(",")}&prio=${prio}`,
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
