import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const MEDIA_DOWNLOADS_MOVIES = process.env.DOWNLOADS_MOVIES || "/media/Torrents/Download/Filmy";
const MEDIA_DOWNLOADS_TV = process.env.DOWNLOADS_TV || "/media/Torrents/Download/Serialy";
const PROCESSED_MOVIES = process.env.PROCESSED_MOVIES || "/media/Torrents/Processed/Filmy";
const PROCESSED_TV = process.env.PROCESSED_TV || "/media/Torrents/Processed/Serialy";
const PROCESSING_WORKSPACE = process.env.PROCESSING_WORKSPACE || "/media/Torrents/Workspace";

export interface ProcessResult {
  success: boolean;
  sourceFiles: string[];
  outputFiles: string[];
  method: "mkvmerge" | "ffmpeg" | "hardlink";
  error?: string;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function getMediaInfo(filePath: string): Promise<{ videoCodec: string; audioCodecs: string[]; subtitleCount: number } | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      filePath,
    ]);
    const info = JSON.parse(stdout);
    const videoCodec = (info.streams || []).find((s: any) => s.codec_type === "video")?.codec_name || "unknown";
    const audioCodecs = (info.streams || [])
      .filter((s: any) => s.codec_type === "audio")
      .map((s: any) => s.codec_name);
    const subtitleCount = (info.streams || []).filter((s: any) => s.codec_type === "subtitle").length;
    return { videoCodec, audioCodecs, subtitleCount };
  } catch {
    return null;
  }
}

function hardlinkFile(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return;
  try {
    fs.linkSync(src, dest);
  } catch (err: any) {
    if (err.code === "EXDEV") {
      fs.copyFileSync(src, dest);
    } else {
      throw err;
    }
  }
}

function hardlinkDirRecursive(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      hardlinkDirRecursive(srcPath, destPath);
    } else {
      hardlinkFile(srcPath, destPath);
    }
  }
}

export interface ProcessOptions {
  stripAudioTracks?: number[];
  keepAudioTracks?: number[];
  removeSubtitles?: boolean;
  extractAudio?: boolean;
  audioCodec?: string;
  videoCodec?: string;
  outputFile?: string;
}

export function getProcessedDir(type: "movie" | "series"): string {
  return type === "movie" ? PROCESSED_MOVIES : PROCESSED_TV;
}

export function getDownloadDir(type: "movie" | "series"): string {
  return type === "movie" ? MEDIA_DOWNLOADS_MOVIES : MEDIA_DOWNLOADS_TV;
}

export function moveToProcessedSync(sourcePath: string, type: "movie" | "series"): { success: boolean; destination?: string; error?: string } {
  const destDir = getProcessedDir(type);
  fs.mkdirSync(destDir, { recursive: true });

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const dest = path.join(destDir, path.basename(sourcePath));
    hardlinkDirRecursive(sourcePath, dest);
    return { success: true, destination: dest };
  }

  const dest = path.join(destDir, path.basename(sourcePath));
  if (fs.existsSync(dest)) {
    return { success: true, destination: dest };
  }
  hardlinkFile(sourcePath, dest);
  return { success: true, destination: dest };
}

export function moveToWorkspaceSync(sourcePath: string, requestId: number, title: string, jobIndex?: number): { success: boolean; destination?: string; error?: string } {
  const workspaceDir = createWorkspaceDir(requestId, title, jobIndex);
  const destDir = path.join(workspaceDir, "inputs");

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const dest = path.join(destDir, path.basename(sourcePath));
    hardlinkDirRecursive(sourcePath, dest);
    return { success: true, destination: dest };
  }

  const dest = path.join(destDir, path.basename(sourcePath));
  if (fs.existsSync(dest)) {
    return { success: true, destination: dest };
  }
  hardlinkFile(sourcePath, dest);
  return { success: true, destination: dest };
}

