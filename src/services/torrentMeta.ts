// Minimal, dependency-free bencode reader: takes the bytes of a .torrent file
// and yields the metadata the recovery tool needs — the v1 info hash (sha1 of
// the raw `info` dict), the tracker announce list, and the file map
// (relative path + exact byte length per entry). The hash and the lengths are
// ground truth from the creator's side; everything else (names, matching) is
// best-effort.

import crypto from "crypto";

export interface TorrentFileEntry {
  /** Full relative path (single-file torrents: just the filename). */
  path: string;
  /** Exact byte length of this file, per the torrent's file list. */
  length: number;
}

export interface ParsedTorrent {
  /** Lower-case hex v1 info hash. */
  infoHash: string;
  /** info.name, decoded as UTF-8. */
  name: string;
  /** info["name.utf-8"], decoded. Publishers of some rips ship a DIFFERENT
   *  name here than in `name`, and qBittorrent (libtorrent) prefers this one —
   *  so it, not `name`, is what qBittorrent will look for on disk. */
  nameUtf8: string | null;
  /** announce + announce-list, de-duplicated. */
  announce: string[];
  /** "single" = a bare file in the save path; "folder" = the files sit under <name>/ */
  layout: "single" | "folder";
  pieceLength: number;
  pieceCount: number;
  totalSize: number;
  /** Every file the torrent claims, including 0-length padding entries. */
  files: TorrentFileEntry[];
  /** Raw 20-byte sha1 of the first piece — cheap ground truth for "does this
   *  file on disk actually hold this torrent's data?". */
  firstPieceHash: Buffer | null;
}

function asUtf8(latin1: string): string {
  return Buffer.from(latin1, "latin1").toString("utf8");
}

// Bencode value positions. Strings are read as latin1 so every byte survives
// round-trip (names/paths are decoded to UTF-8 at extraction time).
function decodeValue(buf: Buffer, pos: { i: number }): any {
  const b = buf[pos.i];
  if (b === 0x64) {
    pos.i++;
    const out: Record<string, any> = {};
    while (pos.i < buf.length && buf[pos.i] !== 0x65) {
      const key = decodeValue(buf, pos);
      out[key] = decodeValue(buf, pos);
    }
    pos.i++;
    return out;
  }
  if (b === 0x6c) {
    pos.i++;
    const out: any[] = [];
    while (pos.i < buf.length && buf[pos.i] !== 0x65) {
      out.push(decodeValue(buf, pos));
    }
    pos.i++;
    return out;
  }
  if (b === 0x69) {
    pos.i++;
    let s = "";
    while (pos.i < buf.length && buf[pos.i] !== 0x65) {
      s += String.fromCharCode(buf[pos.i]);
      pos.i++;
    }
    pos.i++;
    return parseInt(s, 10);
  }
  let lenStr = "";
  while (pos.i < buf.length && buf[pos.i] !== 0x3a) {
    lenStr += String.fromCharCode(buf[pos.i]);
    pos.i++;
  }
  pos.i++;
  const len = parseInt(lenStr, 10);
  if (!Number.isFinite(len) || len < 0 || pos.i + len > buf.length) {
    throw new Error("Malformed bencode string length");
  }
  const out = buf.toString("latin1", pos.i, pos.i + len);
  pos.i += len;
  return out;
}

/** Decode the torrent, capturing the raw `info` value bytes for the sha1. */
function decodeWithInfo(
  buf: Buffer,
  capture: (start: number, end: number) => void,
): { top: any; info: any } {
  const pos = { i: 0 };
  const top: any = decodeValue(buf, pos);
  if (typeof top !== "object" || Array.isArray(top) || typeof top.info === "undefined") {
    throw new Error("Not a bencode dict / missing info");
  }
  // Re-walk the top-level dict to find the exact byte span of the `info` value.
  // decodeValue above already consumed the buffer; the span is found by
  // re-decoding the same structure one level down, which is cheap (the info
  // dict is a handful of fields).
  let infoStart = -1;
  let infoEnd = -1;
  const pos2 = { i: 0 };
  const walk = () => {
    const b = buf[pos2.i];
    if (pos2.i >= buf.length) throw new Error("Truncated torrent");
    if (b === 0x64) {
      pos2.i++;
      while (buf[pos2.i] !== 0x65) {
        const key = decodeValue(buf, pos2);
        if (key === "info") {
          infoStart = pos2.i;
          decodeValue(buf, pos2);
          infoEnd = pos2.i;
        } else {
          decodeValue(buf, pos2);
        }
      }
      pos2.i++;
      return;
    }
    decodeValue(buf, pos2);
  };
  walk();
  if (infoStart < 0 || infoEnd <= infoStart) throw new Error("Could not locate info dict");
  capture(infoStart, infoEnd);
  return { top, info: top.info };
}

export function parseTorrentFile(buf: Buffer): ParsedTorrent {
  let rawInfo: Buffer | null = null;
  const { top } = decodeWithInfo(buf, (start: number, end: number) => {
    rawInfo = buf.subarray(start, end);
  });
  const info = top.info;
  const infoHash = crypto.createHash("sha1").update(rawInfo as unknown as Buffer).digest("hex");
  const name = asUtf8(String(info.name || ""));
  const nameUtf8Raw = info["name.utf-8"];
  const nameUtf8 = typeof nameUtf8Raw === "string" && nameUtf8Raw.length > 0 ? asUtf8(nameUtf8Raw) : null;

  const announce: string[] = [];
  const single = typeof top.announce === "string";
  if (single) announce.push(String(top.announce));
  const list = top["announce-list"];
  if (Array.isArray(list)) {
    for (const grp of list) {
      if (Array.isArray(grp)) {
        for (const a of grp) {
          const u = String(a);
          if (!announce.includes(u)) announce.push(u);
        }
      }
    }
  }

  const files: TorrentFileEntry[] = [];
  let totalSize = 0;
  const isFolder = Array.isArray(info.files) && info.files.length > 0;
  if (isFolder) {
    for (const f of info.files) {
      const segs = (Array.isArray(f.path) ? f.path : []).map((s: any) => asUtf8(String(s))).filter((s: string) => s.length > 0);
      const length = typeof f.length === "number" ? f.length : parseInt(String(f.length || "0"), 10) || 0;
      files.push({ path: (segs.length > 0 ? segs.join("/") : name) || name, length });
      totalSize += length;
    }
  } else if (typeof info.length === "number") {
    files.push({ path: name, length: info.length });
    totalSize = info.length;
  }

  const pieceLength = typeof info["piece length"] === "number" ? info["piece length"] : 0;
  const piecesStr = typeof info.pieces === "string" ? info.pieces : "";
  const firstPieceHash = piecesStr.length >= 20 ? Buffer.from(piecesStr.slice(0, 20), "latin1") : null;

  return {
    infoHash,
    name,
    nameUtf8,
    announce,
    layout: isFolder ? "folder" : "single",
    pieceLength,
    pieceCount: pieceLength > 0 ? Math.ceil(totalSize / pieceLength) : 0,
    totalSize,
    files,
    firstPieceHash,
  };
}