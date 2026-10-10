import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

/**
 * Workspace scripts are named, built-in post-move steps a user can attach to a
 * workspace when it is created (and edit later). They operate ONLY on the
 * workspace (inputs/ -> output/) — never on /download, which qBittorrent seeds
 * from forever, and never as a TorrentPanel button, because a torrent panel is
 * not a workspace. The same set is exposed to the frontend via
 * GET /api/requests/workspace-scripts so the dropdown is not duplicated here
 * and in the UI.
 */
export interface WorkspaceScriptDef {
  id: string;
  label: string;
  description: string;
}

export const WORKSPACE_SCRIPTS: WorkspaceScriptDef[] = [
  {
    id: "extract-archives",
    label: "Extract archives",
    description:
      "Unpack split-RAR / 7z / zip archives from inputs/ into output/ (requires 7z/p7zip or unrar).",
  },
];

export interface ScriptRunResult {
  id: string;
  label: string;
  success: boolean;
  message: string;
  extracted?: string[];
  errors?: string[];
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function findExtractor(): Promise<{ tool: string; kind: "7z" | "unrar" } | null> {
  // 7z is preferred: it handles rar, 7z and zip in one tool.
  for (const tool of ["7z", "7za", "7zr"]) {
    if (await commandExists(tool)) return { tool, kind: "7z" };
  }
  for (const tool of ["unrar", "unrar-free"]) {
    if (await commandExists(tool)) return { tool, kind: "unrar" };
  }
  return null;
}

/**
 * A first volume is what an extractor is fed — never the continuations. The
 * shapes: old scene `.rar` + `.r00`/`.r01`…; the multi-volume `.partN.rar`
 * (part 1/part 01); 7z splits `.7z.001`; a plain `.7z`/`.zip`; and the generic
 * numbered split `.001`. `.r00` and higher `.partN.rar` are continuations and
 * are deliberately rejected, or the extractor would run N times over one set.
 */
export function isFirstArchivePart(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\.part0*1\.rar$/.test(lower)) return true;
  if (/\.rar$/.test(lower) && !/\.part\d+\.rar$/.test(lower)) return true;
  if (/\.7z\.001$/.test(lower)) return true;
  if (/\.7z$/.test(lower)) return true;
  if (/\.zip$/.test(lower)) return true;
  if (/\.001$/.test(lower) && !/\.7z\.001$/.test(lower)) return true;
  return false;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * Scene archives usually wrap their contents in one top-level folder. The
 * processed panel only reads video files DIRECTLY inside the season dir, so a
 * lone wrapper folder would hide the extracted file after Complete & Import.
 * Collapse exactly one wrapper directory; anything else (several folders, or
 * files already at the root) is left untouched rather than merged and risked.
 */
function collapseSingleWrapper(outputDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(outputDir, { withFileTypes: true });
  } catch {
    return;
  }
  const visible = entries.filter((e) => !e.name.startsWith("."));
  if (visible.length !== 1 || !visible[0].isDirectory()) return;
  const wrapper = path.join(outputDir, visible[0].name);
  for (const child of fs.readdirSync(wrapper)) {
    fs.renameSync(path.join(wrapper, child), path.join(outputDir, child));
  }
  try {
    fs.rmdirSync(wrapper);
  } catch {}
}

async function runExtractArchives(wsPath: string): Promise<ScriptRunResult> {
  const def = WORKSPACE_SCRIPTS.find((s) => s.id === "extract-archives")!;
  const inputsDir = path.join(wsPath, "inputs");
  const outputDir = path.join(wsPath, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const files = listFilesRecursive(inputsDir);
  const firstParts = files.filter((f) => isFirstArchivePart(path.basename(f)));
  if (firstParts.length === 0) {
    return { id: def.id, label: def.label, success: false, message: "No archive files found in inputs/" };
  }

  const extractor = await findExtractor();
  if (!extractor) {
    return {
      id: def.id,
      label: def.label,
      success: false,
      message: "No extraction tool found — install 7z/p7zip or unrar on the server",
    };
  }

  const extracted: string[] = [];
  const errors: string[] = [];
  for (const part of firstParts) {
    const base = path.basename(part);
    try {
      if (extractor.kind === "7z") {
        await execFileAsync(extractor.tool, ["x", "-y", `-o${outputDir}`, part], { maxBuffer: 128 * 1024 * 1024 });
      } else {
        // unrar x writes into the given directory (trailing separator required).
        await execFileAsync(extractor.tool, ["x", "-o+", part, outputDir + path.sep], { maxBuffer: 128 * 1024 * 1024 });
      }
      extracted.push(base);
    } catch (err: any) {
      const raw = `${err?.stderr || ""}\n${err?.stdout || ""}`.trim() || String(err?.message || err);
      const lc = raw.toLowerCase();
      let reason = "extraction failed";
      if (lc.includes("password") || lc.includes("encrypted") || lc.includes("wrong password")) {
        reason = "password-protected archive";
      } else if (lc.includes("cannot open") || lc.includes("volume") || lc.includes("missing") || lc.includes("unexpected end")) {
        reason = "missing or incomplete archive volume(s)";
      } else if (raw) {
        reason = raw.split("\n").slice(-3).join(" ").slice(0, 300);
      }
      errors.push(`${base}: ${reason}`);
    }
  }

  if (extracted.length > 0) collapseSingleWrapper(outputDir);

  if (extracted.length === 0) {
    return { id: def.id, label: def.label, success: false, message: "All archives failed to extract", errors };
  }
  const parts = errors.length > 0 ? ` (${errors.length} failed)` : "";
  return {
    id: def.id,
    label: def.label,
    success: true,
    message: `Extracted ${extracted.length} archive${extracted.length !== 1 ? "s" : ""} into output/${parts}`,
    extracted,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/** Run the named scripts against a workspace, in order, returning per-script results. */
export async function runWorkspaceScripts(scriptIds: string[], wsPath: string): Promise<ScriptRunResult[]> {
  const results: ScriptRunResult[] = [];
  for (const id of scriptIds) {
    const def = WORKSPACE_SCRIPTS.find((s) => s.id === id);
    if (!def) {
      results.push({ id, label: id, success: false, message: "Unknown script" });
      continue;
    }
    if (id === "extract-archives") {
      results.push(await runExtractArchives(wsPath));
    } else {
      results.push({ id, label: def.label, success: false, message: "Script not implemented" });
    }
  }
  return results;
}
