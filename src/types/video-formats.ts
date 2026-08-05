import { unsafeCrf, type Crf, type Quality } from "./brand.js";

/**
 * Video container/codec compatibility matrix.
 *
 * v1 hardcoded `libx264` for every output container, so `--output=.webm`
 * produced a file ffmpeg refuses to mux: WebM accepts only VP8/VP9/AV1 video
 * and Vorbis/Opus audio. The failure surfaced as a raw ffmpeg stderr dump.
 *
 * Here the legal codecs are a property *of the container*, and the encoder
 * entry point is generic over the container, so `encodeArgs(".webm", "libx264")`
 * is rejected by the compiler. An invalid pairing is now unrepresentable.
 */

/**
 * Per-codec CRF facts.
 *
 * `crfMin`/`crfMax` are the codec's true technical limits, used for validation.
 * `bestCrf`/`worstCrf` are the narrower window the 1-100 quality scale maps
 * onto, and they are deliberately not the same thing.
 *
 * CRF 0 is *mathematically lossless*: on most sources it produces a file
 * several times larger than the input. On a tool whose purpose is compression,
 * `--quality 100` meaning "reliably make this bigger" is a trap. The scale
 * therefore tops out at visually lossless instead.
 */
export const VIDEO_CODECS = {
  libx264: { crfMin: 0, crfMax: 51, bestCrf: 17, worstCrf: 45, label: "H.264" },
  libx265: {
    crfMin: 0,
    crfMax: 51,
    bestCrf: 20,
    worstCrf: 45,
    label: "H.265 / HEVC",
  },
  "libvpx-vp9": {
    crfMin: 0,
    crfMax: 63,
    bestCrf: 20,
    worstCrf: 55,
    label: "VP9",
  },
  libsvtav1: { crfMin: 0, crfMax: 63, bestCrf: 20, worstCrf: 55, label: "AV1" },
} as const;

export type VideoCodec = keyof typeof VIDEO_CODECS;

export const AUDIO_CODECS = {
  aac: { label: "AAC", defaultBitrate: "128k" },
  libopus: { label: "Opus", defaultBitrate: "96k" },
  copy: { label: "passthrough", defaultBitrate: null },
} as const;

export type AudioCodec = keyof typeof AUDIO_CODECS;

interface ContainerSpec {
  /** Video codecs this container can legally mux, preferred first. */
  readonly video: readonly VideoCodec[];
  /** Audio codecs this container can legally mux, preferred first. */
  readonly audio: readonly AudioCodec[];
  readonly label: string;
}

export const VIDEO_CONTAINERS = {
  ".mp4": {
    video: ["libx264", "libx265", "libsvtav1"],
    audio: ["aac", "copy"],
    label: "MP4",
  },
  ".mkv": {
    video: ["libx264", "libx265", "libsvtav1", "libvpx-vp9"],
    audio: ["aac", "libopus", "copy"],
    label: "Matroska",
  },
  ".mov": {
    video: ["libx264", "libx265"],
    audio: ["aac", "copy"],
    label: "QuickTime",
  },
  ".webm": {
    // No H.264 here — that is the whole point.
    video: ["libvpx-vp9", "libsvtav1"],
    audio: ["libopus"],
    label: "WebM",
  },
  ".avi": {
    video: ["libx264"],
    audio: ["copy"],
    label: "AVI",
  },
} as const satisfies Record<`.${string}`, ContainerSpec>;

export type VideoContainer = keyof typeof VIDEO_CONTAINERS;

/**
 * The video codecs legal for a given container, as a type.
 *
 * `VideoCodecFor<".webm">` is `"libvpx-vp9" | "libsvtav1"`, so passing
 * `"libx264"` alongside `".webm"` is a compile error rather than a corrupt file.
 */
export type VideoCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["video"][number];

export type AudioCodecFor<C extends VideoContainer> =
  (typeof VIDEO_CONTAINERS)[C]["audio"][number];

/**
 * The container's preferred codec. Indexing the readonly tuple at `0` rather
 * than using `[number]` keeps the result a single literal, so callers get
 * `"libvpx-vp9"` for WebM instead of the whole union.
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

/** Containers ffmpeg can demux for us even when we would not write them. */
export const VIDEO_INPUT_FORMATS = [
  ...VIDEO_OUTPUT_FORMATS,
  ".m4v",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".ts",
  ".3gp",
  ".ogv",
] as const satisfies readonly `.${string}`[];

export type VideoInputFormat = (typeof VIDEO_INPUT_FORMATS)[number];

export function isVideoContainer(ext: string): ext is VideoContainer {
  return Object.prototype.hasOwnProperty.call(VIDEO_CONTAINERS, ext);
}

export function isVideoInputFormat(ext: string): ext is VideoInputFormat {
  return (VIDEO_INPUT_FORMATS as readonly string[]).includes(ext);
}

/** Runtime counterpart to {@link VideoCodecFor}, for user-supplied strings. */
export function isCodecAllowedIn(
  container: VideoContainer,
  codec: string,
): codec is VideoCodec {
  return (VIDEO_CONTAINERS[container].video as readonly string[]).includes(codec);
}

/**
 * Map a 1-100 perceptual quality onto a codec's own CRF range.
 *
 * v1 used `100 - quality`, which is wrong twice over: it produced CRF 90 for
 * `--quality=10` (x264 tops out at 51) and CRF 0 for `--quality=100`, which is
 * mathematically lossless and reliably *larger* than the source. Each codec
 * also has its own scale — VP9 and AV1 run to 63, not 51 — so a single linear
 * formula could never have been right for all of them.
 */
export function qualityToCrf(quality: Quality, codec: VideoCodec): Crf {
  const { crfMin, crfMax, bestCrf, worstCrf } = VIDEO_CODECS[codec];
  // Invert: quality 100 -> bestCrf, quality 1 -> worstCrf.
  const ratio = (quality - 1) / 99;
  const crf = Math.round(worstCrf - ratio * (worstCrf - bestCrf));
  // Clamped against the technical limits, not the mapping window, so the
  // result is always a value the encoder will actually accept.
  return unsafeCrf(Math.min(crfMax, Math.max(crfMin, crf)));
}
