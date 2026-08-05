/**
 * image-and-video-compressor — programmatic API.
 *
 * v1 set `"main": "cli.js"`, so importing the package *ran the CLI*, argv
 * parsing and all. There was no way to use it from a build script. The CLI is
 * now one consumer of this module rather than the package itself.
 *
 * @example
 * ```ts
 * import { compressImages, toQuality, toPixels } from "image-and-video-compressor";
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
  classifyFile,
  classifyByExtension,
  extensionIndex,
  resetExtensionIndex,
  type DiscoveredFile,
  type DiscoverOptions,
  type ExtensionIndex,
} from "./core/discover.js";

export { mapWithConcurrency, cpuCount, defaultConcurrency } from "./core/pool.js";
export { CompressorError, toFailure } from "./core/errors.js";
export { sniff, sniffFile, type SniffResult } from "./core/sniff.js";

// --- Capability detection: what this machine can actually do ---
export {
  imageCapabilities,
  encodeOptionsFor,
  resetImageCapabilities,
  type ImageCapabilities,
  type ImageFormatCapability,
  type SharpFormatId,
} from "./codecs/sharp-capabilities.js";

export {
  ffmpegCapabilities,
  muxerDetail,
  parseFormats,
  parseEncoders,
  parseMuxerDetail,
  resetFfmpegCapabilities,
  type FfmpegCapabilities,
  type MuxerInfo,
  type MuxerDetail,
} from "./codecs/ffmpeg-capabilities.js";

export { resolveFfmpeg, probeDuration, type FfmpegTools } from "./codecs/ffmpeg.js";
export { resolveImageTarget } from "./codecs/image.js";
export {
  buildVideoArgs,
  buildOpenVideoArgs,
  buildScaleFilter,
  curatedArgs,
  validateSpeed,
} from "./codecs/video.js";

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
  CURATED_IMAGE_FORMATS,
  IMAGE_INPUT_ONLY_FORMATS,
  isCuratedImageFormat,
  isInputOnlyImageFormat,
  type CuratedImageFormat,
  type ImageOutputFormat,
  type ImageInputOnlyFormat,
} from "./types/image-formats.js";

// --- Types: video containers and codecs ---
export {
  VIDEO_CONTAINERS,
  VIDEO_CODECS,
  AUDIO_CODECS,
  VIDEO_OUTPUT_FORMATS,
  COMMON_VIDEO_EXTENSIONS,
  isVideoContainer,
  isKnownVideoCodec,
  isCodecAllowedIn,
  defaultVideoCodec,
  defaultAudioCodec,
  qualityToCrf,
  qualityModelFor,
  mapQuality,
  codecSpec,
  type VideoContainer,
  type VideoOutputSpec,
  type VideoCodec,
  type AudioCodec,
  type VideoCodecFor,
  type AudioCodecFor,
  type QualityModel,
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
  type CompressOptions,
  type ImageOptions,
  type VideoOptions,
  type ImageTuning,
  type VideoTuning,
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
