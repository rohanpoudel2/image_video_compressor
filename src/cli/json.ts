import {
  IMAGE_FORMATS,
  IMAGE_INPUT_FORMATS,
  IMAGE_OUTPUT_FORMATS,
} from "../types/image-formats.js";
import {
  VIDEO_CONTAINERS,
  VIDEO_CODECS,
  AUDIO_CODECS,
  VIDEO_INPUT_FORMATS,
} from "../types/video-formats.js";
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

/**
 * Capability listing.
 *
 * Lets a caller discover what this build actually supports rather than
 * hardcoding a format list that may drift — including the input/output
 * asymmetry (SVG and HEIC decode, but never encode) that v1 got wrong.
 */
export function emitFormats(): void {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    image: {
      input: IMAGE_INPUT_FORMATS,
      output: IMAGE_OUTPUT_FORMATS,
      details: IMAGE_FORMATS,
    },
    video: {
      input: VIDEO_INPUT_FORMATS,
      output: Object.entries(VIDEO_CONTAINERS).map(([ext, spec]) => ({
        extension: ext,
        label: spec.label,
        videoCodecs: spec.video,
        audioCodecs: spec.audio,
      })),
      codecs: VIDEO_CODECS,
      audioCodecs: AUDIO_CODECS,
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
