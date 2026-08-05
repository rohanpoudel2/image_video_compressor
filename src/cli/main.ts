import "./preflight.js";

import { Command, Option, InvalidArgumentError } from "commander";
import { createRequire } from "node:module";
import { join } from "node:path";
import pc from "picocolors";

import { compress, compressImages, compressVideos } from "../core/compress.js";
import { CompressorError } from "../core/errors.js";
import { toQuality, toPixels, RangeValidationError } from "../types/brand.js";
import {
  IMAGE_FORMATS,
  IMAGE_INPUT_FORMATS,
  IMAGE_OUTPUT_FORMATS,
} from "../types/image-formats.js";
import {
  VIDEO_CONTAINERS,
  VIDEO_CODECS,
  VIDEO_OUTPUT_FORMATS,
} from "../types/video-formats.js";
import { Renderer } from "./render.js";
import { emitReport, emitError, emitFormats } from "./json.js";
import type {
  CompressionReport,
  CompressOptions,
  ErrorCode,
  ImageOptions,
  MediaKind,
  VideoOptions,
} from "../types/results.js";

/**
 * Process exit codes.
 *
 * Distinct and documented so scripts and agents can branch without parsing
 * text. v1 exited 0 even when every file failed.
 */
export const EXIT = {
  OK: 0,
  /** The run completed but at least one file failed. */
  PARTIAL_FAILURE: 1,
  /** Bad flags, unsupported format, colliding outputs. */
  USAGE: 2,
  /** ffmpeg could not be located. */
  FFMPEG_MISSING: 3,
  /** Nothing matched the given paths. */
  NO_INPUT: 4,
} as const;

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "2.0.0";
  }
}

interface RawOptions {
  quality?: string;
  to?: string;
  out?: string;
  recursive?: boolean;
  concurrency?: string;
  maxWidth?: string;
  maxHeight?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
  skipLarger?: boolean;
  keepMetadata?: boolean;
  autoRotate?: boolean;
  codec?: string;
  audioCodec?: string;
  fps?: string;
  preset?: string;
  ffmpegPath?: string;
}

function integer(name: string, min: number, max: number) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new InvalidArgumentError(
        `${name} must be a whole number between ${min} and ${max}.`,
      );
    }
    return value;
  };
}

/** Options shared by every compression command. */
function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("-q, --quality <1-100>", "output quality; higher is better looking", "75")
    .option("-o, --out <dir>", "output directory (default: <source>/compressed)")
    .option("-r, --recursive", "descend into subdirectories", false)
    .option(
      "-c, --concurrency <n>",
      "files to process at once (default: based on CPU count)",
    )
    .option("--max-width <px>", "shrink anything wider than this")
    .option("--max-height <px>", "shrink anything taller than this")
    .option("--overwrite", "replace existing output files", false)
    .option("--dry-run", "show what would happen without writing anything", false)
    .option(
      "--json",
      "emit a JSON report on stdout; human output goes to stderr",
      false,
    )
    .option("--quiet", "suppress all non-error output", false)
    .option("--no-color", "disable coloured output")
    .option(
      "--no-skip-larger",
      "write the output even when it ends up bigger than the source",
    );
}

/**
 * Register `--to`.
 *
 * Kept separate from the tuning options because the auto-detect command mixes
 * image and video flags on one command, and commander rejects a duplicate
 * flag. The auto command therefore gets a single `--to` accepting both sets.
 */
function addToOption(cmd: Command, choices: readonly string[], label: string): Command {
  return cmd.addOption(
    new Option(`-t, --to <${label}>`, "output format").choices([...choices]),
  );
}

function addImageOptions(cmd: Command): Command {
  return cmd
    .option("--keep-metadata", "preserve EXIF/ICC instead of stripping it", false)
    .option("--no-auto-rotate", "do not apply EXIF orientation");
}

function addVideoOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option(
        "--codec <name>",
        "video codec (must be legal for the container)",
      ).choices(Object.keys(VIDEO_CODECS)),
    )
    .addOption(
      new Option("--audio-codec <name>", "audio codec").choices([
        "aac",
        "libopus",
        "copy",
      ]),
    )
    .option(
      "--fps <n>",
      "cap the frame rate (default: keep the source rate)",
      integer("--fps", 1, 240),
    )
    .option("--preset <name>", "encoder speed/efficiency tradeoff")
    .option("--ffmpeg-path <path>", "path to the ffmpeg binary");
}

