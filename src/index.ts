/**
 * image-and-video-compressor — programmatic API.
 *
 * v1 set `"main": "cli.js"`, so importing the package *ran the CLI*, argv
 * parsing and all. There was no way to use it from a build script. The CLI is
 * now one consumer of this module rather than the package itself.
 *
 * @example
 * ```ts
 * import { compressImages } from "image-and-video-compressor";
 *
 * const report = await compressImages(["./photos"], {
 *   quality: toQuality(80),
 *   to: ".avif",
 *   resize: { maxWidth: toPixels(2000) },
 * });
 *
 * console.log(`Saved ${report.summary.savedBytes} bytes`);
 * ```
 */

export {
  compress,
  compressImages,
  compressVideos,
  summarise,
  DEFAULT_OUTPUT_DIRNAME,
} from "./core/compress.js";

export {
  discoverFiles,
  classify,
  type DiscoveredFile,
  type DiscoverOptions,
} from "./core/discover.js";
export { mapWithConcurrency, cpuCount, defaultConcurrency } from "./core/pool.js";
export { CompressorError, toFailure } from "./core/errors.js";

export { resolveFfmpeg, probeDuration, type FfmpegTools } from "./codecs/ffmpeg.js";

export { buildVideoArgs, buildScaleFilter } from "./codecs/video.js";

// --- Types: quality/dimension scales ---
export {
  toQuality,
  toPixels,
  RangeValidationError,
  QUALITY_MIN,
  QUALITY_MAX,
  type Quality,
  type Crf,
  type Pixels,
  type Brand,
} from "./types/brand.js";

// --- Types: image formats ---
export {
  IMAGE_FORMATS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_INPUT_FORMATS,
  isImageOutputFormat,
  isImageInputFormat,
  isInputOnlyImageFormat,
  imageFormatSpec,
  type ImageOutputFormat,
  type ImageInputFormat,
} from "./types/image-formats.js";

// --- Types: video containers and codecs ---
export {
  VIDEO_CONTAINERS,
  VIDEO_CODECS,
  AUDIO_CODECS,
  VIDEO_OUTPUT_FORMATS,
  VIDEO_INPUT_FORMATS,
  isVideoContainer,
  isVideoInputFormat,
  isCodecAllowedIn,
  defaultVideoCodec,
  defaultAudioCodec,
  qualityToCrf,
  type VideoContainer,
  type VideoCodec,
  type AudioCodec,
  type VideoCodecFor,
  type AudioCodecFor,
  type VideoInputFormat,
} from "./types/video-formats.js";

// --- Types: results ---
export {
  isCompressed,
  isSkipped,
  isFailed,
  type MediaKind,
  type CompressionJob,
  type CompressionReport,
  type CompressionSummary,
  type CommonOptions,
  type ImageOptions,
  type VideoOptions,
  type JobResult,
  type JobFailure,
  type CompressedResult,
  type SkippedResult,
  type FailedResult,
  type SkipReason,
  type ErrorCode,
  type ProgressEvent,
  type ResizeOptions,
} from "./types/results.js";
