import type { ImageOutputFormat } from "./image-formats.js";
import type { VideoContainer, VideoCodec, AudioCodec } from "./video-formats.js";
import type { Pixels, Quality } from "./brand.js";

export type MediaKind = "image" | "video";

/** A single unit of work, resolved and validated before anything runs. */
export interface CompressionJob {
  readonly kind: MediaKind;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputBytes: number;
  readonly targetFormat: ImageOutputFormat | VideoContainer;
}

export type SkipReason =
  /** The compressed result was bigger than the original, so we kept the original. */
  | "output-larger-than-input"
  /** Destination already exists and --overwrite was not passed. */
  | "output-exists"
  /** Planned only; --dry-run was set. */
  | "dry-run";

export interface JobFailure {
  readonly message: string;
  /** Stable, machine-matchable identifier. Safe for agents to branch on. */
  readonly code: ErrorCode;
  /** Raw encoder stderr, when we have it. */
  readonly detail?: string;
}

export type ErrorCode =
  | "FFMPEG_NOT_FOUND"
  | "FFMPEG_FAILED"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "UNSUPPORTED_FORMAT"
  | "INPUT_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_OPTION"
  | "NO_INPUT_FILES"
  /** The run was cancelled by SIGINT/SIGTERM or an AbortSignal. */
  | "ABORTED"
  | "UNKNOWN";

/**
 * The outcome of one file, as a discriminated union.
 *
 * v1 used `Promise.all`, so a single bad file rejected the whole batch and the
 * remaining work was abandoned with no record of what had succeeded. Modelling
 * failure as a value rather than an exception means a run always produces a
 * complete report.
 */
export type JobResult =
  | ({ readonly status: "compressed" } & CompressedResult)
  | ({ readonly status: "skipped" } & SkippedResult)
  | ({ readonly status: "failed" } & FailedResult);

export interface CompressedResult {
  readonly kind: MediaKind;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  /** Positive when we saved space; negative if the output grew. */
  readonly savedBytes: number;
  /** Fraction of the original size removed, 0-1. */
  readonly savedRatio: number;
  readonly durationMs: number;
}

export interface SkippedResult {
  readonly kind: MediaKind;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputBytes: number;
  readonly reason: SkipReason;
}

export interface FailedResult {
  readonly kind: MediaKind;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly error: JobFailure;
}

/** Narrowing helpers, so consumers never hand-check `status`. */
export const isCompressed = (
  r: JobResult,
): r is { status: "compressed" } & CompressedResult => r.status === "compressed";

export const isSkipped = (r: JobResult): r is { status: "skipped" } & SkippedResult =>
  r.status === "skipped";

export const isFailed = (r: JobResult): r is { status: "failed" } & FailedResult =>
  r.status === "failed";

export interface CompressionSummary {
  readonly totalFiles: number;
  readonly compressed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly savedBytes: number;
  readonly savedRatio: number;
  readonly durationMs: number;
}

export interface CompressionReport {
  readonly summary: CompressionSummary;
  readonly results: readonly JobResult[];
  /** Absent unless the run touched video. */
  readonly ffmpegPath?: string;
  readonly dryRun: boolean;
}

/** Resize intent. `fit` mirrors sharp's semantics for the image path. */
export interface ResizeOptions {
  readonly maxWidth?: Pixels;
  readonly maxHeight?: Pixels;
  /** Never upscale a source that is already smaller than the target. */
  readonly withoutEnlargement?: boolean;
}

export interface CommonOptions {
  readonly quality?: Quality;
  readonly outDir?: string;
  readonly recursive?: boolean;
  readonly concurrency?: number;
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
  /** Keep the original when compression makes the file bigger. Default true. */
  readonly skipLarger?: boolean;
  readonly resize?: ResizeOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** Image-only knobs, factored out so the combined options type can reuse them. */
export interface ImageTuning {
  /** Apply EXIF orientation instead of leaving portrait shots sideways. */
  readonly autoRotate?: boolean;
  /** Preserve EXIF/ICC. Default false, since stripping saves real bytes. */
  readonly keepMetadata?: boolean;
}

export interface VideoTuning {
  readonly videoCodec?: VideoCodec;
  readonly audioCodec?: AudioCodec;
  /**
   * Cap the frame rate. Omitted by default — v1 forced every video to 30fps,
   * quietly ruining 24fps film and 60fps footage.
   */
  readonly fps?: number;
  readonly ffmpegPath?: string;
  /** Encoder speed/efficiency tradeoff. Codec-specific; sane default per codec. */
  readonly preset?: string;
}

export interface ImageOptions extends CommonOptions, ImageTuning {
  readonly to?: ImageOutputFormat;
}

export interface VideoOptions extends CommonOptions, VideoTuning {
  readonly to?: VideoContainer;
}

/**
 * Options for a mixed run.
 *
 * Deliberately *not* `ImageOptions & VideoOptions`: intersecting them reduces
 * `to` to `never`, because no string is both an image extension and a video
 * container. Widening the one conflicting field keeps `ImageOptions` and
 * `VideoOptions` assignable to this while each stays strict on its own.
 */
export interface CompressOptions extends CommonOptions, ImageTuning, VideoTuning {
  readonly to?: ImageOutputFormat | VideoContainer;
}

export type ProgressEvent =
  | { readonly type: "job-start"; readonly job: CompressionJob }
  | {
      readonly type: "job-progress";
      readonly job: CompressionJob;
      /** 0-1. Video only; images complete atomically. */
      readonly ratio: number;
    }
  | {
      readonly type: "job-done";
      readonly job: CompressionJob;
      readonly result: JobResult;
    };
