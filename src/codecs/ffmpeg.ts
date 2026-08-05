import { spawn } from "node:child_process";
import { CompressorError } from "../core/errors.js";

export interface FfmpegTools {
  readonly ffmpeg: string;
  /** Null when ffprobe is absent; we then encode without a progress percentage. */
  readonly ffprobe: string | null;
  readonly version: string;
}

let cached: FfmpegTools | null = null;

/**
 * Locate ffmpeg, checking an explicit path, then `$FFMPEG_PATH`, then `$PATH`.
 *
 * v1 deferred this until mid-encode, so a missing binary surfaced as a raw
 * `Error: Cannot find ffmpeg` stack trace once per file — the single most
 * common complaint, prominent enough that the README had a section for it.
 * Resolving up front means one clear, install-specific message instead.
 */
export async function resolveFfmpeg(explicitPath?: string): Promise<FfmpegTools> {
  if (!explicitPath && cached) return cached;

  const candidate = explicitPath ?? process.env["FFMPEG_PATH"] ?? "ffmpeg";
  const version = await probeVersion(candidate);

  if (version === null) {
    throw new CompressorError("FFMPEG_NOT_FOUND", ffmpegMissingMessage(candidate));
  }

  const probeCandidate = explicitPath
    ? explicitPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"))
    : (process.env["FFPROBE_PATH"] ?? "ffprobe");

  const tools: FfmpegTools = {
    ffmpeg: candidate,
    ffprobe: (await probeVersion(probeCandidate)) === null ? null : probeCandidate,
    version,
  };

  if (!explicitPath) cached = tools;
  return tools;
}

/** Test-only: forget the memoised lookup. */
export function resetFfmpegCache(): void {
  cached = null;
}

function ffmpegMissingMessage(tried: string): string {
  const install =
    process.platform === "darwin"
      ? "  brew install ffmpeg"
      : process.platform === "win32"
        ? "  winget install Gyan.FFmpeg"
        : "  sudo apt install ffmpeg    # or your distro's package manager";

  return [
    `ffmpeg was not found (tried "${tried}").`,
    "",
    "Install it with:",
    install,
    "",
    "Or point at an existing binary with --ffmpeg-path <path> or FFMPEG_PATH=<path>.",
  ].join("\n");
}

function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => {
      if (code !== 0) return resolvePromise(null);
      resolvePromise(out.split("\n")[0]?.trim() ?? "unknown");
    });
  });
}

/** Source duration in seconds, used to turn ffmpeg's output clock into a ratio. */
export async function probeDuration(
  ffprobe: string,
  file: string,
): Promise<number | null> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ];

  return new Promise((resolvePromise) => {
    const child = spawn(ffprobe, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", () => {
      const seconds = Number.parseFloat(out.trim());
      resolvePromise(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}

export interface RunFfmpegOptions {
  readonly ffmpeg: string;
  readonly args: readonly string[];
  readonly durationSeconds: number | null;
  readonly onProgress?: (ratio: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Run one encode to completion.
 *
 * `-progress pipe:1` gives structured key=value progress on stdout, which is
 * far more robust than scraping the human-readable stderr status line that
 * fluent-ffmpeg parsed — and it keeps stderr clean for actual diagnostics.
 */
export function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  const { ffmpeg, args, durationSeconds, onProgress, signal } = options;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Never inherit stdin: ffmpeg reads keypresses and would swallow the
      // parent's input when this runs inside a shell pipeline.
      ...(signal ? { signal } : {}),
    });

    let stderr = "";
    let stdoutBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (!onProgress || !durationSeconds) return;
      stdoutBuffer += chunk.toString();

      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const micros = parseOutTime(line);
        if (micros === null) continue;
        const ratio = micros / 1_000_000 / durationSeconds;
        onProgress(Math.min(1, Math.max(0, ratio)));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // Bound retained stderr; encoder spew on a broken file can run to megabytes.
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new CompressorError("FFMPEG_NOT_FOUND", ffmpegMissingMessage(ffmpeg)));
        return;
      }
      reject(new CompressorError("FFMPEG_FAILED", err.message));
    });

    child.on("close", (code, sig) => {
      if (code === 0) {
        onProgress?.(1);
        resolvePromise();
        return;
      }
      if (sig) {
        reject(
          new CompressorError("FFMPEG_FAILED", `ffmpeg terminated by signal ${sig}`),
        );
        return;
      }
      reject(
        new CompressorError(
          "FFMPEG_FAILED",
          summariseFfmpegError(stderr) ?? `ffmpeg exited with code ${String(code)}`,
          stderr.trim(),
        ),
      );
    });
  });
}

/** ffmpeg emits `out_time_us`; older builds only `out_time=HH:MM:SS.ms`. */
function parseOutTime(line: string): number | null {
  const us = /^out_time_us=(\d+)$/.exec(line.trim());
  if (us?.[1]) return Number(us[1]);

  const clock = /^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(line.trim());
  if (clock?.[1] && clock[2] && clock[3]) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    return seconds * 1_000_000;
  }
  return null;
}

/** Pull the one useful line out of ffmpeg's stderr, keeping the rest as detail. */
function summariseFfmpegError(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const known = lines.find((l) =>
    /only .* supported|Invalid|No such file|Unknown encoder|not supported|Error|Could not/i.test(
      l,
    ),
  );
  return known ?? lines.at(-1) ?? null;
}
