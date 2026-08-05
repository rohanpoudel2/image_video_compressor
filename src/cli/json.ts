import { imageCapabilities } from "../codecs/sharp-capabilities.js";
import { ffmpegCapabilities, muxerDetail } from "../codecs/ffmpeg-capabilities.js";
import { resolveFfmpeg } from "../codecs/ffmpeg.js";
import {
  VIDEO_CONTAINERS,
  VIDEO_CODECS,
  AUDIO_CODECS,
  COMMON_VIDEO_EXTENSIONS,
} from "../types/video-formats.js";
import { IMAGE_INPUT_ONLY_FORMATS } from "../types/image-formats.js";
import type { CompressionReport, ErrorCode } from "../types/results.js";

/**
 * Bump on any breaking change to the shapes below. Consumers — especially
 * automated ones — can pin behaviour to a version instead of guessing whether
 * a field means what it did last release.
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * Machine-readable output.
 *
 * The contract for `--json`: stdout carries exactly one JSON document and
 * nothing else, so `imgvidcompress ... --json | jq` always works. Every human
 * message — progress, warnings, the summary table — goes to stderr. This is
 * what makes the tool safe to drive from a script or an agent, where a stray
 * banner on stdout would corrupt the parse.
 */
export function emitReport(report: CompressionReport): void {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    ok: report.summary.failed === 0,
    dryRun: report.dryRun,
    summary: {
      ...report.summary,
      // Round for stable diffs; callers wanting exact bytes have the byte fields.
      savedRatio: round(report.summary.savedRatio),
      durationMs: Math.round(report.summary.durationMs),
    },
    results: report.results.map((result) =>
      result.status === "compressed"
        ? {
            ...result,
            savedRatio: round(result.savedRatio),
            durationMs: Math.round(result.durationMs),
          }
        : result,
    ),
    ...(report.ffmpegPath ? { ffmpegPath: report.ffmpegPath } : {}),
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function emitError(code: ErrorCode, message: string, detail?: string): void {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code, message, ...(detail ? { detail } : {}) },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export interface CapabilityReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly image: {
    readonly read: readonly string[];
    readonly write: readonly {
      extensions: readonly string[];
      label: string;
      supportsQuality: boolean;
      supportsAnimation: boolean;
    }[];
    readonly readOnly: readonly string[];
  };
  readonly video: {
    readonly available: boolean;
    readonly ffmpeg: string | null;
    readonly ffmpegVersion: string | null;
    readonly curated: readonly {
      extension: string;
      label: string;
      videoCodecs: readonly string[];
      audioCodecs: readonly string[];
    }[];
    readonly muxerCount: number;
    readonly demuxerCount: number;
    readonly videoEncoders: readonly string[];
    readonly audioEncoders: readonly string[];
    readonly commonInputExtensions: readonly string[];
  };
}

/**
 * Report what this installation can actually do.
 *
 * Every number here is read from the running sharp and ffmpeg rather than from
 * a list in the source, because both are build-dependent: JP2, JXL and HEIC are
 * routinely missing from sharp, and a minimal ffmpeg carries a fraction of the
 * muxers a Homebrew one does. A caller — human or agent — can discover the real
 * constraints instead of hardcoding assumptions that are wrong on some machines.
 */
export async function collectCapabilities(
  ffmpegPath?: string,
): Promise<CapabilityReport> {
  const images = await imageCapabilities();

  let video: CapabilityReport["video"] = {
    available: false,
    ffmpeg: null,
    ffmpegVersion: null,
    curated: [],
    muxerCount: 0,
    demuxerCount: 0,
    videoEncoders: [],
    audioEncoders: [],
    commonInputExtensions: [...COMMON_VIDEO_EXTENSIONS],
  };

  try {
    const tools = await resolveFfmpeg(ffmpegPath);
    const caps = await ffmpegCapabilities(tools.ffmpeg);

    // Only advertise a curated container if the binary really has its muxer.
    const curated = await Promise.all(
      Object.entries(VIDEO_CONTAINERS).map(async ([ext, spec]) => {
        const present =
          caps.muxers.has(spec.muxer) ||
          (await muxerDetail(tools.ffmpeg, spec.muxer)) !== null;
        return present
          ? {
              extension: ext,
              label: spec.label,
              videoCodecs: spec.video.filter((c) => caps.videoEncoders.has(c)),
              audioCodecs: spec.audio.filter(
                (c) => c === "copy" || caps.audioEncoders.has(c),
              ),
            }
          : null;
      }),
    );

    video = {
      available: true,
      ffmpeg: tools.ffmpeg,
      ffmpegVersion: tools.version,
      curated: curated.filter((c) => c !== null),
      muxerCount: caps.muxers.size,
      demuxerCount: caps.demuxers.size,
      videoEncoders: [...caps.videoEncoders].sort(),
      audioEncoders: [...caps.audioEncoders].sort(),
      commonInputExtensions: [...COMMON_VIDEO_EXTENSIONS],
    };
  } catch {
    // ffmpeg absent: images still work, so this is a partial report, not a failure.
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    image: {
      read: [...images.readableExtensions].sort(),
      write: images.writable.map((c) => ({
        extensions: c.extensions,
        label: c.label,
        supportsQuality: c.supportsQuality,
        supportsAnimation: c.supportsAnimation,
      })),
      readOnly: [...IMAGE_INPUT_ONLY_FORMATS],
    },
    video,
  };
}

export async function emitFormats(ffmpegPath?: string): Promise<void> {
  const report = await collectCapabilities(ffmpegPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** Static reference data, independent of what any binary supports. */
export const REFERENCE = {
  curatedVideoCodecs: VIDEO_CODECS,
  audioCodecs: AUDIO_CODECS,
} as const;

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
