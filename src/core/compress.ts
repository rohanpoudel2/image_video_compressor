import { access, stat, rm } from "node:fs/promises";
import { join, relative, resolve, basename, extname, dirname } from "node:path";

import { discoverFiles, type DiscoveredFile } from "./discover.js";
import { mapWithConcurrency, defaultConcurrency } from "./pool.js";
import { CompressorError, toFailure } from "./errors.js";
import { encodeImage, resolveImageTarget } from "../codecs/image.js";
import { encodeVideo, curatedArgs, buildOpenVideoArgs } from "../codecs/video.js";
import { muxerDetail, ffmpegCapabilities } from "../codecs/ffmpeg-capabilities.js";
import { resolveFfmpeg, probeMedia, type FfmpegTools } from "../codecs/ffmpeg.js";
import { toQuality, type Quality } from "../types/brand.js";
import {
  defaultAudioCodec,
  defaultVideoCodec,
  canCopyAudioInto,
  isCodecAllowedIn,
  isVideoContainer,
  VIDEO_CONTAINERS,
  type AudioCodec,
  type VideoCodec,
  type VideoContainer,
} from "../types/video-formats.js";
import { imageCapabilities } from "../codecs/sharp-capabilities.js";
import type {
  CompressionJob,
  CompressionReport,
  CompressionSummary,
  ImageOptions,
  JobResult,
  MediaKind,
  VideoOptions,
  CompressOptions,
} from "../types/results.js";

/** Directory name used when no `outDir` is supplied. */
export const DEFAULT_OUTPUT_DIRNAME = "compressed";

const DEFAULT_IMAGE_FORMAT = ".webp";
const DEFAULT_VIDEO_FORMAT = ".mp4";
const DEFAULT_QUALITY = toQuality(75);

/**
 * Compress images.
 *
 * Always resolves. Per-file failures are reported inside `results` rather than
 * thrown, so a single corrupt file can never discard the rest of the batch the
 * way v1's `Promise.all` did. Only setup problems — no inputs, a bad option —
 * reject.
 */
export async function compressImages(
  inputs: readonly string[],
  options: ImageOptions = {},
): Promise<CompressionReport> {
  return run("image", inputs, options);
}

/** Compress videos. Same resolution semantics as {@link compressImages}. */
export async function compressVideos(
  inputs: readonly string[],
  options: VideoOptions = {},
): Promise<CompressionReport> {
  return run("video", inputs, options);
}

/** Compress whatever is found, routing each file to the right encoder by extension. */
export async function compress(
  inputs: readonly string[],
  options: CompressOptions = {},
): Promise<CompressionReport> {
  return run(null, inputs, options);
}

async function run(
  kind: MediaKind | null,
  inputs: readonly string[],
  options: CompressOptions,
): Promise<CompressionReport> {
  const startedAt = performance.now();
  const quality = options.quality ?? DEFAULT_QUALITY;
  const dryRun = options.dryRun ?? false;
  const skipLarger = options.skipLarger ?? true;

  const outDir = options.outDir ? resolve(options.outDir) : null;

  const files = await discoverFiles(inputs, {
    recursive: options.recursive ?? false,
    ...(kind ? { kind } : {}),
    excludeDirs: outputDirsToSkip(inputs, outDir),
  });

  if (files.length === 0) {
    throw new CompressorError(
      "NO_INPUT_FILES",
      kind
        ? `No ${kind} files found in the given path(s).`
        : "No image or video files found in the given path(s).",
    );
  }

  const needsVideo = files.some((f) => f.kind === "video");
  const tools: FfmpegTools | null =
    needsVideo && !dryRun ? await resolveFfmpeg(options.ffmpegPath) : null;

  const jobs = await Promise.all(
    files.map((file) => planJob(file, options, outDir, kind === null)),
  );
  assertNoCollisions(jobs);

  options.onProgress?.({ type: "run-start", total: jobs.length });

  const concurrency =
    options.concurrency ?? defaultConcurrency(needsVideo ? "video" : "image");

  const results = await mapWithConcurrency(
    jobs,
    concurrency,
    async (job) => {
      options.onProgress?.({ type: "job-start", job });
      const result = await executeJob(job, {
        options,
        quality,
        dryRun,
        skipLarger,
        tools,
      });
      options.onProgress?.({ type: "job-done", job, result });
      return result;
    },
    options.signal,
  );

  return {
    summary: summarise(results, performance.now() - startedAt),
    results,
    ...(tools ? { ffmpegPath: tools.ffmpeg } : {}),
    dryRun,
  };
}

/**
 * Directories discovery must not descend into, so a re-run never re-compresses
 * its own output.
 *
 * An output directory that *is* an input root is deliberately not excluded:
 * that is the in-place case (`--out ./photos --to .webp`), which is legitimate
 * and is guarded separately by the same-path check in `planJob`. Excluding it
 * would make the run report "no files found" instead.
 */
