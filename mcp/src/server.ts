import { stat } from "node:fs/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compress,
  compressImages,
  compressVideos,
  classifyFile,
  discoverFiles,
  sniffFile,
  probeMedia,
  planStreams,
  resolveFfmpeg,
  imageCapabilities,
  ffmpegCapabilities,
  toQuality,
  toPixels,
  isVideoContainer,
  isCodecAllowedIn,
  defaultVideoCodec,
  defaultAudioCodec,
  qualityModelFor,
  mapQuality,
  VIDEO_CONTAINERS,
  VIDEO_OUTPUT_FORMATS,
  type CompressOptions,
  type CompressionReport,
} from "image-and-video-compressor";

/** Library errors carry a stable `code`; anything else is unknown. */
function errorCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String(err.code)
    : "UNKNOWN";
}

/**
 * CLI flag names, as they appear in library error messages, mapped to the
 * parameters this server actually accepts.
 *
 * The messages are good advice written for the CLI — "Use --recursive to
 * preserve the directory structure" — but an agent has no CLI. Following that
 * literally means passing a parameter called `--recursive` and getting a schema
 * error, so the remedy the message offers is unreachable. Longest first, so
 * `--audio-codec` is not clipped by `--codec`.
 */
const CLI_FLAG_TO_PARAMETER: readonly (readonly [string, string])[] = [
  ["--no-skip-larger", "skipLarger: false"],
  ["--audio-codec", "audioCodec"],
  ["--ffmpeg-path", "ffmpegPath"],
  ["--concurrency", "concurrency"],
  ["--max-height", "maxHeight"],
  ["--max-width", "maxWidth"],
  ["--overwrite", "overwrite"],
  ["--recursive", "recursive"],
  ["--dry-run", "dryRun"],
  ["--quality", "quality"],
  ["--output", "to"],
  ["--preset", "preset"],
  ["--codec", "videoCodec"],
  ["--out", "outDir"],
  ["--fps", "fps"],
  ["--to", "to"],
];

/** Rewrite a library message so its advice is actionable through this server. */
function forAgent(message: string): string {
  let out = message.replace(
    /`?imgvidcompress formats`?/g,
    "the list_capabilities tool",
  );
  for (const [flag, parameter] of CLI_FLAG_TO_PARAMETER) {
    // \b stops `--out` from turning `--output` into `outDirput`.
    out = out.replace(new RegExp(`${flag}\\b`, "g"), parameter);
  }
  return out;
}

/**
 * Every tool returns JSON as text content.
 *
 * Deliberately *not* an `outputSchema` with `structuredContent`: the report
 * shape is a discriminated union nested two levels deep, and the SDK validates
 * declared output strictly, so a shape the schema failed to anticipate turns a
 * successful compression into a protocol error. Text JSON is understood by
 * every client and cannot fail that way.
 */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string, code = "TOOL_ERROR") {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, code, message: forAgent(message) }, null, 2),
      },
    ],
  };
}

/**
 * Trim the library report for an agent.
 *
 * The full report repeats absolute paths and per-file timings that cost tokens
 * without changing a decision. What an agent acts on is: did it work, how much
 * was saved, and which files need attention.
 */
