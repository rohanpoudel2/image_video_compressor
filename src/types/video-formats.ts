import { unsafeCrf, type Crf, type Quality } from "./brand.js";

/**
 * Video container/codec knowledge.
 *
 * Two tiers, deliberately:
 *
 * 1. A **curated** matrix of containers we have verified compatibility for.
 *    These carry the compile-time guarantee — `buildVideoArgs` is generic over
 *    the container, so `.webm` with `libx264` does not compile. That pairing is
 *    what v1 emitted for every WebM run, and ffmpeg refuses to mux it.
 *
 * 2. An **open** tier for everything else ffmpeg can mux. A stock build has
 *    184 muxers; enumerating them here would be both wrong and perpetually out
 *    of date, so those are resolved from the binary at runtime
 *    (see `ffmpeg-capabilities.ts`) and fall back to ffmpeg's own defaults.
 *
 * The curated tier exists to be *safe and well-tuned*, not to be a limit.
 */

/**
 * How a codec expresses quality.
 *
 * `best` and `worst` are the values the 1-100 scale maps onto, and their order
 * encodes the direction: CRF and qscale count down (lower is better), while
 * libtheora's `-q:v` counts up. Storing endpoints rather than a direction flag
 * means one formula handles every codec.
 *
 * `best` is deliberately not the codec's technical optimum. CRF 0 is
 * mathematically lossless and reliably produces a file several times larger
 * than the input — on a compressor, `--quality 100` meaning "make this bigger"
 * is a trap, so the scale tops out at visually lossless instead.
 */
export interface QualityModel {
  readonly flag: string;
  readonly best: number;
  readonly worst: number;
  /** Technical limits, used to clamp so the encoder never sees a bad value. */
  readonly min: number;
  readonly max: number;
}

interface CodecSpec {
  readonly quality: QualityModel;
  readonly label: string;
  /** Encoder speed knob and its default, when the codec has one. */
  readonly speedFlag: string | null;
  readonly defaultSpeed: string | null;
  /** Named presets, or null when the knob takes a number. */
  readonly namedPresets: readonly string[] | null;
  readonly numericSpeedMax: number | null;
}

const X26X_PRESETS = [
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
] as const;

const crf = (best: number, worst: number, max: number): QualityModel => ({
  flag: "-crf",
  best,
  worst,
  min: 0,
  max,
});

/**
 * Curated video encoders.
 *
 * Not an exhaustive list of what ffmpeg can do — it is the set we know how to
 * drive well. Anything else the binary reports is still usable via `--codec`.
 */
export const VIDEO_CODECS = {
  libx264: {
    quality: crf(17, 45, 51),
    label: "H.264",
    speedFlag: "-preset",
    defaultSpeed: "medium",
    namedPresets: X26X_PRESETS,
    numericSpeedMax: null,
  },
  libx265: {
    quality: crf(20, 45, 51),
    label: "H.265 / HEVC",
    speedFlag: "-preset",
    defaultSpeed: "medium",
    namedPresets: X26X_PRESETS,
    numericSpeedMax: null,
  },
  "libvpx-vp9": {
    quality: crf(20, 55, 63),
    label: "VP9",
    speedFlag: "-cpu-used",
    defaultSpeed: "2",
    namedPresets: null,
    numericSpeedMax: 8,
  },
  libvpx: {
    quality: crf(20, 55, 63),
    label: "VP8",
    speedFlag: "-cpu-used",
    defaultSpeed: "2",
    namedPresets: null,
    numericSpeedMax: 16,
  },
  libsvtav1: {
    quality: crf(20, 55, 63),
    label: "AV1 (SVT)",
    speedFlag: "-preset",
    defaultSpeed: "8",
    namedPresets: null,
    numericSpeedMax: 13,
  },
  "libaom-av1": {
    quality: crf(20, 55, 63),
    label: "AV1 (libaom)",
    speedFlag: "-cpu-used",
    defaultSpeed: "6",
    namedPresets: null,
    numericSpeedMax: 8,
  },
  mpeg4: {
    // qscale, not CRF: 1 is best, 31 is worst.
    quality: { flag: "-q:v", best: 2, worst: 25, min: 1, max: 31 },
    label: "MPEG-4 Part 2",
    speedFlag: null,
    defaultSpeed: null,
    namedPresets: null,
    numericSpeedMax: null,
  },
  libtheora: {
    // The one common encoder where a *higher* number is better quality.
    quality: { flag: "-q:v", best: 9, worst: 3, min: 0, max: 10 },
    label: "Theora",
    speedFlag: null,
    defaultSpeed: null,
    namedPresets: null,
    numericSpeedMax: null,
  },
} as const satisfies Record<string, CodecSpec>;

export type VideoCodec = keyof typeof VIDEO_CODECS;

export const AUDIO_CODECS = {
  aac: { label: "AAC", defaultBitrate: "128k" },
  libopus: { label: "Opus", defaultBitrate: "96k" },
  libmp3lame: { label: "MP3", defaultBitrate: "192k" },
  libvorbis: { label: "Vorbis", defaultBitrate: "128k" },
  flac: { label: "FLAC", defaultBitrate: null },
  copy: { label: "passthrough", defaultBitrate: null },
} as const;

export type AudioCodec = keyof typeof AUDIO_CODECS;

interface ContainerSpec {
  readonly video: readonly VideoCodec[];
  readonly audio: readonly AudioCodec[];
  readonly label: string;
  /** ffmpeg muxer name, when it differs from the extension. */
  readonly muxer: string;
}