function outputDirsToSkip(inputs: readonly string[], outDir: string | null): string[] {
  const roots = new Set(inputs.map((i) => resolve(i)));

  if (outDir !== null) return roots.has(outDir) ? [] : [outDir];

  // With no explicit --out, each input root gets its own default destination.
  return [...roots].map((root) => join(root, DEFAULT_OUTPUT_DIRNAME));
}

/** Decide where a file's output goes and in what format, before any work runs. */
async function planJob(
  file: DiscoveredFile,
  options: CompressOptions,
  outDir: string | null,
  mixedRun: boolean,
): Promise<CompressionJob> {
  // On a mixed run a single `--to` cannot suit both kinds, so it applies only
  // to the kind it belongs to and the other keeps its default. A kind-scoped
  // run passes the value straight through, where a mismatch is a hard error.
  const requested = mixedRun
    ? await applicableFormat(options.to, file.kind)
    : options.to;

  const targetFormat =
    file.kind === "image"
      ? resolveImageFormat(requested, file.path)
      : resolveVideoFormat(requested);

  // Default output sits beside the source in `compressed/`, mirroring v1's
  // `optimised_images` convention so the mental model carries over.
  const base = outDir ?? join(file.root, DEFAULT_OUTPUT_DIRNAME);
  const relativePath = relative(file.root, file.path);
  const outputName = basename(relativePath, extname(relativePath)) + targetFormat;
  const outputPath = join(base, dirname(relativePath), outputName);

  if (resolve(outputPath) === resolve(file.path)) {
    throw new CompressorError(
      "INVALID_OPTION",
      `Refusing to overwrite the source in place: ${file.path}\n` +
        "Choose a different --out directory or --to format.",
    );
  }

  // Validate the target up front so a configuration mistake fails once, before
  // any encoding, rather than producing one identical failure per file.
  if (file.kind === "image") {
    await resolveImageTarget(targetFormat);
  } else if (isVideoContainer(targetFormat)) {
    resolveVideoCodec(targetFormat, options.videoCodec);
    resolveAudioCodec(targetFormat, options.audioCodec);
  }

  return {
    kind: file.kind,
    inputPath: file.path,
    outputPath,
    inputBytes: file.bytes,
    targetFormat,
  };
}

/**
 * On a mixed run a single `--to` cannot suit both kinds, so it applies only to
 * the kind it belongs to and the other keeps its default.
 *
 * Resolved through the runtime capability table rather than a fixed list, so a
 * build-specific format such as `.jxl` still routes to images correctly.
 */
async function applicableFormat(
  to: string | undefined,
  kind: MediaKind,
): Promise<string | undefined> {
  if (to === undefined) return undefined;
  const ext = to.startsWith(".") ? to.toLowerCase() : `.${to.toLowerCase()}`;

  const caps = await imageCapabilities();
  const isImageFormat = caps.writableByExtension.has(ext);

  return kind === "image"
    ? isImageFormat
      ? ext
      : undefined
    : isImageFormat
      ? undefined
      : ext;
}

function resolveImageFormat(to: string | undefined, inputPath: string): string {
  if (to === undefined) {
    // Preserve an already-modern format; otherwise convert to WebP.
    const ext = extname(inputPath).toLowerCase();
    return ext === ".avif" || ext === ".webp" ? ext : DEFAULT_IMAGE_FORMAT;
  }
  // Validated against the running sharp build in resolveImageTarget, which can
  // say *why* a format is unavailable instead of just rejecting it.
  return to.startsWith(".") ? to.toLowerCase() : `.${to.toLowerCase()}`;
}

/**
 * Any extension ffmpeg can mux is allowed here.
 *
 * Curated containers keep their typed matrix and tuned flags; everything else
 * is resolved against the binary at encode time. Rejecting an extension merely
 * because it is not in a hand-written list would be a limit with no basis.
 */
function resolveVideoFormat(to: string | undefined): string {
  if (to === undefined) return DEFAULT_VIDEO_FORMAT;
  return to.startsWith(".") ? to.toLowerCase() : `.${to.toLowerCase()}`;
}

/** Two sources mapping to one destination would silently destroy work. */
function assertNoCollisions(jobs: readonly CompressionJob[]): void {
  const byOutput = new Map<string, string>();

  for (const job of jobs) {
    const key = resolve(job.outputPath);
    const existing = byOutput.get(key);
    if (existing !== undefined) {
      throw new CompressorError(
        "INVALID_OPTION",
        `Both "${existing}" and "${job.inputPath}" would be written to "${job.outputPath}".\n` +
          "Use --recursive to preserve the directory structure, or compress them separately.",
      );
    }
    byOutput.set(key, job.inputPath);
  }
}

