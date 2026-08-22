import { access, stat } from "node:fs/promises";
import { join, relative, resolve, basename, extname, dirname } from "node:path";

import { discoverFiles, type DiscoveredFile } from "./discover.js";
import { mapWithConcurrency, defaultConcurrency } from "./pool.js";
import { CompressorError, toFailure } from "./errors.js";
import { withAtomicOutput } from "./atomic-output.js";
import { encodeImage, resolveImageTarget } from "../codecs/image.js";
import {
  encodeVideo,
  curatedArgs,
  buildOpenVideoArgs,
  type StreamPlan,
} from "../codecs/video.js";
import {
  muxerDetail,
  ffmpegCapabilities,
  type FfmpegCapabilities,
} from "../codecs/ffmpeg-capabilities.js";
import {
  resolveFfmpeg,
  probeMedia,
  type FfmpegTools,
  type MediaProbe,
} from "../codecs/ffmpeg.js";
import { toQuality, type Quality } from "../types/brand.js";
import {
  defaultAudioCodec,
  defaultVideoCodec,
  canCopyAudioInto,
  isCodecAllowedIn,
  isImageSubtitle,
  isVideoContainer,
  subtitleCodecFor,
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
  const tools: FfmpegTools | null = needsVideo
    ? await resolveFfmpeg(options.ffmpegPath)
    : null;

  const jobs = await Promise.all(
    files.map((file) => planJob(file, options, outDir, kind === null)),
  );
  assertNoCollisions(jobs);

  const codecPlan = await preflightVideoCodecs(jobs, options, tools);
  options.onProgress?.({
    type: "run-start",
    total: jobs.length,
    ...(codecPlan.warnings.length > 0 ? { warnings: codecPlan.warnings } : {}),
  });

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
        codecs: codecPlan.byFormat,
      });
      options.onProgress?.({ type: "job-done", job, result });
      return result;
    },
    options.signal,
  );

  return {
    summary: summarise(results, performance.now() - startedAt, codecPlan.warnings),
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
  readonly codecs: ReadonlyMap<string, RuntimeCodecSelection>;
}

