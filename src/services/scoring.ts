const QUALITY_WEIGHTS: Record<string, number> = {
  "Remux-2160p": 10,
  "Bluray-2160p": 9,
  "BR-DISK": 9,
  "WEB-DL-2160p": 8,
  "WEBDL-2160p": 8,
  "WEBRip-2160p": 7,
  "WEBRIP-2160p": 7,
  "HDTV-2160p": 6,
  "Remux-1080p": 6,
  "Bluray-1080p": 5,
  "WEB-DL-1080p": 4,
  "WEBDL-1080p": 4,
  "WEBRip-1080p": 3,
  "WEBRIP-1080p": 3,
  "HDTV-1080p": 2,
  "WEB-DL-720p": 1,
  "CAM": 0,
  "TELESYNC": 0,
  "TELECINE": 0,
  "SCR": 0,
  "SDTV": 0,
};

export function computeAppScore(
  quality: string,
  customFormats: string[],
  sizeMb: number,
  radarrRank: number
): number {
  let score = 0;

  // Quality (0-10)
  let qualityScore = 0;
  for (const [key, weight] of Object.entries(QUALITY_WEIGHTS)) {
    if (quality.includes(key)) {
      qualityScore = weight;
      break;
    }
  }
  if (qualityScore === 0) {
    if (quality.includes("2160")) qualityScore = 7;
    else if (quality.includes("1080")) qualityScore = 4;
    else if (quality.includes("720")) qualityScore = 1;
  }
  score += qualityScore;

  // Custom formats bonus (0-5, +1 per CF up to 5)
  score += Math.min(5, customFormats.length);

  // Size sweet spot bonus (0-3)
  // Sweet spot for movies: 1-15 GB (1000-15000 MB)
  if (sizeMb >= 1000 && sizeMb <= 15000) score += 3;
  else if (sizeMb >= 500 && sizeMb <= 25000) score += 2;
  else if (sizeMb > 0) score += 1;

  // Radarr rank bonus (0-2) — higher rank = better
  if (radarrRank === 1) score += 2;
  else if (radarrRank <= 3) score += 1;

  return Math.min(20, score);
}