interface ExecuteContext {
  readonly options: CompressOptions;
  readonly quality: Quality;
  readonly dryRun: boolean;
  readonly skipLarger: boolean;
  readonly tools: FfmpegTools | null;
}

async function executeJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<JobResult> {
  const { kind, inputPath, outputPath, inputBytes } = job;

  try {
    if (ctx.dryRun) {
      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        reason: "dry-run",
      };
    }

    if (!(ctx.options.overwrite ?? false) && (await exists(outputPath))) {
      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        reason: "output-exists",
      };
    }

    const startedAt = performance.now();
    const outputBytes =
      kind === "image" ? await runImageJob(job, ctx) : await runVideoJob(job, ctx);

    // `null` signals the encoder declined to write because it grew the file.
    if (outputBytes === null) {
      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        reason: "output-larger-than-input",
      };
    }

    const savedBytes = inputBytes - outputBytes;
    return {
      status: "compressed",
      kind,
      inputPath,
      outputPath,
      inputBytes,
      outputBytes,
      savedBytes,
      savedRatio: inputBytes > 0 ? savedBytes / inputBytes : 0,
      durationMs: performance.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { status: "failed", kind, inputPath, outputPath, error: toFailure(err) };
  }
}

async function runImageJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<number | null> {
  const encoded = await encodeImage({
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    format: job.targetFormat,
    quality: ctx.quality,
    resize: ctx.options.resize,
    autoRotate: ctx.options.autoRotate ?? true,
    keepMetadata: ctx.options.keepMetadata ?? false,
  });

  if (ctx.skipLarger && encoded.bytes >= job.inputBytes) return null;

  await encoded.write();
  return encoded.bytes;
}

async function runVideoJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<number | null> {
  if (!ctx.tools) {
    throw new CompressorError(
      "FFMPEG_NOT_FOUND",
      "ffmpeg is required to compress video.",
    );
  }

  const extension = job.targetFormat;

  // One probe serves both the progress percentage and the audio decision.
  const probe = ctx.tools.ffprobe
    ? await probeMedia(ctx.tools.ffprobe, job.inputPath)
    : { durationSeconds: null, audio: null };

  const args = isVideoContainer(extension)
    ? curatedArgsFor(extension, job, ctx, probe.audio)
    : await openArgsFor(extension, job, ctx, probe.audio);

  const encoded = await encodeVideo({
    tools: ctx.tools,
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    args,
    durationSeconds: probe.durationSeconds,
    ...(ctx.options.onProgress
      ? {
          onProgress: (ratio: number) =>
            ctx.options.onProgress?.({ type: "job-progress", job, ratio }),
        }
      : {}),
    ...(ctx.options.signal ? { signal: ctx.options.signal } : {}),
  });

  if (ctx.skipLarger && encoded.bytes >= job.inputBytes) {
    await rm(job.outputPath, { force: true }).catch(() => undefined);
    return null;
  }
  return encoded.bytes;
}

/** Curated container: typed codec matrix and tuned per-codec flags. */
function curatedArgsFor(
  container: VideoContainer,
  job: CompressionJob,
  ctx: ExecuteContext,
  sourceAudio: SourceAudio,
): string[] {
  const videoCodec = resolveVideoCodec(container, ctx.options.videoCodec);
  const audioCodec = resolveAudioCodec(container, ctx.options.audioCodec, sourceAudio);

  return curatedArgs({
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    container,
    // Checked against the container's own matrix by the resolvers above.
    videoCodec: videoCodec,
    audioCodec: audioCodec,
    quality: ctx.quality,
    speed: ctx.options.preset,
    fps: ctx.options.fps,
    resize: ctx.options.resize,
    sourceAudioBitrate: sourceAudio?.bitrate ?? null,
  });
}

/**
 * Any other container ffmpeg can mux.
 *
 * The muxer is asked for its own defaults rather than guessed at: whatever
 * ffmpeg would have chosen unaided is by definition muxable. An explicit
 * `--codec` is checked against the encoder list first, so a typo fails with a
 * clear message instead of a wall of ffmpeg stderr.
 */
