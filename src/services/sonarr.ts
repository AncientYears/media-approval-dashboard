import axios, { AxiosInstance } from "axios";
import { RadarrSearchResult } from "../types/index";

export class SonarrService {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  async getWantedSeries() {
    try {
      const response = await this.client.get("/api/v3/series", {
        params: { monitored: true },
      });
      return response.data.filter((s: any) => s.monitored);
    } catch (error) {
      console.error("Sonarr: Failed to fetch wanted series", error);
      throw error;
    }
  }

  async searchReleases(seriesId: number, seasonNumber: number, searchTerm?: string) {
    try {
      const response = await this.client.get("/api/v3/release", {
        params: {
          seriesId,
          seasonNumber,
          term: searchTerm,
        },
      });
      return response.data as RadarrSearchResult[];
    } catch (error) {
      console.error("Sonarr: Failed to search releases", error);
      throw error;
    }
  }

  async grabRelease(guid: string, indexerId: number) {
    try {
      const response = await this.client.post("/api/v3/release", {
        guid,
        indexerId,
      });
      return response.data;
    } catch (error) {
      console.error("Sonarr: Failed to grab release", error);
      throw error;
    }
  }

  async getSeries(seriesId: number) {
    try {
      const response = await this.client.get(`/api/v3/series/${seriesId}`);
      return response.data;
    } catch (error) {
      console.error("Sonarr: Failed to fetch series", error);
      throw error;
    }
  }

  async testConnection() {
    try {
      await this.client.get("/api/v3/system/status");
      return { success: true };
    } catch (error) {
      console.error("Sonarr: Connection test failed", error);
      return { success: false, error: String(error) };
    }
  }
}
