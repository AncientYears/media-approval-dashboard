import axios, { AxiosInstance } from "axios";

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

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      baseURL,
      timeout: 120000,
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
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
      console.error("Prowlarr: Failed to search releases", error);
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.client.get("/api/v1/system/status");
      return { success: true };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }
}
