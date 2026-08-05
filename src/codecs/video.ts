import { mkdir, stat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { runFfmpeg, probeDuration, type FfmpegTools } from "./ffmpeg.js";
import { CompressorError } from "../core/errors.js";
import {
  VIDEO_CODECS,
  qualityToCrf,
  type AudioCodecFor,
  type VideoCodec,
  type VideoCodecFor,
  type VideoContainer,
} from "../types/video-formats.js";
import type { Crf, Quality } from "../types/brand.js";
import type { ResizeOptions } from "../types/results.js";

/**
 * Default encoder speed per codec.
 *
 * These are not interchangeable strings: x264/x265 take named presets, SVT-AV1
 * takes a number 0-13, and VP9 uses `-cpu-used` entirely. v1 passed
 * `-preset fast` to everything, which is meaningless for two of the four.
 */
const DEFAULT_SPEED = {
  libx264: "medium",
  libx265: "medium",
  libsvtav1: "8",
  "libvpx-vp9": "2",
} as const satisfies Record<VideoCodec, string>;

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
}

/**
 * Build the ffmpeg argument vector for one encode.
 *
 * Generic over the container, so the compiler rejects
 * `buildVideoArgs({ container: ".webm", videoCodec: "libx264" })` — the exact
 * combination v1 produced for every `--output=.webm` run, which ffmpeg refuses
 * to mux because WebM carries only VP8/VP9/AV1.
 */
export function buildVideoArgs<C extends VideoContainer>(
  params: BuildVideoArgsParams<C>,
): string[] {
  const { container, crf, resize, fps } = params;
  const videoCodec = params.videoCodec;
  const audioCodec = params.audioCodec as string;
  const speed = params.speed ?? DEFAULT_SPEED[videoCodec];

  const args: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    params.inputPath,
    "-progress",
    "pipe:1",
    "-c:v",
    videoCodec,
    "-crf",
    String(crf),
  ];

  switch (videoCodec) {
    case "libx264":
    case "libx265":
      args.push("-preset", speed);
      // 8-bit 4:2:0 is the only combination every player handles.
      args.push("-pix_fmt", "yuv420p");
      // Signal HEVC as hvc1 so QuickTime and Safari will play the result.
      if (videoCodec === "libx265") args.push("-tag:v", "hvc1");
      break;
    case "libsvtav1":
      args.push("-preset", speed);
      args.push("-pix_fmt", "yuv420p");
      break;
    case "libvpx-vp9":
      // Without `-b:v 0` libvpx treats -crf as a ceiling on top of a default
      // bitrate rather than as constant quality, and the file comes out far
      // larger than asked for. This flag is not optional.
      args.push("-b:v", "0");
      args.push("-cpu-used", speed);
      args.push("-row-mt", "1");
      break;
  }

  const filter = buildScaleFilter(resize);
  if (filter) args.push("-vf", filter);

  // Only cap the frame rate when explicitly asked. v1 hardcoded `.fps(30)`,
  // which judders 24fps film and throws away half of 60fps footage.
  if (fps !== undefined) args.push("-r", String(fps));

  if (audioCodec === "copy") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", audioCodec);
    args.push("-b:a", audioCodec === "libopus" ? "96k" : "128k");
  }

  // Move the index to the front so the file can start playing before it fully
  // downloads. Meaningless for Matroska/WebM, which are already streamable.
  if (container === ".mp4" || container === ".mov") {
    args.push("-movflags", "+faststart");
  }

  args.push(params.outputPath);
  return args;
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

export interface EncodeVideoParams<C extends VideoContainer> {
  readonly tools: FfmpegTools;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly container: C;
  readonly videoCodec: VideoCodecFor<C>;
  readonly audioCodec: AudioCodecFor<C>;
  readonly quality: Quality;
  readonly speed?: string | undefined;
  readonly fps?: number | undefined;
  readonly resize?: ResizeOptions | undefined;
  readonly onProgress?: ((ratio: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EncodeVideoResult {
  readonly bytes: number;
}

/** Encode one video, cleaning up the partial file if anything goes wrong. */
export async function encodeVideo<C extends VideoContainer>(
  params: EncodeVideoParams<C>,
): Promise<EncodeVideoResult> {
  const { tools, inputPath, outputPath } = params;

  const crf = qualityToCrf(params.quality, params.videoCodec);
  validateSpeed(params.videoCodec, params.speed);

  await mkdir(dirname(outputPath), { recursive: true });

  const duration = tools.ffprobe ? await probeDuration(tools.ffprobe, inputPath) : null;

  const args = buildVideoArgs({
    inputPath,
    outputPath,
    container: params.container,
    videoCodec: params.videoCodec,
    audioCodec: params.audioCodec,
    crf,
    speed: params.speed,
    fps: params.fps,
    resize: params.resize,
  });

  try {
    await runFfmpeg({
      ffmpeg: tools.ffmpeg,
      args,
      durationSeconds: duration,
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

function validateSpeed(codec: VideoCodec, speed: string | undefined): void {
  if (speed === undefined) return;

  const named = [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
    "placebo",
  ];

  if (codec === "libx264" || codec === "libx265") {
    if (!named.includes(speed)) {
      throw new CompressorError(
        "INVALID_OPTION",
        `--preset for ${VIDEO_CODECS[codec].label} must be one of: ${named.join(", ")}`,
      );
    }
    return;
  }

  const numeric = Number(speed);
  const max = codec === "libsvtav1" ? 13 : 8;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > max) {
    throw new CompressorError(
      "INVALID_OPTION",
      `--preset for ${VIDEO_CODECS[codec].label} must be a whole number from 0 to ${max}.`,
    );
  }
}
