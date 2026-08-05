import { stat, readdir } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute, dirname, sep } from "node:path";
import { CompressorError } from "./errors.js";
import { sniffFile } from "./sniff.js";
import { imageCapabilities } from "../codecs/sharp-capabilities.js";
import { COMMON_VIDEO_EXTENSIONS, isVideoContainer } from "../types/video-formats.js";
import { IMAGE_INPUT_ONLY_FORMATS } from "../types/image-formats.js";
import type { MediaKind } from "../types/results.js";

export interface DiscoveredFile {
  readonly path: string;
  readonly kind: MediaKind;
  readonly bytes: number;
  /**
   * The directory the file was discovered under. Output mirrors the tree
   * relative to this, so `photos/2024/a.jpg` lands at `<out>/2024/a.webp`
   * rather than collapsing every subdirectory into one flat folder.
   */
  readonly root: string;
}

export interface DiscoverOptions {
  readonly recursive?: boolean;
  readonly kind?: MediaKind;
  readonly excludeDirs?: readonly string[];
}

/**
 * Extension sets used to classify files.
 *
 * Images come from the running sharp build rather than a hardcoded list, so a
 * build with JPEG XL support picks up `.jxl` automatically. Video extensions
 * are a broad static set used as a fast path — ffmpeg reads far more than this,
 * which is what the content sniff is for.
 */
export interface ExtensionIndex {
  readonly image: ReadonlySet<string>;
  readonly video: ReadonlySet<string>;
}

let indexCache: Promise<ExtensionIndex> | null = null;

export function resetExtensionIndex(): void {
  indexCache = null;
}

export function extensionIndex(): Promise<ExtensionIndex> {
  indexCache ??= buildIndex();
  return indexCache;
}

async function buildIndex(): Promise<ExtensionIndex> {
  const caps = await imageCapabilities();

  const image = new Set<string>(caps.readableExtensions);
  for (const ext of IMAGE_INPUT_ONLY_FORMATS) image.add(ext);

  const video = new Set<string>(COMMON_VIDEO_EXTENSIONS);

  // `.gif` and `.ogg` are claimed by both worlds. Images win: a GIF handed to
  // sharp round-trips correctly, while ffmpeg would treat it as a video stream.
  for (const ext of image) video.delete(ext);

  return { image, video };
}

/**
 * Classify a file.
 *
 * Extension first, since it is free and right almost always. Sniffing is the
 * fallback for what a name genuinely cannot answer — no extension, an unknown
 * one, or an ISO container whose `.mp4`/`.avif` ambiguity is only resolvable
 * from the brand bytes. A merely *mislabelled* file needs no special handling:
 * sharp and ffmpeg both detect their input's real format.
 */
export async function classifyFile(filePath: string): Promise<MediaKind | null> {
  const index = await extensionIndex();
  const byExtension = classifyByExtension(filePath, index);
  if (byExtension) return byExtension;

  const sniffed = await sniffFile(filePath);
  return sniffed?.kind ?? null;
}

/** Extension-only check, for bulk discovery where a file read per entry is too costly. */
export function classifyByExtension(
  filePath: string,
  index: ExtensionIndex,
): MediaKind | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === "") return null;
  if (index.image.has(ext)) return "image";
  if (index.video.has(ext) || isVideoContainer(ext)) return "video";
  return null;
}

/**
 * Resolve CLI inputs — files, directories, or shell-expanded globs — into a
 * concrete, deduplicated work list.
 *
 * v1 did a single flat `readdir`, could only ever see one directory, and had no
 * way to accept an individual file. It also never checked whether an entry was
 * a directory, so a folder named `assets.png` would be handed to sharp.
 */
export async function discoverFiles(
  inputs: readonly string[],
  options: DiscoverOptions = {},
): Promise<DiscoveredFile[]> {
  if (inputs.length === 0) {
    throw new CompressorError(
      "NO_INPUT_FILES",
      "No input paths given. Pass one or more files or directories.",
    );
  }

  const index = await extensionIndex();
  const seen = new Map<string, DiscoveredFile>();
  const exclude = (options.excludeDirs ?? []).map((d) => resolve(d));

  for (const input of inputs) {
    const absolute = resolve(input);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new CompressorError(
        "INPUT_NOT_FOUND",
        `No such file or directory: ${input}`,
      );
    }

    if (info.isDirectory()) {
      await walk(absolute, absolute, options, exclude, index, seen);
    } else if (info.isFile()) {
      // A file named explicitly gets the full treatment, sniff included: the
      // user clearly meant this one and deserves a real answer.
      const kind = await classifyFile(absolute);
      if (kind === null) {
        throw new CompressorError(
          "UNSUPPORTED_FORMAT",
          `Unrecognised file type: ${input}\n` +
            "Neither the extension nor the contents identify it as an image or video.",
        );
      }
      if (options.kind && kind !== options.kind) continue;
      if (isExcluded(absolute, exclude)) continue;
      seen.set(absolute, {
        path: absolute,
        kind,
        bytes: info.size,
        root: dirname(absolute),
      });
    }
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(
  dir: string,
  root: string,
  options: DiscoverOptions,
  exclude: readonly string[],
  index: ExtensionIndex,
  out: Map<string, DiscoveredFile>,
): Promise<void> {
  if (isExcluded(dir, exclude)) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return; // Unreadable subtree: skip, don't abort.
    throw err;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (options.recursive) await walk(full, root, options, exclude, index, out);
      continue;
    }
    if (!entry.isFile()) continue; // Sockets, FIFOs, dangling symlinks.
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends.

    // Bulk discovery stays on the extension fast path. Sniffing every entry in
    // a large tree means opening thousands of files just to skip most of them,
    // and an extensionless file found by scanning is far more often a stray
    // artefact than media someone wanted compressed.
    const kind = classifyByExtension(full, index);
    if (kind === null) continue;
    if (options.kind && kind !== options.kind) continue;

    try {
      const info = await stat(full);
      out.set(full, { path: full, kind, bytes: info.size, root });
    } catch {
      continue; // Vanished between readdir and stat.
    }
  }
}

/**
 * True when `child` sits inside `parent` (or is `parent`).
 *
 * Compared via `relative` rather than `startsWith` so that `/a/bcd` is not
 * treated as living under `/a/b`.
 */
export function isUnder(child: string, parent: string | null): boolean {
  if (!parent) return false;
  const rel = relative(parent, child);
  return (
    rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/**
 * True when `child` is inside any excluded directory.
 *
 * This is what stops a recursive re-run from discovering its own output and
 * compressing it again — generation loss, one pass at a time.
 */
function isExcluded(child: string, exclude: readonly string[]): boolean {
  return exclude.some((dir) => isUnder(child, dir));
}
