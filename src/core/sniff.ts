import { open } from "node:fs/promises";
import type { MediaKind } from "../types/results.js";

/**
 * Identify a file by its contents rather than its name.
 *
 * Extensions are a hint, not a fact. Two byte patterns in particular cannot be
 * resolved by name alone once the format list is open-ended:
 *
 * - `RIFF` containers are WebP (an image) or AVI (a video).
 * - ISO base media containers are AVIF/HEIC (images) or MP4/MOV (videos),
 *   distinguished only by the brand recorded at offset 8.
 *
 * Sniffing is not run over every discovered file: sharp and ffmpeg both detect
 * their input's real format, so an ordinary mislabelled file already works.
 * It is used where the name genuinely fails us — an unknown or absent
 * extension — and again after a decode failure, to turn "unrecognised data"
 * into "this .jpg is actually an MP4".
 */

export interface SniffResult {
  readonly kind: MediaKind;
  /** Short human-facing format name, e.g. "PNG" or "Matroska". */
  readonly format: string;
}

/** Enough for an ISO-BMFF brand and a leading XML declaration. */
const HEADER_BYTES = 4096;

export async function sniffFile(path: string): Promise<SniffResult | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }

  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return sniff(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function sniff(bytes: Buffer): SniffResult | null {
  if (bytes.length < 4) return null;

  // --- unambiguous image signatures ---
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "image", format: "PNG" };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", format: "JPEG" };
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))
    return { kind: "image", format: "GIF" };
  if (
    starts(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    starts(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  )
    return { kind: "image", format: "TIFF" };
  if (ascii(bytes, 0, "BM")) return { kind: "image", format: "BMP" };
  if (ascii(bytes, 0, "8BPS")) return { kind: "image", format: "Photoshop" };
  if (starts(bytes, [0xff, 0x0a])) return { kind: "image", format: "JPEG XL" };
  if (starts(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20]))
    return { kind: "image", format: "JPEG XL" };
  if (starts(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]))
    return { kind: "image", format: "JPEG 2000" };

  // --- unambiguous video signatures ---
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return matroskaOrWebm(bytes);
  if (ascii(bytes, 0, "FLV")) return { kind: "video", format: "FLV" };
  if (ascii(bytes, 0, "OggS")) return { kind: "video", format: "Ogg" };
  if (starts(bytes, [0x30, 0x26, 0xb2, 0x75]))
    return { kind: "video", format: "ASF / WMV" };
  if (starts(bytes, [0x00, 0x00, 0x01, 0xba]))
    return { kind: "video", format: "MPEG-PS" };
  if (starts(bytes, [0x00, 0x00, 0x01, 0xb3]))
    return { kind: "video", format: "MPEG video" };
  if (isMpegTransportStream(bytes)) return { kind: "video", format: "MPEG-TS" };

  // --- shared magic that needs a second look ---
  if (ascii(bytes, 0, "RIFF")) return riffKind(bytes);
  if (ascii(bytes, 4, "ftyp")) return isoBrandKind(bytes);

  // SVG is text, so scan a little way in past any BOM or comments.
  if (looksLikeSvg(bytes)) return { kind: "image", format: "SVG" };

  return null;
}

/** `RIFF....WEBP` is an image; `RIFF....AVI ` is a video. */
function riffKind(bytes: Buffer): SniffResult | null {
  if (ascii(bytes, 8, "WEBP")) return { kind: "image", format: "WebP" };
  if (ascii(bytes, 8, "AVI ")) return { kind: "video", format: "AVI" };
  return null;
}

/**
 * ISO base media: the brand at offset 8 decides image vs video.
 *
 * AVIF and HEIC are the same container family as MP4 — `ftyp` alone says
 * nothing about which. This is the case a pure extension check gets wrong when
 * a file is named badly.
 */
function isoBrandKind(bytes: Buffer): SniffResult | null {
  const brand = bytes.subarray(8, 12).toString("latin1").trim().toLowerCase();

  const imageBrands: Record<string, string> = {
    avif: "AVIF",
    avis: "AVIF sequence",
    heic: "HEIC",
    heix: "HEIC",
    heim: "HEIC",
    heis: "HEIC",
    hevc: "HEIC sequence",
    mif1: "HEIF",
    msf1: "HEIF sequence",
  };
  if (brand in imageBrands) {
    return { kind: "image", format: imageBrands[brand] ?? "HEIF" };
  }

  const videoBrands: Record<string, string> = {
    isom: "MP4",
    iso2: "MP4",
    iso4: "MP4",
    iso5: "MP4",
    iso6: "MP4",
    mp41: "MP4",
    mp42: "MP4",
    avc1: "MP4",
    dash: "MP4",
    m4v: "M4V",
    m4a: "M4A",
    qt: "QuickTime",
    "3gp4": "3GP",
    "3gp5": "3GP",
    "3g2a": "3G2",
  };
  if (brand in videoBrands) {
    return { kind: "video", format: videoBrands[brand] ?? "MP4" };
  }

  // An unrecognised brand is still an ISO container, which in practice means
  // video far more often than not.
  return { kind: "video", format: "ISO media" };
}

/** Both are the same magic; the DocType element names which one. */
function matroskaOrWebm(bytes: Buffer): SniffResult {
  const head = bytes.subarray(0, 64).toString("latin1");
  return head.includes("webm")
    ? { kind: "video", format: "WebM" }
    : { kind: "video", format: "Matroska" };
}

/**
 * MPEG-TS has no magic number — it is identified by a 0x47 sync byte
 * recurring every 188 bytes, so one byte alone would match far too much.
 */
function isMpegTransportStream(bytes: Buffer): boolean {
  if (bytes[0] !== 0x47) return false;
  for (const offset of [188, 376, 564]) {
    if (offset < bytes.length && bytes[offset] !== 0x47) return false;
  }
  return bytes.length > 188;
}

function looksLikeSvg(bytes: Buffer): boolean {
  const text = bytes.subarray(0, 1024).toString("utf8").trimStart();
  const withoutBom = text.startsWith("﻿") ? text.slice(1) : text;
  if (!withoutBom.startsWith("<")) return false;
  return /<svg[\s>]/i.test(withoutBom) || /<!DOCTYPE\s+svg/i.test(withoutBom);
}

function starts(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Buffer, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  return bytes.subarray(offset, offset + text.length).toString("latin1") === text;
}
