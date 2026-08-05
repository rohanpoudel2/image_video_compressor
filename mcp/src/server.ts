import { stat } from "node:fs/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compress,
  compressImages,
  compressVideos,
  classifyFile,
  sniffFile,
  probeMedia,
  resolveFfmpeg,
  imageCapabilities,
  ffmpegCapabilities,
  toQuality,
  toPixels,
  VIDEO_CONTAINERS,
  type CompressOptions,
  type CompressionReport,
} from "image-and-video-compressor";

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
        text: JSON.stringify({ ok: false, code, message }, null, 2),
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
            error: { code: result.error.code, message: result.error.message },
          }
        : result.status === "skipped"
          ? {
              status: result.status,
              inputPath: result.inputPath,
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
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
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
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String(err.code)
            : "UNKNOWN";
        return failure(err instanceof Error ? err.message : String(err), code);
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
        "subtitle tracks) via ffprobe. Detection uses content bytes when the extension is " +
        "missing or wrong, so it correctly reports a .jpg that is really an MP4.",
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

        const kind = await classifyFile(path);
        const sniffed = await sniffFile(path);

        const base = {
          path,
          kind,
          bytes: info.size,
          ...(sniffed ? { detected: sniffed } : {}),
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
