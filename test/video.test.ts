import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { tempDir, makeVideo, hasFfmpeg, runCli } from "./helpers.js";
import { compressVideos } from "../src/core/compress.js";
import { ffmpegCapabilities } from "../src/codecs/ffmpeg-capabilities.js";
import { buildVideoArgs, buildScaleFilter } from "../src/codecs/video.js";
import { qualityToCrf } from "../src/types/video-formats.js";
import { toQuality, toPixels } from "../src/types/brand.js";
import { resolveFfmpeg, resetFfmpegCache } from "../src/codecs/ffmpeg.js";
import { CompressorError } from "../src/core/errors.js";

/** Read arbitrary stream fields back out of the encoded file. */
function probeStream(
  file: string,
  entries: string,
  stream: "v" | "a" = "v",
): Promise<string> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    `${stream}:0`,
    "-show_entries",
    `stream=${entries}`,
    "-of",
    "csv=p=0",
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

/** Read a stream's codec name back out of the encoded file. */
function probeCodec(file: string, stream: "v" | "a"): Promise<string> {
  return probeStream(file, "codec_name", stream);
}

async function temporaryFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(
    (name) => name.startsWith(".") && name.includes(".tmp."),
  );
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

  it("clamps both dimensions to the source, so a small input is never enlarged", () => {
    // `force_original_aspect_ratio=decrease` fits the frame inside the box but
    // scales *up* to reach it, so the box has to be bounded by the source.
    // Without the clamp a 320x240 clip given a 4000x4000 box encoded at
    // 4000x3000 — from options documented as "never enlarge".
    const filter = buildScaleFilter({
      maxWidth: toPixels(4000),
      maxHeight: toPixels(4000),
    });

    expect(filter).toContain("min(iw\\,4000)");
    expect(filter).toContain("min(ih\\,4000)");
  });

  it("allows upscaling only when withoutEnlargement is explicitly false", () => {
    const filter = buildScaleFilter({
      maxWidth: toPixels(4000),
      maxHeight: toPixels(4000),
      withoutEnlargement: false,
    });

    expect(filter).not.toContain("min(");
    expect(filter).toContain("w=4000");
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
    const out = join(dir, "mp4-out");
    await makeVideo(join(src, "clip.mp4"));

    const report = await compressVideos([src], {
      outDir: out,
      quality: toQuality(50),
      // A 1s clip is mostly audio, so the re-encode can be larger than the
      // source and skip-larger would decline to write it. This test is about
      // which codec lands in the file, not about the ratio.
      skipLarger: false,
    });

    expect(report.summary.failed).toBe(0);
    expect(await probeCodec(join(out, "clip.mp4"), "v")).toBe("h264");
    expect(await temporaryFiles(out)).toEqual([]);
  }, 120_000);

  it("preserves an existing output when ffmpeg fails", async () => {
    const src = join(dir, "atomic-failure");
    const out = join(dir, "atomic-failure-out");
    const input = join(src, "clip.mp4");
    const output = join(out, "clip.mp4");
    await mkdir(src, { recursive: true });
    await writeFile(input, "this is not video data");
    await makeVideo(output);
    const existing = await readFile(output);

    const report = await compressVideos([src], {
      outDir: out,
      overwrite: true,
      skipLarger: false,
    });

    expect(report.results[0]?.status).toBe("failed");
    expect(await readFile(output)).toEqual(existing);
    expect(await temporaryFiles(out)).toEqual([]);
  }, 120_000);

  it("preserves an existing output when the new encode is larger", async () => {
    const src = join(dir, "atomic-larger");
    const out = join(dir, "atomic-larger-out");
    const input = join(src, "clip.mp4");
    const output = join(out, "clip.mp4");
    await makeVideo(input);
    await makeVideo(output);
    const existing = await readFile(output);

    const report = await compressVideos([src], {
      outDir: out,
      overwrite: true,
      quality: toQuality(100),
      preset: "ultrafast",
    });

    const result = report.results[0];
    expect(result?.status).toBe("skipped");
    expect(result?.status === "skipped" && result.reason).toBe(
      "output-larger-than-input",
    );
    expect(await readFile(output)).toEqual(existing);
    expect(await temporaryFiles(out)).toEqual([]);
  }, 120_000);

  it("removes the temporary output when a run is aborted", async () => {
    const src = join(dir, "atomic-abort");
    const out = join(dir, "atomic-abort-out");
    await makeVideo(join(src, "first.mp4"));
    await makeVideo(join(src, "second.mp4"));
    const controller = new AbortController();

    const run = compressVideos([src], {
      outDir: out,
      signal: controller.signal,
      concurrency: 2,
      skipLarger: false,
      onProgress: (event) => {
        if (event.type === "job-start") controller.abort();
      },
    });

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(await temporaryFiles(out)).toEqual([]);
  }, 120_000);

  it("accepts a runtime video encoder outside the curated registry", async () => {
    const caps = await ffmpegCapabilities("ffmpeg");
    if (!caps.videoEncoders.has("ffv1") || !caps.muxers.has("nut")) return;

    const src = join(dir, "open-codec-cli");
    const out = join(dir, "open-codec-cli-out");
    await makeVideo(join(src, "clip.mp4"));

    const result = await runCli([
      "video",
      src,
      "--to",
      ".nut",
      "--codec",
      "ffv1",
      "--out",
      out,
      "--no-skip-larger",
    ]);

    expect(result.exitCode).toBe(0);
    expect(await probeCodec(join(out, "clip.nut"), "v")).toBe("ffv1");
  }, 120_000);

  it("rejects a missing explicit encoder once before the worker pool starts", async () => {
    const caps = await ffmpegCapabilities("ffmpeg");
    const muxer = [...caps.muxers.keys()].find(
      (name) => !["mp4", "mkv", "mov", "webm", "avi", "ogv"].includes(name),
    );
    expect(muxer).toBeDefined();

    const src = join(dir, "missing-codec-preflight");
    const first = join(src, "one.mp4");
    await makeVideo(first);
    await copyFile(first, join(src, "two.mp4"));

    let starts = 0;
    const error = await compressVideos([src], {
      outDir: join(dir, "missing-codec-preflight-out"),
      to: `.${muxer!}`,
      videoCodec: "definitely-not-an-encoder",
      onProgress: (event) => {
        if (event.type === "job-start") starts++;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompressorError);
    expect((error as CompressorError).code).toBe("INVALID_OPTION");
    expect((error as CompressorError).message).toContain(
      'no video encoder called "definitely-not-an-encoder"',
    );
    expect((error as CompressorError).message).toContain("Available video encoders");
    expect(starts).toBe(0);
  }, 120_000);

  it("runs the encoder capability preflight for a dry run", async () => {
    const caps = await ffmpegCapabilities("ffmpeg");
    const muxer = [...caps.muxers.keys()].find(
      (name) => !["mp4", "mkv", "mov", "webm", "avi", "ogv"].includes(name),
    );
    expect(muxer).toBeDefined();

    const src = join(dir, "dry-missing-codec-preflight");
    await makeVideo(join(src, "clip.mp4"));

    let starts = 0;
    const error = await compressVideos([src], {
      outDir: join(dir, "dry-missing-codec-preflight-out"),
      to: `.${muxer!}`,
      videoCodec: "definitely-not-an-encoder",
      dryRun: true,
      onProgress: (event) => {
        if (event.type === "job-start") starts++;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompressorError);
    expect((error as CompressorError).code).toBe("INVALID_OPTION");
    expect(starts).toBe(0);
  }, 120_000);

  it("does not enlarge a small source given a large resize box", async () => {
    // The fixture is 320x240; the box is far larger in both dimensions. This
    // encoded at 4000x3000 before the clamp, so assert against the real file
    // rather than the filter string.
    const src = join(dir, "no-enlarge");
    await makeVideo(join(src, "clip.mp4"));

    const report = await compressVideos([src], {
      outDir: join(dir, "no-enlarge-out"),
      resize: {
        maxWidth: toPixels(4000),
        maxHeight: toPixels(4000),
        withoutEnlargement: true,
      },
      skipLarger: false,
    });

    expect(report.summary.failed).toBe(0);
    const size = await probeStream(
      join(dir, "no-enlarge-out", "clip.mp4"),
      "width,height",
    );
    expect(size).toBe("320,240");
  }, 120_000);

  it("produces a playable WebM, which v1 could not", async () => {
    // v1 muxed H.264 into WebM; ffmpeg refuses, so the run always failed.
    const src = join(dir, "webm");
    await makeVideo(join(src, "clip.mp4"));

    const report = await compressVideos([src], {
      outDir: join(dir, "webm-out"),
      to: ".webm",
      quality: toQuality(40),
      skipLarger: false,
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
      skipLarger: false,
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
      skipLarger: false,
      onProgress: (event) => {
        if (event.type === "job-progress") ratios.push(event.ratio);
      },
    });

    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
