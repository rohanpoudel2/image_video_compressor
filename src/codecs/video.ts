import { mkdir, stat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { runFfmpeg, type FfmpegTools } from "./ffmpeg.js";
import { CompressorError } from "../core/errors.js";
import {
  VIDEO_CODECS,
  codecSpec,
  isKnownVideoCodec,
  mapQuality,
  qualityToCrf,
  type AudioCodecFor,
  type QualityModel,
  type VideoCodec,
  type VideoCodecFor,
  type VideoContainer,
} from "../types/video-formats.js";
import type { Crf, Quality } from "../types/brand.js";
import type { ResizeOptions } from "../types/results.js";

/** The generic argument builder both tiers delegate to. */
interface RawArgsParams {
  readonly inputPath: string;
  readonly outputPath: string;
  /** `null` lets ffmpeg pick the muxer's own default encoder. */
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** `null` when we have no quality model for the chosen encoder. */
  readonly quality: { readonly flag: string; readonly value: number } | null;
  readonly extraVideoFlags: readonly string[];
  readonly audioBitrate: string | null;
  readonly fps: number | undefined;
  readonly resize: ResizeOptions | undefined;
  readonly faststart: boolean;
}

function buildRawArgs(params: RawArgsParams): string[] {
  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    // Without -nostdin ffmpeg consumes the parent's stdin inside a pipeline;
    // without -y it blocks forever on an overwrite prompt when there is no TTY.
    "-nostdin",
    "-y",
    "-i",
    params.inputPath,
    "-progress",
    "pipe:1",
  ];

  if (params.videoCodec) args.push("-c:v", params.videoCodec);
  if (params.quality) args.push(params.quality.flag, String(params.quality.value));
  args.push(...params.extraVideoFlags);

  const filter = buildScaleFilter(params.resize);
  if (filter) args.push("-vf", filter);

  // Only cap the frame rate when explicitly asked. v1 hardcoded `.fps(30)`,
  // which judders 24fps film and throws away half of 60fps footage.
  if (params.fps !== undefined) args.push("-r", String(params.fps));

  if (params.audioCodec) {
    args.push("-c:a", params.audioCodec);
    if (params.audioCodec !== "copy" && params.audioBitrate) {
      args.push("-b:a", params.audioBitrate);
    }
  }

  // Move the index to the front so playback can begin before the file finishes
  // downloading. Meaningless for Matroska/WebM, which are already streamable.
  if (params.faststart) args.push("-movflags", "+faststart");

  args.push(params.outputPath);
  return args;
}

/** Encoder flags beyond the quality setting, per codec. */
function videoFlagsFor(codec: VideoCodec, speed: string | undefined): string[] {
  const spec = codecSpec(codec);
  const flags: string[] = [];

  if (codec === "libvpx-vp9" || codec === "libvpx") {
    // Without `-b:v 0` libvpx treats -crf as a ceiling on top of a default
    // bitrate rather than as constant quality, and the file comes out far
    // larger than asked for. This flag is not optional.
    flags.push("-b:v", "0", "-row-mt", "1");
  }

  if (spec.speedFlag) {
    const value = speed ?? spec.defaultSpeed;
    if (value) flags.push(spec.speedFlag, value);
  }

  // 8-bit 4:2:0 is the only combination every player handles.
  if (["libx264", "libx265", "libsvtav1", "libaom-av1"].includes(codec)) {
    flags.push("-pix_fmt", "yuv420p");
  }
  // Signal HEVC as hvc1 so QuickTime and Safari will play the result.
  if (codec === "libx265") flags.push("-tag:v", "hvc1");

  return flags;
}

/**
 * Choose an audio bitrate that never exceeds what the source already spends.
 *
 * A fixed default inflates quiet or low-bitrate sources: a 70 kbps track
 * re-encoded at a hardcoded 128 kbps grows by 80%, and on a short clip whose
 * video compresses to almost nothing that alone can push the output past the
 * original. Compression should never spend more bits than it was given.
 */
export function resolveAudioBitrate(
  codec: string,
  sourceBitrate: number | null,
): string | null {
  const fallback = DEFAULT_AUDIO_BITRATES[codec];
  if (fallback === undefined) return null;
  if (sourceBitrate === null) return `${fallback}k`;

  const sourceKbps = Math.round(sourceBitrate / 1000);
  return `${Math.max(32, Math.min(fallback, sourceKbps))}k`;
}

const DEFAULT_AUDIO_BITRATES: Record<string, number> = {
  aac: 128,
  libopus: 96,
  libmp3lame: 192,
  libvorbis: 128,
};

export interface BuildVideoArgsParams<C extends VideoContainer> {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly container: C;
  /** Constrained to codecs this container can legally mux. */
  readonly videoCodec: VideoCodecFor<C>;
  readonly audioCodec: AudioCodecFor<C>;
  readonly crf: Crf;
  readonly speed?: string | undefined;
  readonly fps?: number | undefined;
  readonly resize?: ResizeOptions | undefined;
  /** Source audio bitrate in bits/sec, so the output never exceeds it. */
  readonly sourceAudioBitrate?: number | null | undefined;
}

/**
 * Build ffmpeg arguments for a curated container.
 *
 * Generic over the container, so the compiler rejects
 * `buildVideoArgs({ container: ".webm", videoCodec: "libx264" })` — the exact
 * combination v1 produced for every `--output=.webm` run, which ffmpeg refuses
 * to mux because WebM carries only VP8/VP9/AV1.
 */
