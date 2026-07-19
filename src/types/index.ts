// Media request status
export type MediaRequestStatus =
  | "NEW"
  | "SEARCHING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "DOWNLOADING"
  | "COMPLETED"
  | "REJECTED";

// Media type (movie or series)
export type MediaType = "movie" | "series";

// Media request interface
export interface MediaRequest {
  id: number;
  title: string;
  type: MediaType;
  radarr_id?: number;
  sonarr_id?: number;
  season?: number;
  status: MediaRequestStatus;
  requested_by: string[];
  created_at: string;
  updated_at: string;
  app_last_updated_at: string;
}

// Release candidate
export interface ReleaseCandidate {
  id: number;
  request_id: number;
  radarr_release_id: string;
  title: string;
  indexer: string;
  size_mb: number;
  radarr_quality: string;
  radarr_custom_formats: string[];
  radarr_rank: number;
  app_score: number;
  positive_attrs: string[];
  negative_attrs: string[];
  captured_at: string;
}

// Approval history
export interface ApprovalHistory {
  id: number;
  request_id: number;
  release_id: number;
  approved_at: string;
  approved_by: string;
  tweaked_params: Record<string, any>;
  approval_reason: string;
}

// Radarr search result
export interface RadarrSearchResult {
  guid: string;
  quality: { quality: { name: string; resolution: number; source: string; modifier: string } };
  customFormats: Array<{ name: string }>;
  customFormatScore: number;
  title: string;
  indexer: string;
  indexerId?: number;
  size: number;
  protocol: "torrent" | "usenet";
  language?: { id: number; name: string };
  languages?: Array<{ id: number; name: string }>;
  infoUrl?: string;
  seeders?: number;
  leechers?: number;
  releaseGroup?: string;
  edition?: string;
  publishDate?: string;
  age?: number;
  ageHours?: number;
  ageMinutes?: number;
  magnetUrl?: string;
  infoHash?: string;
}
