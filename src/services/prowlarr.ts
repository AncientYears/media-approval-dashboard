import axios, { AxiosInstance } from "axios";
import { errorSummary } from "../utils/errorSummary";

export interface ProwlarrRelease {
  guid: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
  indexerId: number;
  downloadUrl: string;
  magnetUri: string;
  infoUrl: string;
  infoHash: string;
  publishDate: string;
  protocol: string;
  category: number[];
  fileName: string;
}

export class ProwlarrService {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL,
      timeout: 45000,
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  /** Fetch the .torrent bytes behind a Prowlarr `downloadUrl` (the proxy URL
   *  Prowlarr hands back for indexers that publish no magnet/infoHash, e.g.
   *  private trackers). The URL is absolute and already carries the apikey. */
  async downloadTorrent(url: string): Promise<Buffer> {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 45000,
      maxRedirects: 5,
      headers: { "X-Api-Key": this.apiKey },
    });
    return Buffer.from(response.data);
  }

  async search(query: string, categories?: number[], type: string = "search"): Promise<ProwlarrRelease[]> {
    try {
      const params: any = { query, type };
      if (categories && categories.length > 0) {
        // Prowlarr expects multiple 'categories' params
        params.categories = categories;
      }

      const response = await this.client.get("/api/v1/search", { params });
      return response.data as ProwlarrRelease[];
    } catch (error) {
      console.error(`[Prowlarr] Failed to search releases: ${errorSummary(error)}`);
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.client.get("/api/v1/system/status");
      return { success: true };
    } catch (error) {
      return { success: false, message: errorSummary(error) };
    }
  }
}