/** Translate parsed flags into library options, validating ranges as we go. */
function toLibraryOptions(raw: RawOptions): CompressOptions {
  const options: Record<string, unknown> = {
    quality: toQuality(Number(raw.quality ?? 75)),
    recursive: raw.recursive ?? false,
    overwrite: raw.overwrite ?? false,
    dryRun: raw.dryRun ?? false,
    skipLarger: raw.skipLarger ?? true,
    autoRotate: raw.autoRotate ?? true,
    keepMetadata: raw.keepMetadata ?? false,
  };

  if (raw.out !== undefined) options["outDir"] = raw.out;
  if (raw.to !== undefined) options["to"] = raw.to;
  if (raw.codec !== undefined) options["videoCodec"] = raw.codec;
  if (raw.audioCodec !== undefined) options["audioCodec"] = raw.audioCodec;
  if (raw.preset !== undefined) options["preset"] = raw.preset;
  if (raw.ffmpegPath !== undefined) options["ffmpegPath"] = raw.ffmpegPath;
  if (raw.fps !== undefined) options["fps"] = Number(raw.fps);

  if (raw.concurrency !== undefined) {
    const value = Number(raw.concurrency);
    if (!Number.isInteger(value) || value < 1) {
      throw new CompressorError(
        "INVALID_OPTION",
        "--concurrency must be a positive whole number.",
      );
    }
    options["concurrency"] = value;
  }

  const maxWidth =
    raw.maxWidth === undefined
      ? undefined
      : toPixels(Number(raw.maxWidth), "--max-width");
  const maxHeight =
    raw.maxHeight === undefined
      ? undefined
      : toPixels(Number(raw.maxHeight), "--max-height");
  if (maxWidth !== undefined || maxHeight !== undefined) {
    options["resize"] = {
      ...(maxWidth !== undefined ? { maxWidth } : {}),
      ...(maxHeight !== undefined ? { maxHeight } : {}),
      withoutEnlargement: true,
    };
  }

  return options;
}

async function runCompression(
  kind: MediaKind | null,
  paths: string[],
  raw: RawOptions,
  cmd?: Command,
): Promise<number> {
  const useJson = raw.json ?? false;

  // A bare invocation is someone finding their footing, not a failed run.
  // Showing usage beats "No input paths given."
  if (paths.length === 0) {
    if (useJson) {
      emitError(
        "NO_INPUT_FILES",
        "No input paths given. Pass one or more files or directories.",
      );
    } else {
      (cmd ?? buildProgram()).outputHelp({ error: true });
    }
    return EXIT.NO_INPUT;
  }

  // In JSON mode every human-facing byte must stay off stdout.
  const renderer = new Renderer({ quiet: (raw.quiet ?? false) || useJson });

  const options = toLibraryOptions(raw);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const label =
    kind === "image" ? "images" : kind === "video" ? "videos" : "images and videos";
  renderer.banner("imgvidcompress", `compressing ${label}`);

  let announced = false;
  const withProgress: CompressOptions = {
    ...options,
    signal: controller.signal,
    onProgress: (event) => {
      if (!announced && event.type === "job-start") announced = true;
      renderer.handle(event);
    },
  };

  try {
    const report: CompressionReport =
      kind === "image"
        ? await compressImages(paths, withProgress as ImageOptions)
        : kind === "video"
          ? await compressVideos(paths, withProgress as VideoOptions)
          : await compress(paths, withProgress);

    renderer.finish();

    if (useJson) emitReport(report);
    else renderer.summary(report);

    return report.summary.failed > 0 ? EXIT.PARTIAL_FAILURE : EXIT.OK;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    renderer.finish();
  }
}

/**
 * Deprecated v1 entry points.
 *
 * These stay because the package has real installs whose scripts call them.
 * They map onto the v2 pipeline, so they inherit every fix — correct CRF
 * ranges, bounded concurrency, no crash when stdout is a pipe — while keeping
 * v1's output layout (`<loadFolder>/optimised_images`) and defaults so nothing
 * silently moves.
 */
function warnDeprecated(
  renderer: Renderer,
  oldCommand: string,
  replacement: string,
): void {
  renderer.warn(`"${oldCommand}" is deprecated and will be removed in v3.`);
  renderer.note(`  Use: ${pc.cyan(replacement)}`);
  renderer.note("  Your existing command still works — nothing to change today.\n");
}