export function moveToLibrarySync(sourcePath: string, destDir: string): { success: boolean; destination?: string; method?: string; error?: string } {
  fs.mkdirSync(destDir, { recursive: true });

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const dest = path.join(destDir, path.basename(sourcePath));
    if (fs.existsSync(dest)) {
      return { success: true, destination: dest, method: "exists" };
    }
    hardlinkDirRecursive(sourcePath, dest);
    return { success: true, destination: dest, method: "hardlinked" };
  }

  const dest = path.join(destDir, path.basename(sourcePath));
  if (fs.existsSync(dest)) {
    return { success: true, destination: dest, method: "exists" };
  }
  hardlinkFile(sourcePath, dest);
  const method = fs.existsSync(dest) && fs.statSync(dest).nlink > 1 ? "hardlinked" : "copied";
  return { success: true, destination: dest, method };
}

export async function processFile(
  sourcePath: string,
  destDir: string,
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const sourceFiles: string[] = [];
  const outputFiles: string[] = [];

  if (!fs.existsSync(sourcePath)) {
    return { success: false, sourceFiles: [], outputFiles: [], method: "hardlink", error: `Source not found: ${sourcePath}` };
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(sourcePath).filter((e) => {
      const ext = path.extname(e).toLowerCase();
      return [".mkv", ".mp4", ".avi", ".mov", ".ts", ".flac", ".mp3", ".aac", ".ass", ".srt", ".sub"].includes(ext);
    });
    sourceFiles.push(...entries.map((e) => path.join(sourcePath, e)));
  } else {
    sourceFiles.push(sourcePath);
  }

  if (sourceFiles.length === 0) {
    return { success: false, sourceFiles: [], outputFiles: [], method: "hardlink", error: "No processable files found" };
  }

  fs.mkdirSync(destDir, { recursive: true });

  const hasMkvmerge = await commandExists("mkvmerge");
  const hasFfmpeg = await commandExists("ffmpeg");

  if (!hasMkvmerge && !hasFfmpeg) {
    for (const src of sourceFiles) {
      const dest = path.join(destDir, path.basename(src));
      hardlinkFile(src, dest);
      outputFiles.push(dest);
    }
    return { success: true, sourceFiles, outputFiles, method: "hardlink" };
  }

  const needsProcessing =
    options.stripAudioTracks?.length ||
    options.keepAudioTracks?.length ||
    options.removeSubtitles ||
    options.extractAudio ||
    options.audioCodec ||
    options.videoCodec;

  if (!needsProcessing) {
    for (const src of sourceFiles) {
      const dest = path.join(destDir, path.basename(src));
      hardlinkFile(src, dest);
      outputFiles.push(dest);
    }
    return { success: true, sourceFiles, outputFiles, method: "hardlink" };
  }

  for (const src of sourceFiles) {
    const ext = path.extname(src).toLowerCase();
    const base = path.basename(src, ext);
    const isVideo = [".mkv", ".mp4", ".avi", ".mov", ".ts"].includes(ext);
    const dest = path.join(destDir, `${base}${ext}`);

    if (!isVideo) {
      hardlinkFile(src, dest);
      outputFiles.push(dest);
      continue;
    }

    if (hasMkvmerge && (options.stripAudioTracks?.length || options.keepAudioTracks?.length || options.removeSubtitles)) {
      try {
        const args: string[] = ["-o", dest];

        if (options.keepAudioTracks && options.keepAudioTracks.length > 0) {
          args.push("--audio-tracks", options.keepAudioTracks.join(","));
        }
        if (options.stripAudioTracks && options.stripAudioTracks.length > 0) {
          const stripList = options.stripAudioTracks.join(",");
          args.push("--no-audio");
          args.push(src);
          const { stdout: infoOut } = await execFileAsync("mkvmerge", ["-J", src]);
          const info = JSON.parse(infoOut);
          const tracks = info.tracks || [];
          const audioTracks = tracks.filter((t: any) => t.type === "audio");
          const keepAudio = audioTracks
            .filter((_: any, i: number) => !options.stripAudioTracks!.includes(i))
            .map((t: any) => String(t.id));
          if (keepAudio.length > 0) {
            args.pop();
            args.push("--no-audio");
            args.push("--audio-tracks", keepAudio.join(","));
            args.push(src);
          }
        }
        if (options.removeSubtitles) {
          args.push("--no-subtitles");
        }
        if (!args.includes(src)) {
          args.push(src);
        }

        await execFileAsync("mkvmerge", args);
        outputFiles.push(dest);
        continue;
      } catch (err: any) {
        console.warn(`[Processor] mkvmerge failed for ${src}, falling back to ffmpeg: ${err.message}`);
      }
    }

    if (hasFfmpeg) {
      try {
        const args = ["-i", src, "-c", "copy"];

        if (options.audioCodec) {
          args.length = 0;
          args.push("-i", src, "-map", "0");
          const streams = await getMediaInfo(src);
          if (streams) {
            for (let i = 0; i < streams.audioCodecs.length; i++) {
              if (!options.stripAudioTracks?.includes(i)) {
                args.push("-c:a:" + i, options.audioCodec);
              }
            }
            args.push("-map", "-0:s");
          }
        }

        args.push("-y", dest);
        await execFileAsync("ffmpeg", args);
        outputFiles.push(dest);
        continue;
      } catch (err: any) {
        console.warn(`[Processor] ffmpeg failed for ${src}: ${err.message}`);
      }
    }

    hardlinkFile(src, dest);
    outputFiles.push(dest);
  }

  const method = options.stripAudioTracks?.length || options.keepAudioTracks?.length
    ? "mkvmerge"
    : options.audioCodec || options.videoCodec
      ? "ffmpeg"
      : "hardlink";

  return { success: true, sourceFiles, outputFiles, method };
}

