import { execFile } from "child_process";
import { promisify } from "util";
import type { ProbeInfo } from "../config/naming";

const execFileAsync = promisify(execFile);

/** Upper bound on collected audio streams. Real remuxes stay well under this
 *  (a multi-language disc has one track per language); it only stops a
 *  pathological file from inflating the JSON we hold in memory. */
const MAX_AUDIO_STREAMS = 64;

/**
 * Probe a video file with ffprobe and return the raw stream facts used by the
 * naming kernel (resolution, codecs, channel layout, bit depth, HDR flags).
 * Read-only, best-effort: returns null on any failure so callers fall back to
 * pure title inference. Landed for P1b — probing beats title-scraping.
 */
export async function probeVideoFile(filePath: string): Promise<ProbeInfo | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ], { timeout: 20000 });
    const info = JSON.parse(stdout);
    const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStreams = streams.filter((s) => s.codec_type === "audio");

    let video: ProbeInfo["video"] = null;
    if (videoStream) {
      const pixFmt: string = videoStream.pix_fmt || "";
      const bits =
        parseInt(videoStream.bits_per_raw_sample, 10) ||
        parseInt(videoStream.bits_per_sample, 10) ||
        (parseInt(pixFmt.match(/p(\d{1,2})le?/)?.[1] || "", 10) || null);

      const hdr: string[] = [];
      const sideData: any[] = Array.isArray(videoStream.side_data_list) ? videoStream.side_data_list : [];
      for (const sd of sideData) {
        const type = String(sd.type || "");
        if (/dolby ?vision|dovi/i.test(type)) addHdr(hdr, "DV");
        else if (/smpte ?st ?2094|hdr10\+/i.test(type)) addHdr(hdr, "HDR10+");
        else if (/smpte ?st ?2086|mastering ?display/i.test(type)) addHdr(hdr, "HDR10");
      }
      const transfer = String(videoStream.color_transfer || "");
      if (/smpte2084/i.test(transfer)) addHdr(hdr, "HDR10");
      else if (/arib-std-b67/i.test(transfer)) addHdr(hdr, "HLG");

      video = {
        codecName: videoStream.codec_name || null,
        width: videoStream.width ? Number(videoStream.width) : null,
        height: videoStream.height ? Number(videoStream.height) : null,
        bitDepth: bits,
        hdr,
      };
    }

    const audio: ProbeInfo["audio"] = [];
    for (const s of audioStreams) {
      if (s.disposition?.comment) continue;
      if (/commentary/i.test(String(s.tags?.title || ""))) continue;
      audio.push({
        codecName: s.codec_name || null,
        channels: s.channels ? Number(s.channels) : null,
        channelLayout: s.channel_layout || null,
        language: s.tags?.language || null,
        title: s.tags?.title || null,
      });
      // Generous but bounded. This used to stop at 4, which was harmless while
      // only the FIRST track was used (codec + channels) — but the language tag
      // reads every track, and a multi-language Blu-ray remux has one track per
      // language (The Lion King 1994 has 12). Truncating made an 8-language
      // remux look like "eng + one foreign" and it was tagged as a French dub.
      if (audio.length >= MAX_AUDIO_STREAMS) break;
    }

    if (!video && audio.length === 0) return null;
    return { video, audio };
  } catch {
    return null;
  }
}

function addHdr(list: string[], flag: string): void {
  if (!list.includes(flag)) list.push(flag);
}