export function buildVideoArgs<C extends VideoContainer>(
  params: BuildVideoArgsParams<C>,
): string[] {
  const codec = params.videoCodec;
  const audioCodec = params.audioCodec as string;

  return buildRawArgs({
    inputPath: params.inputPath,
    outputPath: params.outputPath,
    videoCodec: codec,
    audioCodec,
    quality: { flag: VIDEO_CODECS[codec].quality.flag, value: params.crf },
    extraVideoFlags: videoFlagsFor(codec, params.speed),
    audioBitrate: resolveAudioBitrate(audioCodec, params.sourceAudioBitrate ?? null),
    fps: params.fps,
    resize: params.resize,
    faststart: params.container === ".mp4" || params.container === ".mov",
  });
}

export interface BuildOpenVideoArgsParams {
  readonly inputPath: string;
  readonly outputPath: string;
  /** Extension of a container outside the curated matrix. */
  readonly extension: string;
  /** `null` hands the choice to ffmpeg's own muxer default. */
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly quality: Quality;
  readonly speed?: string | undefined;
  readonly fps?: number | undefined;
  readonly resize?: ResizeOptions | undefined;
  readonly sourceAudioBitrate?: number | null | undefined;
}

/**
 * Build arguments for any container ffmpeg can mux.
 *
 * There is no compile-time guarantee here — there cannot be, for a set
 * discovered from the binary at runtime. Safety comes from deferring instead:
 * when the codec is unknown nothing is forced, and ffmpeg applies the muxer's
 * own defaults, which are correct by construction.
 */
export function buildOpenVideoArgs(params: BuildOpenVideoArgsParams): string[] {
  const codec = params.videoCodec;
  const known = codec !== null && isKnownVideoCodec(codec);
  const model: QualityModel | null = known ? VIDEO_CODECS[codec].quality : null;

  return buildRawArgs({
    inputPath: params.inputPath,
    outputPath: params.outputPath,
    videoCodec: codec,
    audioCodec: params.audioCodec,
    quality: model
      ? { flag: model.flag, value: mapQuality(params.quality, model) }
      : null,
    extraVideoFlags: known ? videoFlagsFor(codec, params.speed) : [],
    audioBitrate:
      params.audioCodec === null
        ? null
        : resolveAudioBitrate(params.audioCodec, params.sourceAudioBitrate ?? null),
    fps: params.fps,
    resize: params.resize,
    faststart: [".mp4", ".mov", ".m4v"].includes(params.extension),
  });
}

/**
 * Scale to fit inside the requested box without upscaling.
 *
 * Commas inside a filter expression must be backslash-escaped or ffmpeg reads
 * them as option separators. `-2` keeps the aspect ratio while rounding to an
 * even number of pixels, which yuv420p requires.
 */
export function buildScaleFilter(resize?: ResizeOptions): string | null {
  const w = resize?.maxWidth;
  const h = resize?.maxHeight;
  if (w === undefined && h === undefined) return null;

  if (w !== undefined && h !== undefined) {
    return `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  }
  if (w !== undefined) return `scale=w=min(iw\\,${w}):h=-2`;
  return `scale=w=-2:h=min(ih\\,${h})`;
}

/** Curated path: validates the speed knob and maps quality onto the codec's CRF. */
export function curatedArgs<C extends VideoContainer>(params: {
  inputPath: string;
  outputPath: string;
  container: C;
  videoCodec: VideoCodecFor<C>;
  audioCodec: AudioCodecFor<C>;
  quality: Quality;
  speed?: string | undefined;
  fps?: number | undefined;
  resize?: ResizeOptions | undefined;
  sourceAudioBitrate?: number | null | undefined;
}): string[] {
  const codec = params.videoCodec;
  validateSpeed(codec, params.speed);

  return buildVideoArgs({
    inputPath: params.inputPath,
    outputPath: params.outputPath,
    container: params.container,
    videoCodec: params.videoCodec,
    audioCodec: params.audioCodec,
    crf: qualityToCrf(params.quality, codec),
    speed: params.speed,
    fps: params.fps,
    resize: params.resize,
    sourceAudioBitrate: params.sourceAudioBitrate,
  });
}

export function validateSpeed(codec: VideoCodec, speed: string | undefined): void {
  if (speed === undefined) return;
  const spec = codecSpec(codec);

  if (spec.speedFlag === null) {
    throw new CompressorError(
      "INVALID_OPTION",
      `${spec.label} has no speed preset; drop --preset.`,
    );
  }

  if (spec.namedPresets) {
    if (!spec.namedPresets.includes(speed)) {
      throw new CompressorError(
        "INVALID_OPTION",
        `--preset for ${spec.label} must be one of: ${spec.namedPresets.join(", ")}`,
      );
    }
    return;
  }

  const numeric = Number(speed);
  const max = spec.numericSpeedMax ?? 8;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > max) {
    throw new CompressorError(
      "INVALID_OPTION",
      `--preset for ${spec.label} must be a whole number from 0 to ${max}.`,
    );
  }
}

export interface EncodeVideoParams {
  readonly tools: FfmpegTools;
  readonly inputPath: string;
  readonly outputPath: string;
  /** Pre-built argument vector from one of the builders above. */
  readonly args: readonly string[];
  /** From the caller's probe, used to turn ffmpeg's clock into a percentage. */
  readonly durationSeconds?: number | null | undefined;
  readonly onProgress?: ((ratio: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EncodeVideoResult {
  readonly bytes: number;
}

/** Run one encode, cleaning up the partial file if anything goes wrong. */
export async function encodeVideo(
  params: EncodeVideoParams,
): Promise<EncodeVideoResult> {
  const { tools, outputPath } = params;

  await mkdir(dirname(outputPath), { recursive: true });

  try {
    await runFfmpeg({
      ffmpeg: tools.ffmpeg,
      args: params.args,
      durationSeconds: params.durationSeconds ?? null,
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (err) {
    // A half-written file is worse than none: it looks like a successful run.
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const info = await stat(outputPath);
  return { bytes: info.size };
}
