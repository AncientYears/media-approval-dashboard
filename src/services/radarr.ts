import axios, { AxiosInstance } from "axios";
import { RadarrSearchResult } from "../types/index";

export class RadarrService {
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

  async getWantedMovies() {
    try {
      const response = await this.client.get("/api/v3/movie", {
        params: { monitored: true },
      });
      return response.data.filter((m: any) => m.monitored);
    } catch (error) {
      console.error("Radarr: Failed to fetch wanted movies", error);
      throw error;
    }
  }

  async searchReleases(movieId: number, searchTerm?: string) {
    try {
      const response = await this.client.get("/api/v3/release", {
        params: {
          movieId: movieId,
          term: searchTerm,
        },
      });
      return response.data as RadarrSearchResult[];
    } catch (error) {
      console.error("Radarr: Failed to search releases", error);
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
      console.error("Radarr: Failed to grab release", error);
      throw error;
    }
  }

  async getMovie(movieId: number) {
    try {
      const response = await this.client.get(`/api/v3/movie/${movieId}`);
      return response.data;
    } catch (error) {
      console.error("Radarr: Failed to fetch movie", error);
      throw error;
    }
  }

  async unmonitorMovie(movieId: number) {
    try {
      const movie = await this.getMovie(movieId);
      await this.client.put(`/api/v3/movie/${movieId}`, {
        ...movie,
        monitored: false,
      });
      console.log(`[Radarr] Unmonitored movie ${movieId}`);
    } catch (error) {
      console.error(`[Radarr] Failed to unmonitor movie ${movieId}:`, error);
      throw error;
    }
  }

  async deleteMovie(movieId: number, deleteFiles: boolean = false) {
    try {
      await this.client.delete(`/api/v3/movie/${movieId}`, {
        params: { deleteFiles, addImportListExclusion: true },
      });
      console.log(`[Radarr] Deleted movie ${movieId} (deleteFiles=${deleteFiles})`);
    } catch (error) {
      console.error(`[Radarr] Failed to delete movie ${movieId}:`, error);
      throw error;
    }
  }

  async testConnection() {
    try {
      await this.client.get("/api/v3/system/status");
      return { success: true };
    } catch (error) {
      console.error("Radarr: Connection test failed", error);
      return { success: false, error: String(error) };
    }
  }
}