interface RuntimeCodecSelection {
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

interface RuntimeCodecPlan {
  readonly byFormat: ReadonlyMap<string, RuntimeCodecSelection>;
  readonly warnings: readonly string[];
}

/** Validate each requested output configuration before any file starts encoding. */
async function preflightVideoCodecs(
  jobs: readonly CompressionJob[],
  options: CompressOptions,
  tools: FfmpegTools | null,
): Promise<RuntimeCodecPlan> {
  const formats = new Set(
    jobs.filter((job) => job.kind === "video").map((job) => job.targetFormat),
  );
  const byFormat = new Map<string, RuntimeCodecSelection>();
  const warnings: string[] = [];
  const caps = tools ? await ffmpegCapabilities(tools.ffmpeg) : null;

  for (const format of formats) {
    if (isVideoContainer(format)) {
      byFormat.set(format, curatedCodecSelection(format, options, caps, warnings));
      continue;
    }

    if (caps) {
      assertOpenEncoderAvailable(
        "video",
        format,
        options.videoCodec,
        caps.videoEncoders,
      );
      if (options.audioCodec !== "copy") {
        assertOpenEncoderAvailable(
          "audio",
          format,
          options.audioCodec,
          caps.audioEncoders,
        );
      }
    }

    byFormat.set(format, {
      videoCodec: options.videoCodec ?? null,
      audioCodec: options.audioCodec ?? null,
    });
  }

  return { byFormat, warnings };
}

function curatedCodecSelection(
  container: VideoContainer,
  options: CompressOptions,
  caps: FfmpegCapabilities | null,
  warnings: string[],
): RuntimeCodecSelection {
  let videoCodec = resolveVideoCodec(container, options.videoCodec);
  let audioCodec = resolveAudioCodec(container, options.audioCodec);

  if (caps && !caps.videoEncoders.has(videoCodec)) {
    const available = VIDEO_CONTAINERS[container].video.filter((codec) =>
      caps.videoEncoders.has(codec),
    );
    if (options.videoCodec !== undefined) {
      throw missingCuratedEncoder("video", container, videoCodec, available);
    }

    const fallback = available[0];
    if (!fallback) {
      throw noCuratedEncoder("video", container, videoCodec);
    }
    warnings.push(
      `This ffmpeg build lacks the default video encoder "${videoCodec}" for ${VIDEO_CONTAINERS[container].label}; using "${fallback}" instead.`,
    );
    videoCodec = fallback;
  }

  if (caps && audioCodec !== "copy" && !caps.audioEncoders.has(audioCodec)) {
    const available = VIDEO_CONTAINERS[container].audio.filter(
      (codec) => codec !== "copy" && caps.audioEncoders.has(codec),
    );
    if (options.audioCodec !== undefined) {
      throw missingCuratedEncoder("audio", container, audioCodec, available);
    }

    const fallback = available[0];
    if (!fallback) {
      throw noCuratedEncoder("audio", container, audioCodec);
    }
    warnings.push(
      `This ffmpeg build lacks the default audio encoder "${audioCodec}" for ${VIDEO_CONTAINERS[container].label}; using "${fallback}" whenever audio must be re-encoded.`,
    );
    audioCodec = fallback;
  }

  return { videoCodec, audioCodec };
}

function missingCuratedEncoder(
  kind: "video" | "audio",
  container: VideoContainer,
  requested: string,
  available: readonly string[],
): CompressorError {
  const label = VIDEO_CONTAINERS[container].label;
  return new CompressorError(
    "INVALID_OPTION",
    `This ffmpeg build has no ${kind} encoder called "${requested}".\n` +
      `Available ${kind} encoders for ${label} (${container}) in this build: ${available.length > 0 ? available.join(", ") : "none"}.`,
  );
}

function noCuratedEncoder(
  kind: "video" | "audio",
  container: VideoContainer,
  missingDefault: string,
): CompressorError {
  const label = VIDEO_CONTAINERS[container].label;
  return new CompressorError(
    "UNSUPPORTED_FORMAT",
    `This ffmpeg build lacks the default ${kind} encoder "${missingDefault}" for ${label} (${container}), ` +
      `and no other ${kind} encoder legal for that container is available.`,
  );
}

function assertOpenEncoderAvailable(
  kind: "video" | "audio",
  format: string,
  requested: string | undefined,
  available: ReadonlySet<string>,
): void {
  if (requested === undefined || available.has(requested)) return;

  throw new CompressorError(
    "INVALID_OPTION",
    `This ffmpeg build has no ${kind} encoder called "${requested}" for ${format}.\n` +
      `Available ${kind} encoders in this build: ${[...available].sort().join(", ")}.`,
  );
}

async function executeJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<JobResult> {
  const { kind, inputPath, outputPath, inputBytes, targetFormat } = job;

  try {
    if (!(ctx.options.overwrite ?? false) && (await exists(outputPath))) {
      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        targetFormat,
        reason: "output-exists",
      };
    }

    if (ctx.dryRun) {
      const prepared =
        kind === "video" ? await prepareVideoJob(job, ctx, job.outputPath) : null;
      const warnings = prepared?.warnings ?? [];

      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        targetFormat,
        reason: "dry-run",
        ...(prepared
          ? {
              videoCodec: prepared.videoCodec,
              audioCodec: prepared.audioCodec,
            }
          : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const startedAt = performance.now();
    const output =
      kind === "image" ? await runImageJob(job, ctx) : await runVideoJob(job, ctx);
    const { bytes: outputBytes, warnings } = output;

    const notes = {
      targetFormat,
      ...(output.videoCodec !== undefined
        ? {
            videoCodec: output.videoCodec,
            audioCodec: output.audioCodec ?? null,
          }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    // `null` signals the encoder declined to write because it grew the file.
    if (outputBytes === null) {
      return {
        status: "skipped",
        kind,
        inputPath,
        outputPath,
        inputBytes,
        reason: "output-larger-than-input",
        ...notes,
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
      ...notes,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return {
      status: "failed",
      kind,
      inputPath,
      outputPath,
      targetFormat,
      error: toFailure(err),
    };
  }
}

/** `bytes: null` means the encoder declined to write because output grew. */
interface JobOutput {
  readonly bytes: number | null;
  readonly warnings: string[];
  readonly videoCodec?: string | null;
  readonly audioCodec?: string | null;
}

async function runImageJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<JobOutput> {
  const encoded = await encodeImage({
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    format: job.targetFormat,
    quality: ctx.quality,
    resize: ctx.options.resize,
    autoRotate: ctx.options.autoRotate ?? true,
    keepMetadata: ctx.options.keepMetadata ?? false,
  });

  if (ctx.skipLarger && encoded.bytes >= job.inputBytes) {
    return { bytes: null, warnings: [] };
  }

  await encoded.write();
  return { bytes: encoded.bytes, warnings: [] };
}

async function runVideoJob(
  job: CompressionJob,
  ctx: ExecuteContext,
): Promise<JobOutput> {
  const tools = ctx.tools;
  if (!tools) {
    throw new CompressorError(
      "FFMPEG_NOT_FOUND",
      "ffmpeg is required to compress video.",
    );
  }

  return withAtomicOutput<JobOutput>(job.outputPath, async (temporaryPath) => {
    const prepared = await prepareVideoJob(job, ctx, temporaryPath);

    const encoded = await encodeVideo({
      tools,
      inputPath: job.inputPath,
      outputPath: temporaryPath,
      args: prepared.args,
      durationSeconds: prepared.durationSeconds,
      ...(ctx.options.onProgress
        ? {
            onProgress: (ratio: number) =>
              ctx.options.onProgress?.({ type: "job-progress", job, ratio }),
          }
        : {}),
      ...(ctx.options.signal ? { signal: ctx.options.signal } : {}),
    });

    const result = {
      warnings: prepared.warnings,
      videoCodec: prepared.videoCodec,
      audioCodec: prepared.audioCodec,
    };

    if (ctx.skipLarger && encoded.bytes >= job.inputBytes) {
      return { value: { bytes: null, ...result }, replace: false };
    }
    return { value: { bytes: encoded.bytes, ...result }, replace: true };
  });
}

interface PreparedVideoJob {
  readonly args: string[];
  readonly durationSeconds: number | null;
  readonly warnings: string[];
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

/**
 * Resolve everything an encode needs without running one.
 *
 * Split out so a dry run can report the codecs and stream drops a real run
 * would produce. `outputPath` is the staging file for a real encode, and the
 * final destination for a plan, whose args are never executed.
 */
async function prepareVideoJob(
  job: CompressionJob,
  ctx: ExecuteContext,
  outputPath: string,
): Promise<PreparedVideoJob> {
  if (!ctx.tools) {
    throw new CompressorError(
      "FFMPEG_NOT_FOUND",
      "ffmpeg is required to compress video.",
    );
  }

  const extension = job.targetFormat;

  // One probe serves the progress percentage, the audio decision, and which
  // streams survive.
  const probe: MediaProbe = ctx.tools.ffprobe
    ? await probeMedia(ctx.tools.ffprobe, job.inputPath)
    : EMPTY_PROBE;

  const plan = isVideoContainer(extension)
    ? planStreams(extension, probe)
    : { plan: openStreamPlan(probe), dropped: [] as string[] };

  const prepared = isVideoContainer(extension)
    ? prepareCuratedVideo(extension, job, ctx, probe, plan.plan, outputPath)
    : await prepareOpenVideo(extension, job, ctx, probe, plan.plan, outputPath);

  return {
    ...prepared,
    durationSeconds: probe.durationSeconds,
    warnings: plan.dropped,
  };
}

const EMPTY_PROBE: MediaProbe = {
  durationSeconds: null,
  video: [],
  audio: [],
  subtitles: [],
  attachedPictures: [],
  hasAttachments: false,
};

/**
 * Decide which streams survive into a curated container.
 *
 * Anything that cannot be carried is reported rather than dropped in silence —
 * losing a commentary track or a subtitle without a word is worse than
 * refusing outright, because nobody notices until they need it.
 */
export function planStreams(
  container: VideoContainer,
  probe: MediaProbe,
): { plan: StreamPlan; dropped: string[] } {
  const dropped: string[] = [];

  const subtitles: { index: number; codec: string }[] = [];
  for (const sub of probe.subtitles) {
    const codec = subtitleCodecFor(container, sub.codec);
    if (codec === null) {
      const kind = isImageSubtitle(sub.codec) ? "image-based " : "";
      dropped.push(
        `dropped ${kind}subtitle track${describeStream(sub)} — ` +
          `${VIDEO_CONTAINERS[container].label} cannot carry ${sub.codec}`,
      );
      continue;
    }
    subtitles.push({ index: sub.index, codec });
  }

  for (const picture of probe.attachedPictures) {
    dropped.push("dropped embedded cover art");
    void picture;
  }

  return {
    plan: {
      video: probe.video.map((v) => v.index),
      audio: probe.audio.map((a) => a.index),
      subtitles,
      // Fonts only travel in Matroska, and only matter alongside subtitles.
      attachments: container === ".mkv" && probe.hasAttachments && subtitles.length > 0,
    },
    dropped,
  };
}

/**
 * Stream plan for an uncurated container.
 *
 * Video and audio are mapped, subtitles are left to ffmpeg's default handling:
 * we have no compatibility table for a container discovered at runtime, and
 * guessing wrong makes the whole mux fail rather than losing one track.
 */
function openStreamPlan(probe: MediaProbe): StreamPlan | null {
  if (probe.video.length === 0 && probe.audio.length === 0) return null;
  return {
    video: probe.video.map((v) => v.index),
    audio: probe.audio.map((a) => a.index),
    subtitles: [],
    attachments: false,
  };
}

function describeStream(stream: {
  language: string | null;
  title: string | null;
}): string {
  const parts = [stream.language, stream.title].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(": ")})` : "";
}

interface PreparedVideoArgs {
  readonly args: string[];
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

/** Curated container: typed codec matrix and tuned per-codec flags. */
function prepareCuratedVideo(
  container: VideoContainer,
  job: CompressionJob,
  ctx: ExecuteContext,
  probe: MediaProbe,
  plan: StreamPlan | null,
  outputPath: string,
): PreparedVideoArgs {
  const selected = ctx.codecs.get(container);
  const videoCodec = (selected?.videoCodec ??
    resolveVideoCodec(container, ctx.options.videoCodec)) as VideoCodec;
  const audioCodec = resolveAudioCodec(
    container,
    ctx.options.audioCodec,
    probe.audio,
    (selected?.audioCodec as AudioCodec | null | undefined) ?? undefined,
  );

  return {
    args: curatedArgs({
      inputPath: job.inputPath,
      outputPath,
      container,
      // Checked against the container's own matrix by the resolvers above.
      videoCodec,
      audioCodec,
      quality: ctx.quality,
      speed: ctx.options.preset,
      fps: ctx.options.fps,
      resize: ctx.options.resize,
      sourceAudioBitrates: probe.audio.map((a) => a.bitrate),
      streams: plan,
    }),
    videoCodec,
    audioCodec,
  };
}

/**
 * Any other container ffmpeg can mux.
 *
 * The muxer is asked for its own defaults rather than guessed at: whatever
 * ffmpeg would have chosen unaided is by definition muxable. An explicit
 * `--codec` is checked against the encoder list first, so a typo fails with a
 * clear message instead of a wall of ffmpeg stderr.
 */
async function prepareOpenVideo(
  extension: string,
  job: CompressionJob,
  ctx: ExecuteContext,
  probe: MediaProbe,
  plan: StreamPlan | null,
  outputPath: string,
): Promise<PreparedVideoArgs> {
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

  const selected = ctx.codecs.get(extension);
  const videoCodec = selected?.videoCodec ?? ctx.options.videoCodec ?? null;
  const audioCodec = selected?.audioCodec ?? ctx.options.audioCodec ?? null;

  return {
    args: buildOpenVideoArgs({
      inputPath: job.inputPath,
      outputPath,
      extension,
      // null means "let ffmpeg decide", which is always a legal choice.
      videoCodec,
      audioCodec,
      quality: ctx.quality,
      speed: ctx.options.preset,
      fps: ctx.options.fps,
      resize: ctx.options.resize,
      sourceAudioBitrates: probe.audio.map((a) => a.bitrate),
      streams: plan,
    }),
    videoCodec: videoCodec ?? detail?.defaultVideoCodec ?? null,
    audioCodec: audioCodec ?? detail?.defaultAudioCodec ?? null,
  };
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

/** The source's audio streams, as ffprobe described them. */
type SourceAudio = readonly {
  readonly codec: string;
  readonly bitrate: number | null;
}[];

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
  sourceAudio: SourceAudio = [],
  defaulted: AudioCodec = defaultAudioCodec(container),
): AudioCodec {
  if (requested === undefined) {
    // Copy only when *every* track can be carried: `-c:a copy` is all-or-nothing,
    // so one incompatible stream would fail the mux for all of them.
    if (
      sourceAudio.length > 0 &&
      sourceAudio.every((a) => canCopyAudioInto(container, a.codec))
    ) {
      return "copy";
    }
    return defaulted;
  }

  // `copy` is not an encoder, so it is not in the container's encoder list. It
  // is legal whenever the *source stream* is something the container accepts.
  if (requested === "copy") {
    const blocked = sourceAudio.find((a) => !canCopyAudioInto(container, a.codec));
    if (blocked) {
      throw new CompressorError(
        "INVALID_OPTION",
        `${VIDEO_CONTAINERS[container].label} cannot carry a ${blocked.codec} stream, so its audio must be re-encoded.\n` +
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
  warnings: readonly string[] = [],
): CompressionSummary {
  let compressed = 0;
  let skipped = 0;
  let failed = 0;
  let planned = 0;
  let plannedInputBytes = 0;
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
        if (result.reason === "dry-run") {
          planned++;
          plannedInputBytes += result.inputBytes;
        }
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
    planned,
    plannedInputBytes,
    inputBytes,
    outputBytes,
    savedBytes,
    savedRatio: inputBytes > 0 ? savedBytes / inputBytes : 0,
    durationMs,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Re-exported so callers can stat a planned destination without guessing. */
export async function outputSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