export const VIDEO_CONTAINERS = {
  ".mp4": {
    video: ["libx264", "libx265", "libsvtav1", "libaom-av1"],
    audio: ["aac", "libmp3lame", "flac", "copy"],
    label: "MP4",
    muxer: "mp4",
  },
  ".mkv": {
    video: ["libx264", "libx265", "libsvtav1", "libaom-av1", "libvpx-vp9", "libvpx"],
    audio: ["aac", "libopus", "libmp3lame", "libvorbis", "flac", "copy"],
    label: "Matroska",
    muxer: "matroska",
  },
  ".mov": {
    video: ["libx264", "libx265"],
    audio: ["aac", "copy"],
    label: "QuickTime",
    muxer: "mov",
  },
  ".webm": {
    // No H.264 here — that is the whole point.
    video: ["libvpx-vp9", "libsvtav1", "libaom-av1", "libvpx"],
    audio: ["libopus", "libvorbis"],
    label: "WebM",
    muxer: "webm",
  },
  ".avi": {
    video: ["libx264", "mpeg4"],
    audio: ["libmp3lame", "copy"],
    label: "AVI",
    muxer: "avi",
  },
  ".ogv": {
    video: ["libtheora"],
    audio: ["libvorbis", "libopus"],
    label: "Ogg Video",
    muxer: "ogv",
  },
} as const satisfies Record<`.${string}`, ContainerSpec>;

export type VideoContainer = keyof typeof VIDEO_CONTAINERS;

/**
 * The video codecs legal for a given container, as a type.
 *
 * `VideoCodecFor<".webm">` excludes `"libx264"`, so passing the two together
 * is a compile error rather than a corrupt file.
 */
export type VideoCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["video"][number];

export type AudioCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["audio"][number];

/**
 * The container's preferred codec. Indexing the readonly tuple at `0` rather
 * than `[number]` keeps the result a single literal.
 */
export type DefaultVideoCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["video"][0];

export type DefaultAudioCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["audio"][0];

export function defaultVideoCodec<C extends VideoContainer>(
  container: C,
): DefaultVideoCodecFor<C> {
  return VIDEO_CONTAINERS[container].video[0];
}

export function defaultAudioCodec<C extends VideoContainer>(
  container: C,
): DefaultAudioCodecFor<C> {
  return VIDEO_CONTAINERS[container].audio[0];
}

export const VIDEO_OUTPUT_FORMATS = Object.keys(VIDEO_CONTAINERS) as VideoContainer[];

/**
 * Accepts any string while still offering the curated containers as
 * autocomplete suggestions.
 *
 * `string & {}` is the standard trick for widening a literal union without
 * collapsing the literals — the editor still suggests `".mp4"`, but a muxer
 * discovered from the binary at runtime is equally valid.
 */
export type VideoOutputSpec = VideoContainer | (string & {});

export function isVideoContainer(ext: string): ext is VideoContainer {
  return Object.prototype.hasOwnProperty.call(VIDEO_CONTAINERS, ext);
}

export function isKnownVideoCodec(codec: string): codec is VideoCodec {
  return Object.prototype.hasOwnProperty.call(VIDEO_CODECS, codec);
}

/** Runtime counterpart to {@link VideoCodecFor}, for user-supplied strings. */
export function isCodecAllowedIn(container: VideoContainer, codec: string): boolean {
  return (VIDEO_CONTAINERS[container].video as readonly string[]).includes(codec);
}

/**
 * Extensions commonly seen for video, used as a fast path before consulting
 * ffmpeg. Not a limit: discovery also accepts anything the binary can demux,
 * and falls back to content sniffing.
 */
export const COMMON_VIDEO_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mkv",
  ".mov",
  ".webm",
  ".avi",
  ".ogv",
  ".ogg",
  ".mpg",
  ".mpeg",
  ".m2v",
  ".mts",
  ".m2ts",
  ".ts",
  ".wmv",
  ".asf",
  ".flv",
  ".f4v",
  ".3gp",
  ".3g2",
  ".rm",
  ".rmvb",
  ".vob",
  ".divx",
  ".mxf",
  ".dv",
  ".y4m",
  ".gxf",
  ".nut",
  ".roq",
  ".ivf",
] as const;

/**
 * Map a 1-100 quality onto a codec's own scale.
 *
 * v1 used `100 - quality`, which is wrong twice over: it produced CRF 90 for
 * `--quality=10` (x264 tops out at 51) and CRF 0 for `--quality=100`, which is
 * lossless and larger than the source. Codecs also disagree about both range
 * and direction — libtheora's scale runs the opposite way — so a single linear
 * formula could never have been right for all of them.
 */
export function qualityToCrf(quality: Quality, codec: VideoCodec): Crf {
  return unsafeCrf(mapQuality(quality, VIDEO_CODECS[codec].quality));
}

/** Same mapping, for a quality model resolved at runtime. */
export function mapQuality(quality: Quality, model: QualityModel): number {
  const ratio = (quality - 1) / 99;
  const value = Math.round(model.worst + ratio * (model.best - model.worst));
  return Math.min(model.max, Math.max(model.min, value));
}

export function qualityModelFor(codec: string): QualityModel | null {
  return isKnownVideoCodec(codec) ? VIDEO_CODECS[codec].quality : null;
}

export function codecSpec(codec: VideoCodec): CodecSpec {
  return VIDEO_CODECS[codec];
}
