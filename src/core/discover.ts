import { stat, readdir } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute, dirname, sep } from "node:path";
import { CompressorError } from "./errors.js";
import { isImageInputFormat } from "../types/image-formats.js";
import { isVideoInputFormat } from "../types/video-formats.js";
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
  /** Descend into subdirectories. Directories are scanned shallowly otherwise. */
  readonly recursive?: boolean;
  /** Restrict to one media kind; omit to accept both. */
  readonly kind?: MediaKind;
  /**
   * Absolute paths never to descend into — the output directories.
   *
   * A list rather than a single path because a run can have several input
   * roots, each with its own default `compressed/` destination.
   */
  readonly excludeDirs?: readonly string[];
}

export function classify(filePath: string): MediaKind | null {
  const ext = extname(filePath).toLowerCase();
  if (isImageInputFormat(ext)) return "image";
  if (isVideoInputFormat(ext)) return "video";
  return null;
}

/**
 * Resolve CLI inputs — files, directories, or shell-expanded globs — into a
 * concrete, deduplicated work list.
 *
 * v1 did a single flat `readdir` and could only ever see one directory, with no
 * way to pass an individual file. It also never checked whether an entry was a
 * directory, so a folder named `assets.png` would be handed to sharp.
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
      await walk(absolute, absolute, options, exclude, seen);
    } else if (info.isFile()) {
      // An explicitly named file bypasses kind filtering only if it matches;
      // naming an unsupported file should say so rather than silently do nothing.
      const kind = classify(absolute);
      if (kind === null) {
        throw new CompressorError(
          "UNSUPPORTED_FORMAT",
          `Unsupported file type: ${input}`,
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
      if (options.recursive) await walk(full, root, options, exclude, out);
      continue;
    }
    if (!entry.isFile()) continue; // Sockets, FIFOs, dangling symlinks.
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends.

    const kind = classify(full);
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
