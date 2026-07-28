import axios, { AxiosInstance } from "axios";
import { RadarrSearchResult } from "../types/index";

export interface WantedSeason {
  seriesId: number;
  seasonNumber: number;
  title: string;
  seriesPath: string;
  episodeCount: number;
}

export class SonarrService {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      baseURL,
      timeout: 45000,
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  async getWantedMissing(): Promise<WantedSeason[]> {
    try {
      const allRecords: any[] = [];
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const response = await this.client.get("/api/v3/wanted/missing", {
          params: {
            sortKey: "airDateUtc",
            includeSeries: true,
            monitored: true,
            page,
            pageSize: 100,
          },
        });
        allRecords.push(...(response.data.records || []));
        totalPages = Math.ceil((response.data.totalRecords || 0) / 100);
        page++;
      }

      // Group by seriesId + seasonNumber
      const seasonMap = new Map<string, WantedSeason>();
      for (const ep of allRecords) {
        const key = `${ep.seriesId}-${ep.seasonNumber}`;
        if (!seasonMap.has(key)) {
          const seriesTitle = ep.series?.title || `Series ${ep.seriesId}`;
          const seriesPath = ep.series?.path || "";
          seasonMap.set(key, {
            seriesId: ep.seriesId,
            seasonNumber: ep.seasonNumber,
            title: seriesTitle,
            seriesPath,
            episodeCount: 0,
          });
        }
        seasonMap.get(key)!.episodeCount++;
      }

      return Array.from(seasonMap.values());
    } catch (error) {
      console.error("Sonarr: Failed to fetch wanted missing episodes", error);
      throw error;
    }
  }

  async searchReleases(seriesId: number, seasonNumber: number, searchTerm?: string) {
    try {
      const params: any = { seriesId, seasonNumber };
      if (searchTerm) params.term = searchTerm;
      const response = await this.client.get("/api/v3/release", { params });
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
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log(`[Sonarr] Series ${seriesId} not found (404)`);
        throw error;
      }
      console.error(`[Sonarr] Failed to fetch series ${seriesId}:`, error.message || error);
      throw error;
    }
  }

  async getAllSeries() {
    try {
      const response = await this.client.get("/api/v3/series");
      return response.data;
    } catch (error) {
      console.error("Sonarr: Failed to fetch all series", error);
      throw error;
    }
  }

  async unmonitorSeason(seriesId: number, seasonNumber: number) {
    try {
      const series = await this.getSeries(seriesId);
      const seasons = series.seasons || [];
      const target = seasons.find((s: any) => s.seasonNumber === seasonNumber);
      if (target) {
        target.monitored = false;
      }
      await this.client.put(`/api/v3/series/${seriesId}`, {
        ...series,
        seasons,
      });
      console.log(`[Sonarr] Unmonitored season ${seasonNumber} of series ${seriesId}`);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log(`[Sonarr] Series ${seriesId} already deleted from Sonarr, skipping unmonitor`);
        return;
      }
      console.error(`[Sonarr] Failed to unmonitor season ${seasonNumber} of series ${seriesId}:`, error.message || error);
      throw error;
    }
  }

  async deleteSeries(seriesId: number, deleteFiles: boolean = false) {
    try {
      await this.client.delete(`/api/v3/series/${seriesId}`, {
        params: { deleteFiles, addImportListExclusion: true },
      });
      console.log(`[Sonarr] Deleted series ${seriesId} (deleteFiles=${deleteFiles})`);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log(`[Sonarr] Series ${seriesId} already deleted from Sonarr`);
        return;
      }
      console.error(`[Sonarr] Failed to delete series ${seriesId}:`, error.message || error);
      throw error;
    }
  }

  async getQualityProfiles() {
    const response = await this.client.get("/api/v3/qualityprofile");
    return response.data as Array<{ id: number; name: string }>;
  }

  async getRootFolders() {
    const response = await this.client.get("/api/v3/rootfolder");
    return response.data as Array<{ path: string; id: number }>;
  }

  async lookupSeries(term: string) {
    const response = await this.client.get("/api/v3/series/lookup", {
      params: { term },
    });
    return response.data as any[];
  }

  async addSeries(seriesData: any) {
    const response = await this.client.post("/api/v3/series", seriesData);
    return response.data as { id: number; title: string };
  }

  async getSeasonEpisodes(seriesId: number, seasonNumber: number) {
    try {
      const response = await this.client.get("/api/v3/episode", {
        params: { seriesId, seasonNumber },
      });
      return response.data as Array<{
        id: number;
        episodeNumber: number;
        title: string;
        hasFile: boolean;
        airDateUtc?: string;
        overview?: string;
      }>;
    } catch (error) {
      console.error(`[Sonarr] Failed to fetch episodes for series ${seriesId} season ${seasonNumber}:`, error);
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

  async scanDownloadedEpisodes(path?: string, seriesId?: number) {
    try {
      const body: any = { name: "DownloadedEpisodesScan" };
      if (path) body.downloadClientTvPath = path;
      if (seriesId) body.seriesId = seriesId;
      await this.client.post("/api/v3/command", body);
      return { success: true };
    } catch (error) {
      console.error("Sonarr: scanDownloadedEpisodes failed", error);
      return { success: false, error: String(error) };
    }
  }

  async refreshSeries(seriesId: number) {
    try {
      await this.client.post("/api/v3/command", { name: "RefreshSeries", seriesIds: [seriesId] });
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async manualImport(filePath: string, seriesId: number, seasonNumber: number) {
    try {
      // Get episode IDs for this season to include in the import
      let episodeIds: number[] = [];
      try {
        const episodes = await this.getSeasonEpisodes(seriesId, seasonNumber);
        episodeIds = episodes.map((e: any) => e.id);
      } catch {}

      await this.client.post("/api/v3/command", {
        name: "ManualImport",
        importMode: "copy",
        files: [{
          path: filePath,
          seriesId,
          seasonNumber,
          ...(episodeIds.length > 0 ? { episodeIds } : {}),
        }],
      });
      // Force Sonarr to re-scan after import
      await this.refreshSeries(seriesId);
      console.log(`[Sonarr] manualimport: triggered import for ${filePath}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[Sonarr] manualimport failed for ${filePath}:`, error.message || error);
      return { success: false, error: error.message };
    }
  }
}