interface LegacyRaw {
  loadFolder: string;
  quality: string;
  output: string;
  json?: boolean;
  quiet?: boolean;
}

async function runLegacy(kind: MediaKind, raw: LegacyRaw): Promise<number> {
  const useJson = raw.json ?? false;
  const renderer = new Renderer({ quiet: (raw.quiet ?? false) || useJson });

  const quality = Number(raw.quality);
  if (!Number.isInteger(quality) || quality < 10 || quality > 100) {
    // v1's range was 10-100; kept as-is so existing scripts behave identically.
    throw new CompressorError("INVALID_OPTION", "Quality must be between 10 and 100.");
  }

  const outputExt = raw.output.startsWith(".") ? raw.output : `.${raw.output}`;
  const loadFolder = raw.loadFolder.replace(/["']/g, "");
  const legacyDir = kind === "image" ? "optimised_images" : "optimised_videos";

  const newCommand = `imgvidcompress ${kind} "${loadFolder}" --quality ${quality} --to ${outputExt}`;
  warnDeprecated(renderer, `optimise:${kind}`, newCommand);

  return runCompression(kind, [loadFolder], {
    quality: String(quality),
    to: outputExt,
    out: join(loadFolder, legacyDir),
    ...(useJson ? { json: true } : {}),
    ...(raw.quiet ? { quiet: true } : {}),
  });
}

function printFormats(): void {
  const out = process.stdout;
  out.write(`\n  ${pc.bold(pc.cyan("Images"))}\n\n`);
  out.write(`  ${pc.dim("read: ")}${IMAGE_INPUT_FORMATS.join(" ")}\n`);
  out.write(`  ${pc.dim("write:")}\n`);
  for (const ext of IMAGE_OUTPUT_FORMATS) {
    const spec = IMAGE_FORMATS[ext];
    const traits = [
      spec.lossy ? "quality" : "lossless",
      spec.alpha ? "alpha" : null,
      spec.animated ? "animation" : null,
    ]
      .filter(Boolean)
      .join(", ");
    out.write(
      `    ${pc.green(ext.padEnd(7))} ${spec.label.padEnd(14)} ${pc.dim(traits)}\n`,
    );
  }

  out.write(`\n  ${pc.bold(pc.cyan("Videos"))}\n\n`);
  out.write(`  ${pc.dim("write:")}\n`);
  for (const [ext, spec] of Object.entries(VIDEO_CONTAINERS)) {
    out.write(
      `    ${pc.green(ext.padEnd(7))} ${spec.label.padEnd(14)} ${pc.dim(`video: ${spec.video.join(", ")}`)}\n`,
    );
  }
  out.write(
    `\n  ${pc.dim("Note: a container only accepts the codecs listed beside it —")}\n` +
      `  ${pc.dim("WebM cannot carry H.264, which is why .webm output needs VP9 or AV1.")}\n\n`,
  );
}

export function buildProgram(): Command {
  const program = new Command();

  // Must come before any .command() call: commander copies the exit callback
  // into subcommands at creation time. Without it commander calls
  // process.exit(1) itself for a bad flag, and the documented exit codes below
  // never get a chance to apply.
  program.exitOverride();

  program
    .name("imgvidcompress")
    .description("Compress images and videos — fast, in parallel, without surprises.")
    .version(version(), "-v, --version")
    .showHelpAfterError(pc.dim("(run with --help for usage)"));

  // --- default command: auto-detect by extension ---
  const auto = program
    .command("run [paths...]", { isDefault: true })
    .description("compress images and videos found at the given paths")
    .action(async (paths: string[], raw: RawOptions, cmd: Command) => {
      program.setOptionValue("exitCode", await runCompression(null, paths, raw, cmd));
    });
  addSharedOptions(auto);
  addToOption(auto, [...IMAGE_OUTPUT_FORMATS, ...VIDEO_OUTPUT_FORMATS], "format");
  addImageOptions(auto);
  addVideoOptions(auto);

  const image = program
    .command("image [paths...]")
    .description("compress images only")
    .action(async (paths: string[], raw: RawOptions, cmd: Command) => {
      program.setOptionValue(
        "exitCode",
        await runCompression("image", paths, raw, cmd),
      );
    });
  addSharedOptions(image);
  addToOption(image, IMAGE_OUTPUT_FORMATS, "format");
  addImageOptions(image);

  const video = program
    .command("video [paths...]")
    .description("compress videos only")
    .action(async (paths: string[], raw: RawOptions, cmd: Command) => {
      program.setOptionValue(
        "exitCode",
        await runCompression("video", paths, raw, cmd),
      );
    });
  addSharedOptions(video);
  addToOption(video, VIDEO_OUTPUT_FORMATS, "container");
  addVideoOptions(video);

  program
    .command("formats")
    .description("list supported input and output formats")
    .option("--json", "emit the capability list as JSON", false)
    .action((raw: { json?: boolean }) => {
      if (raw.json) emitFormats();
      else printFormats();
    });

  // --- deprecated v1 surface, retained for existing installs ---
  program
    .command("optimise:image")
    .description(pc.dim("(deprecated) use `imgvidcompress image` instead"))
    .requiredOption("--loadFolder <path>", "path to the image folder")
    .option("--quality <10-100>", "compression quality", "20")
    .option("--output <ext>", "output extension", ".webp")
    .option("--json", "emit a JSON report on stdout", false)
    .option("--quiet", "suppress non-error output", false)
    .action(async (raw: LegacyRaw) => {
      program.setOptionValue("exitCode", await runLegacy("image", raw));
    });

  program
    .command("optimise:video")
    .description(pc.dim("(deprecated) use `imgvidcompress video` instead"))
    .requiredOption("--loadFolder <path>", "path to the video folder")
    .option("--quality <10-100>", "compression quality", "20")
    .option("--output <ext>", "output extension", ".mp4")
    .option("--json", "emit a JSON report on stdout", false)
    .option("--quiet", "suppress non-error output", false)
    .action(async (raw: LegacyRaw) => {
      program.setOptionValue("exitCode", await runLegacy("video", raw));
    });

  program.addHelpText(
    "after",
    `
${pc.bold("Examples")}
  ${pc.dim("$")} imgvidcompress ./photos
  ${pc.dim("$")} imgvidcompress ./photos --to .avif --quality 60 --max-width 2000
  ${pc.dim("$")} imgvidcompress image ./src --recursive --out ./dist/img
  ${pc.dim("$")} imgvidcompress video ./clips --to .webm --quality 55
  ${pc.dim("$")} imgvidcompress ./assets --dry-run --json | jq .summary

${pc.bold("Exit codes")}
  0 success   1 some files failed   2 bad usage   3 ffmpeg missing   4 no input
`,
  );

  return program;
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "FFMPEG_NOT_FOUND":
      return EXIT.FFMPEG_MISSING;
    case "NO_INPUT_FILES":
    case "INPUT_NOT_FOUND":
      return EXIT.NO_INPUT;
    default:
      return EXIT.USAGE;
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const useJson = argv.includes("--json");
  const program = buildProgram();

  try {
    await program.parseAsync([...argv]);
    return (program.getOptionValue("exitCode") as number | undefined) ?? EXIT.OK;
  } catch (err) {
    // Commander throws for --help and --version, which are successful exits;
    // everything else it throws is the user getting the invocation wrong.
    if (isCommanderExit(err)) {
      return COMMANDER_OK.has(err.code) ? EXIT.OK : EXIT.USAGE;
    }

    if (err instanceof CompressorError) {
      if (useJson) emitError(err.code, err.message, err.detail);
      else new Renderer().error(err.message, err.code);
      return exitCodeFor(err.code);
    }
    if (err instanceof RangeValidationError) {
      if (useJson) emitError("INVALID_OPTION", err.message);
      else new Renderer().error(err.message, "INVALID_OPTION");
      return EXIT.USAGE;
    }
    if (err instanceof Error && err.name === "AbortError") {
      if (!useJson) new Renderer().error("Cancelled.", "ABORTED");
      else emitError("ABORTED", "Cancelled.");
      return EXIT.USAGE;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (useJson) emitError("UNKNOWN", message);
    else new Renderer().error(message, "UNKNOWN");
    return EXIT.USAGE;
  }
}

/** Commander outcomes that mean "the user asked for information and got it". */
const COMMANDER_OK = new Set([
  "commander.helpDisplayed",
  "commander.help",
  "commander.version",
]);

function isCommanderExit(err: unknown): err is { code: string; exitCode: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string" &&
    (err as { code: string }).code.startsWith("commander.")
  );
}