function summarise(report: CompressionReport) {
  return {
    ok: report.summary.failed === 0,
    dryRun: report.dryRun,
    summary: report.summary,
    results: report.results.map((result) =>
      result.status === "failed"
        ? {
            status: result.status,
            inputPath: result.inputPath,
            // Kept on every branch: a dry run is useless without it, and an
            // "output-exists" skip that does not say WHICH file collided
            // sends the caller hunting through the output directory.
            outputPath: result.outputPath,
            error: { code: result.error.code, message: forAgent(result.error.message) },
          }
        : result.status === "skipped"
          ? {
              status: result.status,
              inputPath: result.inputPath,
              outputPath: result.outputPath,
              reason: result.reason,
              ...(result.warnings?.length ? { warnings: result.warnings } : {}),
            }
          : {
              status: result.status,
              inputPath: result.inputPath,
              outputPath: result.outputPath,
              inputBytes: result.inputBytes,
              outputBytes: result.outputBytes,
              savedBytes: result.savedBytes,
              savedRatio: Math.round(result.savedRatio * 10_000) / 10_000,
              ...(result.warnings?.length ? { warnings: result.warnings } : {}),
            },
    ),
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "image-and-video-compressor", version: "0.1.0" },
    {
      instructions:
        "Compress images and videos on this machine. Compression never modifies the " +
        "source: output is written to a separate directory. Call list_capabilities " +
        "before choosing an output format — support depends on how sharp and ffmpeg " +
        "were built here, and formats like AVIF, JPEG XL, HEIC and AV1 are commonly " +
        "absent. Use compress_media with dryRun to preview before writing.",
    },
  );

  server.registerTool(
    "compress_media",
    {
      title: "Compress images and videos",
      description:
        "Compress images and/or videos, writing results to a separate output directory. " +
        "Source files are never modified or overwritten. Accepts files or directories. " +
        "If compressing a file would make it larger, the original is kept and the file " +
        "is reported as skipped rather than silently made worse. Set dryRun=true to see " +
        "the plan and projected output paths without writing anything. Video requires " +
        "ffmpeg on PATH; images do not.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            "Files or directories to compress. Directories are scanned for media.",
          ),
        kind: z
          .enum(["auto", "image", "video"])
          .default("auto")
          .describe("Restrict to one media type. 'auto' handles both."),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "1-100, higher looks better. Default 75. Mapped onto each codec's own scale.",
          ),
        to: z
          .string()
          .optional()
          .describe(
            "Output format, e.g. '.webp', '.avif', '.mp4', '.webm'. Default: WebP for images " +
              "(sources already in AVIF/WebP keep their format) and .mp4 for video. " +
              "Verify availability with list_capabilities first.",
          ),
        outDir: z
          .string()
          .optional()
          .describe(
            "Output directory. Default is a 'compressed' folder beside the source.",
          ),
        recursive: z.boolean().default(false).describe("Descend into subdirectories."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace existing output files instead of skipping them."),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Report the plan without writing any file. Safe to call freely."),
        maxWidth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Shrink anything wider. Never enlarges."),
        maxHeight: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Shrink anything taller. Never enlarges."),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Files processed at once."),
        skipLarger: z
          .boolean()
          .default(true)
          .describe("Keep the original when compression would make it bigger."),
        keepMetadata: z
          .boolean()
          .default(false)
          .describe(
            "Images: preserve EXIF and ICC instead of stripping it. Stripping saves real bytes.",
          ),
        autoRotate: z
          .boolean()
          .default(true)
          .describe(
            "Images: apply EXIF orientation, so portrait shots are not left sideways.",
          ),
        videoCodec: z
          .string()
          .optional()
          .describe("Video encoder, e.g. 'libx264', 'libvpx-vp9', 'libsvtav1'."),
        audioCodec: z
          .string()
          .optional()
          .describe("Audio encoder: 'aac', 'libopus', or 'copy'."),
        fps: z
          .number()
          .int()
          .min(1)
          .max(240)
          .optional()
          .describe("Cap frame rate. Default keeps the source rate."),
        preset: z
          .string()
          .optional()
          .describe(
            "Encoder speed/efficiency tradeoff. Codec-specific: 'slow'/'medium'/'fast' for " +
              "x264 and x265, a numeric cpu-used for VP9 and AV1. Sane default per codec.",
          ),
        ffmpegPath: z
          .string()
          .optional()
          .describe("Explicit path to the ffmpeg binary."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const options: CompressOptions = {
          ...(args.quality !== undefined ? { quality: toQuality(args.quality) } : {}),
          ...(args.to !== undefined ? { to: args.to } : {}),
          ...(args.outDir !== undefined ? { outDir: args.outDir } : {}),
          recursive: args.recursive,
          overwrite: args.overwrite,
          dryRun: args.dryRun,
          skipLarger: args.skipLarger,
          keepMetadata: args.keepMetadata,
          autoRotate: args.autoRotate,
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
          ...(args.preset !== undefined ? { preset: args.preset } : {}),
          ...(args.videoCodec !== undefined
            ? { videoCodec: args.videoCodec as CompressOptions["videoCodec"] }
            : {}),
          ...(args.audioCodec !== undefined
            ? { audioCodec: args.audioCodec as CompressOptions["audioCodec"] }
            : {}),
          ...(args.fps !== undefined ? { fps: args.fps } : {}),
          ...(args.ffmpegPath !== undefined ? { ffmpegPath: args.ffmpegPath } : {}),
          ...(args.maxWidth !== undefined || args.maxHeight !== undefined
            ? {
                resize: {
                  ...(args.maxWidth !== undefined
                    ? { maxWidth: toPixels(args.maxWidth) }
                    : {}),
                  ...(args.maxHeight !== undefined
                    ? { maxHeight: toPixels(args.maxHeight) }
                    : {}),
                  withoutEnlargement: true,
                },
              }
            : {}),
        };

        const report =
          args.kind === "image"
            ? await compressImages(args.paths, options)
            : args.kind === "video"
              ? await compressVideos(args.paths, options)
              : await compress(args.paths, options);

        return json(summarise(report));
      } catch (err) {
        // Setup errors (no inputs, bad option, ffmpeg missing) reject; per-file
        // problems already arrive as failed results inside the report.
        return failure(
          err instanceof Error ? err.message : String(err),
          errorCode(err),
        );
      }
    },
  );

  server.registerTool(
    "probe_media",
    {
      title: "Inspect a media file",
      description:
        "Identify a media file without modifying it: whether it is an image or a video, " +
        "its size on disk, and for video its duration and stream layout (video, audio, " +
        "subtitle tracks) via ffprobe. Identification is by content, not by filename, so " +
        "a .jpg that is really an MP4 is reported as the video it is — with a note saying " +
        "the extension disagrees.",
      inputSchema: {
        path: z.string().describe("Path to a single media file."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      try {
        const info = await stat(path);
        if (!info.isFile()) return failure(`Not a file: ${path}`, "INPUT_NOT_FOUND");

        const byExtension = await classifyFile(path);
        const sniffed = await sniffFile(path);

        /**
         * Content wins over the name.
         *
         * `classifyFile` answers by extension first, which is the right default
         * for bulk discovery where opening every file is too costly. Here the
         * caller has named one file and wants the truth about it. Trusting the
         * extension meant a JPEG called `.mp4` was reported as a video, and
         * ffprobe was then run on it — the image2 demuxer duly reported a
         * one-frame "mjpeg video stream", so the answer looked plausible and
         * was entirely fabricated.
         */
        const kind = sniffed?.kind ?? byExtension;
        const misnamed =
          sniffed !== null && byExtension !== null && sniffed.kind !== byExtension;

        const base = {
          path,
          kind,
          bytes: info.size,
          ...(sniffed ? { detected: sniffed } : {}),
          ...(misnamed
            ? {
                extensionSuggests: byExtension,
                note:
                  `The extension says ${byExtension} but the contents are ${sniffed.format}. ` +
                  "Reporting what the bytes say. Encoders read the real format too, so this " +
                  "file still compresses correctly.",
              }
            : {}),
        };

        if (kind !== "video") return json(base);

        try {
          const tools = await resolveFfmpeg();
          if (!tools.ffprobe)
            return json({
              ...base,
              note: "ffprobe unavailable; stream detail omitted.",
            });

          const probe = await probeMedia(tools.ffprobe, path);
          return json({
            ...base,
            durationSeconds: probe.durationSeconds,
            video: probe.video,
            audio: probe.audio,
            subtitles: probe.subtitles,
            hasAttachments: probe.hasAttachments,
          });
        } catch {
          return json({ ...base, note: "ffmpeg not found; stream detail omitted." });
        }
      } catch (err) {
        return failure(
          err instanceof Error ? err.message : String(err),
          "INPUT_NOT_FOUND",
        );
      }
    },
  );

  server.registerTool(
    "discover_media",
    {
      title: "List media files under a path",
      description:
        "List the image and video files under the given paths without compressing or " +
        "opening them. Cheap: classification is by extension against what this sharp and " +
        "ffmpeg build handles, so it scans large trees quickly. Use it to answer 'what " +
        "media is in this project and how big is it' before deciding what to compress.",
      inputSchema: {
        paths: z.array(z.string()).min(1).describe("Files or directories to scan."),
        kind: z
          .enum(["auto", "image", "video"])
          .default("auto")
          .describe("Restrict the listing to one media type."),
        recursive: z.boolean().default(false).describe("Descend into subdirectories."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const files = await discoverFiles(args.paths, {
          recursive: args.recursive,
          ...(args.kind !== "auto" ? { kind: args.kind } : {}),
        });

        const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
        return json({
          totalFiles: files.length,
          totalBytes,
          images: files.filter((file) => file.kind === "image").length,
          videos: files.filter((file) => file.kind === "video").length,
          files: files.map((file) => ({
            path: file.path,
            kind: file.kind,
            bytes: file.bytes,
          })),
        });
      } catch (err) {
        return failure(
          err instanceof Error ? err.message : String(err),
          errorCode(err),
        );
      }
    },
  );

  server.registerTool(
    "plan_video_conversion",
    {
      title: "Preview what converting a video would do",
      description:
        "For a video and a target container, report which streams survive, which are " +
        "dropped and why, the codec that would be used, and what a given quality maps to " +
        "on that codec's own scale. Answers 'will I lose my subtitles or commentary track " +
        "if I convert this to mp4' before any file is written. Read-only.",
      inputSchema: {
        path: z.string().describe("Path to the source video."),
        to: z
          .string()
          .describe(
            "Target container, e.g. '.mp4', '.webm', '.mkv'. Must be a curated container.",
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(75)
          .describe("Quality to translate onto the target codec's scale."),
        videoCodec: z
          .string()
          .optional()
          .describe("Override the codec. Must be legal for the container."),
        ffmpegPath: z
          .string()
          .optional()
          .describe("Explicit path to the ffmpeg binary."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const container = args.to.startsWith(".")
        ? args.to.toLowerCase()
        : `.${args.to.toLowerCase()}`;

      if (!isVideoContainer(container)) {
        return failure(
          `${container} is not a curated container. Curated: ${VIDEO_OUTPUT_FORMATS.join(", ")}. ` +
            "Other containers your ffmpeg can mux still work in compress_media, but cannot be planned here.",
          "UNSUPPORTED_FORMAT",
        );
      }

      const codec = args.videoCodec ?? defaultVideoCodec(container);
      if (!isCodecAllowedIn(container, codec)) {
        return failure(
          `${VIDEO_CONTAINERS[container].label} cannot carry ${codec}. ` +
            `Allowed: ${VIDEO_CONTAINERS[container].video.join(", ")}.`,
          "UNSUPPORTED_FORMAT",
        );
      }

      try {
        const tools = await resolveFfmpeg(args.ffmpegPath);
        if (!tools.ffprobe)
          return failure(
            "ffprobe unavailable; cannot inspect streams.",
            "FFMPEG_NOT_FOUND",
          );

        /**
         * The curated table says which codecs a container *may* carry; it does
         * not know what this ffmpeg was built with. Without this check the plan
         * cheerfully promised libtheora for .ogv on a build with no Theora
         * encoder, and the compression that followed died with "Unknown
         * encoder". A plan that predicts success for something that cannot run
         * is worse than no plan at all.
         */
        const caps = await ffmpegCapabilities(tools.ffmpeg);
        if (!caps.videoEncoders.has(codec)) {
          const usable = VIDEO_CONTAINERS[container].video.filter((candidate) =>
            caps.videoEncoders.has(candidate),
          );
          return failure(
            `This ffmpeg has no ${codec} encoder, so ${container} cannot be produced with it. ` +
              (usable.length > 0
                ? `Available for ${container} on this machine: ${usable.join(", ")}.`
                : `No encoder for ${container} is available in this build at all.`),
            "UNSUPPORTED_FORMAT",
          );
        }

        const probe = await probeMedia(tools.ffprobe, args.path);
        const { plan, dropped } = planStreams(container, probe);

        // Quality is mapped onto the codec's own scale and direction — CRF
        // counts down, Theora counts up — so report the real encoder value.
        const model = qualityModelFor(codec);
        const encoderValue = model ? mapQuality(toQuality(args.quality), model) : null;

        // Same reasoning as the video encoder: only promise an audio codec the
        // binary can actually produce.
        // A container's default audio codec is always a real encoder, never
        // "copy", so availability is a straight lookup.
        const audioCodec = defaultAudioCodec(container);
        const audioAvailable = caps.audioEncoders.has(audioCodec);

        return json({
          container,
          label: VIDEO_CONTAINERS[container].label,
          videoCodec: codec,
          audioCodec,
          ...(audioAvailable
            ? {}
            : {
                audioNote:
                  `This ffmpeg has no ${audioCodec} encoder. Audio would fail unless the ` +
                  "source track can be copied through, so pass audioCodec explicitly.",
              }),
          quality: args.quality,
          encoderValue,
          durationSeconds: probe.durationSeconds,
          keeps: {
            video: plan.video.length,
            audio: plan.audio.length,
            subtitles: plan.subtitles.length,
            attachments: plan.attachments,
          },
          // Named explicitly: losing a commentary track silently is worse than
          // refusing outright, because nobody notices until they need it.
          dropped,
        });
      } catch (err) {
        return failure(
          err instanceof Error ? err.message : String(err),
          errorCode(err),
        );
      }
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List supported formats on this machine",
      description:
        "Report what this machine can actually encode and decode. Support is build-dependent, " +
        "not fixed by the package: AVIF, JPEG XL and HEIC are frequently missing from sharp, " +
        "and a minimal ffmpeg carries a fraction of the containers and codecs a full one does. " +
        "Call this before choosing an output format instead of assuming one is available.",
      inputSchema: {
        ffmpegPath: z
          .string()
          .optional()
          .describe("Explicit path to the ffmpeg binary."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ffmpegPath }) => {
      const images = await imageCapabilities();

      const imageReport = {
        // Established by actually encoding a pixel with each candidate, so this
        // is what the build can do rather than what it claims.
        write: images.writable.map((format) => ({
          extensions: format.extensions,
          label: format.label,
          supportsQuality: format.supportsQuality,
          supportsAnimation: format.supportsAnimation,
        })),
        read: [...images.readableExtensions].sort(),
      };

      try {
        const tools = await resolveFfmpeg(ffmpegPath);
        const caps = await ffmpegCapabilities(tools.ffmpeg);

        const containers = Object.entries(VIDEO_CONTAINERS)
          .filter(([, spec]) => caps.muxers.has(spec.muxer))
          .map(([extension, spec]) => ({
            extension,
            label: spec.label,
            videoCodecs: spec.video.filter((codec) => caps.videoEncoders.has(codec)),
            audioCodecs: spec.audio.filter(
              (codec) => codec === "copy" || caps.audioEncoders.has(codec),
            ),
          }));

        return json({
          image: imageReport,
          video: {
            available: true,
            ffmpeg: tools.ffmpeg,
            ffmpegVersion: tools.version,
            containers,
            muxerCount: caps.muxers.size,
            videoEncoderCount: caps.videoEncoders.size,
            audioEncoderCount: caps.audioEncoders.size,
          },
        });
      } catch {
        return json({
          image: imageReport,
          video: {
            available: false,
            note: "ffmpeg not found. Images still work. Install ffmpeg or pass ffmpegPath to enable video.",
          },
        });
      }
    },
  );

  return server;
}