export function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, ".").replace(/\.+/g, ".").replace(/^[.\s]+|[.\s]+$/g, "");
}

export function createWorkspaceDir(requestId: number, title: string, jobIndex?: number): string {
  const base = `${requestId}-${sanitizeName(title)}`;
  const dirName = jobIndex && jobIndex > 1 ? `${base}-${jobIndex}` : base;
  const workspaceDir = path.join(PROCESSING_WORKSPACE, dirName);
  fs.mkdirSync(path.join(workspaceDir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "output"), { recursive: true });
  return workspaceDir;
}

export function cleanupWorkspace(requestId: number, title: string): void {
  const dirName = `${requestId}-${sanitizeName(title)}`;
  const workspaceDir = path.join(PROCESSING_WORKSPACE, dirName);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {}
}

export interface WorkspaceInfo {
  index: number;
  name: string;
  path: string;
  inputCount: number;
}

export function listWorkspaces(requestId: number, title: string): WorkspaceInfo[] {
  const base = `${requestId}-${sanitizeName(title)}`;
  try {
    const entries = fs.readdirSync(PROCESSING_WORKSPACE, { withFileTypes: true });
    const matches: WorkspaceInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?$`));
      if (!m) continue;
      const index = m[1] ? parseInt(m[1]) : 1;
      const wsPath = path.join(PROCESSING_WORKSPACE, entry.name);
      const inputsDir = path.join(wsPath, "inputs");
      let inputCount = 0;
      try { inputCount = fs.readdirSync(inputsDir).length; } catch {}
      matches.push({ index, name: entry.name, path: wsPath, inputCount });
    }
    return matches.sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export function getNextWorkspaceIndex(requestId: number, title: string): number {
  const existing = listWorkspaces(requestId, title);
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((w) => w.index)) + 1;
}

export async function processToLibrary(
  sourcePath: string,
  destDir: string,
  options: ProcessOptions = {},
  requestId?: number,
  title?: string,
): Promise<ProcessResult> {
  const dirName = requestId && title
    ? `${requestId}-${sanitizeName(title)}`
    : `job-${Date.now()}`;
  const workspaceDir = path.join(PROCESSING_WORKSPACE, dirName);
  const workspaceInputs = path.join(workspaceDir, "inputs");
  const workspaceOut = path.join(workspaceDir, "output");

  fs.mkdirSync(workspaceInputs, { recursive: true });
  fs.mkdirSync(workspaceOut, { recursive: true });

  try {
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      hardlinkDirRecursive(sourcePath, workspaceInputs);
    } else {
      hardlinkFile(sourcePath, path.join(workspaceInputs, path.basename(sourcePath)));
    }

    const result = await processFile(workspaceInputs, workspaceOut, options);
    if (!result.success) return result;

    for (const src of result.outputFiles) {
      const rel = path.relative(workspaceOut, src);
      const dest = path.join(destDir, rel);
      hardlinkFile(src, dest);
    }

    return {
      ...result,
      outputFiles: result.outputFiles.map((f) => path.join(destDir, path.relative(workspaceOut, f))),
    };
  } finally {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {}
  }
}
