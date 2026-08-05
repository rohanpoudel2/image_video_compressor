import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { tempDir, makeVideo, hasFfmpeg } from "./helpers.js";
import { compressVideos } from "../src/core/compress.js";
import { buildVideoArgs, buildScaleFilter } from "../src/codecs/video.js";
import { qualityToCrf } from "../src/types/video-formats.js";
import { toQuality, toPixels } from "../src/types/brand.js";
import { resolveFfmpeg, resetFfmpegCache } from "../src/codecs/ffmpeg.js";
import { CompressorError } from "../src/core/errors.js";

/** Read a stream's codec name back out of the encoded file. */
function probeCodec(file: string, stream: "v" | "a"): Promise<string> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    `${stream}:0`,
    "-show_entries",
    "stream=codec_name",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

describe("video argument construction", () => {
  it("escapes the comma inside a scale expression", () => {
    // An unescaped comma is read by ffmpeg as an option separator.
    const filter = buildScaleFilter({ maxWidth: toPixels(1280) });
    expect(filter).toBe("scale=w=min(iw\\,1280):h=-2");
  });

  it("rounds to even dimensions, which yuv420p requires", () => {
    expect(
      buildScaleFilter({ maxWidth: toPixels(640), maxHeight: toPixels(480) }),
    ).toContain("force_divisible_by=2");
  });

  it("returns null when no resize was requested", () => {
    expect(buildScaleFilter(undefined)).toBeNull();
    expect(buildScaleFilter({})).toBeNull();
  });

  it("adds faststart for MP4 so playback can begin before download finishes", () => {
    const args = buildVideoArgs({
      inputPath: "in.mov",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      crf: qualityToCrf(toQuality(75), "libx264"),
    });
    expect(args).toContain("-movflags");
    expect(args).toContain("+faststart");
  });

  it("tags HEVC as hvc1 so Apple players accept it", () => {
    const args = buildVideoArgs({
      inputPath: "in.mp4",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx265",
      audioCodec: "aac",
      crf: qualityToCrf(toQuality(75), "libx265"),
    });
    expect(args).toContain("hvc1");
  });

  it("never lets ffmpeg wait on stdin", () => {
    // Without -nostdin ffmpeg consumes the parent's stdin inside a pipeline;
    // without -y it blocks forever on an overwrite prompt with no TTY.
    const args = buildVideoArgs({
      inputPath: "in.mp4",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      crf: qualityToCrf(toQuality(75), "libx264"),
    });
    expect(args).toContain("-nostdin");
    expect(args).toContain("-y");
  });
});

describe("ffmpeg discovery", () => {
  it("gives an actionable message when the binary is absent", async () => {
    resetFfmpegCache();
    const error = await resolveFfmpeg("/nonexistent/path/to/ffmpeg").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CompressorError);
    expect((error as CompressorError).code).toBe("FFMPEG_NOT_FOUND");
    // The message must tell the user what to actually do about it.
    expect((error as CompressorError).message).toMatch(/install/i);
    expect((error as CompressorError).message).toContain("--ffmpeg-path");
    resetFfmpegCache();
  });
});

describe.skipIf(!(await hasFfmpeg()))("video encoding (requires ffmpeg)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("encodes an MP4 with H.264", async () => {
    const src = join(dir, "mp4");
    await makeVideo(join(src, "clip.mp4"));

    const report = await compressVideos([src], {
      outDir: join(dir, "mp4-out"),
      quality: toQuality(50),
    });

    expect(report.summary.failed).toBe(0);
    expect(await probeCodec(join(dir, "mp4-out", "clip.mp4"), "v")).toBe("h264");
  }, 120_000);

  it("produces a playable WebM, which v1 could not", async () => {
    // v1 muxed H.264 into WebM; ffmpeg refuses, so the run always failed.
    const src = join(dir, "webm");
    await makeVideo(join(src, "clip.mp4"));

    const report = await compressVideos([src], {
      outDir: join(dir, "webm-out"),
      to: ".webm",
      quality: toQuality(40),
    });

    expect(report.summary.failed).toBe(0);
    expect(report.summary.compressed).toBe(1);

    const out = join(dir, "webm-out", "clip.webm");
    expect(await probeCodec(out, "v")).toBe("vp9");
    expect(await probeCodec(out, "a")).toBe("opus");
  }, 180_000);

  it("preserves the source frame rate instead of forcing 30fps", async () => {
    const src = join(dir, "fps");
    await makeVideo(join(src, "clip.mp4"));

    await compressVideos([src], {
      outDir: join(dir, "fps-out"),
      quality: toQuality(50),
    });

    const rate = await new Promise<string>((resolve) => {
      const child = spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=r_frame_rate",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          join(dir, "fps-out", "clip.mp4"),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("close", () => resolve(out.trim()));
    });

    expect(rate).toBe("30/1"); // matches the 30fps fixture, not a forced value
  }, 120_000);

  it("rejects a codec the chosen container cannot carry", async () => {
    const src = join(dir, "badcodec");
    await makeVideo(join(src, "clip.mp4"));

    await expect(
      compressVideos([src], {
        outDir: join(dir, "badcodec-out"),
        to: ".webm",
        videoCodec: "libx264",
      }),
    ).rejects.toThrow(/cannot carry/i);
  }, 60_000);

  it("reports progress while encoding", async () => {
    const src = join(dir, "progress");
    await makeVideo(join(src, "clip.mp4"), 2);

    const ratios: number[] = [];
    await compressVideos([src], {
      outDir: join(dir, "progress-out"),
      quality: toQuality(50),
      onProgress: (event) => {
        if (event.type === "job-progress") ratios.push(event.ratio);
      },
    });

    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