async function openArgsFor(
  extension: string,
  job: CompressionJob,
  ctx: ExecuteContext,
  sourceAudio: SourceAudio,
): Promise<string[]> {
  const ffmpeg = ctx.tools?.ffmpeg ?? "ffmpeg";
  const muxer = extension.slice(1);
  const detail = await muxerDetail(ffmpeg, muxer);

  if (!detail) {
    const caps = await ffmpegCapabilities(ffmpeg);
    if (!caps.muxers.has(muxer)) {
      throw new CompressorError(
        "UNSUPPORTED_FORMAT",
        `This ffmpeg build cannot write "${extension}".\n` +
          "Run `imgvidcompress formats` to see what it supports.",
      );
    }
  }

  const requested = ctx.options.videoCodec;
  if (requested !== undefined) {
    const caps = await ffmpegCapabilities(ffmpeg);
    if (!caps.videoEncoders.has(requested)) {
      throw new CompressorError(
        "INVALID_OPTION",
        `This ffmpeg build has no video encoder called "${requested}".`,
      );
    }
  }

  return buildOpenVideoArgs({
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    extension,
    // null means "let ffmpeg decide", which is always a legal choice.
    videoCodec: requested ?? null,
    audioCodec: ctx.options.audioCodec ?? null,
    quality: ctx.quality,
    speed: ctx.options.preset,
    fps: ctx.options.fps,
    resize: ctx.options.resize,
    sourceAudioBitrate: sourceAudio?.bitrate ?? null,
  });
}

/**
 * Validate a user-supplied codec against a curated container.
 *
 * The type system covers codecs chosen in code; a `--codec` string off the
 * command line has to be checked here, and the error names the legal options
 * instead of letting ffmpeg fail with a mux error.
 */
function resolveVideoCodec(
  container: VideoContainer,
  // Typed as a plain string because this is the untrusted CLI value; narrowing
  // it to VideoCodec here would make the guard below vacuous.
  requested: string | undefined,
): VideoCodec {
  if (requested === undefined) return defaultVideoCodec(container);

  if (!isCodecAllowedIn(container, requested)) {
    const allowed = VIDEO_CONTAINERS[container].video.join(", ");
    throw new CompressorError(
      "INVALID_OPTION",
      `${VIDEO_CONTAINERS[container].label} cannot carry ${requested}. Supported: ${allowed}.`,
    );
  }
  return requested as VideoCodec;
}

/** What ffprobe found on the source's audio track, if it has one. */
type SourceAudio = { readonly codec: string; readonly bitrate: number | null } | null;

/**
 * Pick an audio codec, preferring to copy the existing track.
 *
 * Re-encoding audio that the target container could carry untouched costs a
 * generation of quality, costs time, and can make the file bigger — a 70 kbps
 * AAC track re-encoded at a fixed 128 kbps grows by 80%. Copying is free and
 * lossless whenever it is legal, so it is the default; an explicit
 * `--audio-codec` still wins.
 */
function resolveAudioCodec(
  container: VideoContainer,
  requested: string | undefined,
  sourceAudio: SourceAudio = null,
): AudioCodec {
  if (requested === undefined) {
    if (sourceAudio && canCopyAudioInto(container, sourceAudio.codec)) {
      return "copy";
    }
    return defaultAudioCodec(container);
  }

  // `copy` is not an encoder, so it is not in the container's encoder list. It
  // is legal whenever the *source stream* is something the container accepts.
  if (requested === "copy") {
    if (sourceAudio && !canCopyAudioInto(container, sourceAudio.codec)) {
      throw new CompressorError(
        "INVALID_OPTION",
        `${VIDEO_CONTAINERS[container].label} cannot carry a ${sourceAudio.codec} stream, so its audio must be re-encoded.\n` +
          `Drop --audio-codec copy, or choose one of: ${VIDEO_CONTAINERS[container].audio.filter((c) => c !== "copy").join(", ")}.`,
      );
    }
    return "copy";
  }

  const allowed = VIDEO_CONTAINERS[container].audio as readonly string[];
  if (!allowed.includes(requested)) {
    throw new CompressorError(
      "INVALID_OPTION",
      `${VIDEO_CONTAINERS[container].label} cannot carry ${requested} audio. Supported: ${allowed.join(", ")}.`,
    );
  }
  return requested as AudioCodec;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function summarise(
  results: readonly JobResult[],
  durationMs: number,
): CompressionSummary {
  let compressed = 0;
  let skipped = 0;
  let failed = 0;
  let inputBytes = 0;
  let outputBytes = 0;

  for (const result of results) {
    switch (result.status) {
      case "compressed":
        compressed++;
        inputBytes += result.inputBytes;
        outputBytes += result.outputBytes;
        break;
      case "skipped":
        skipped++;
        break;
      case "failed":
        failed++;
        break;
    }
  }

  const savedBytes = inputBytes - outputBytes;
  return {
    totalFiles: results.length,
    compressed,
    skipped,
    failed,
    inputBytes,
    outputBytes,
    savedBytes,
    savedRatio: inputBytes > 0 ? savedBytes / inputBytes : 0,
    durationMs,
  };
}

/** Re-exported so callers can stat a planned destination without guessing. */
export async function outputSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
