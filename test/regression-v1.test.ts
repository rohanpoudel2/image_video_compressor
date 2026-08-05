import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import { tempDir, makeImage, makeCorruptImage, runCli } from "./helpers.js";
import { buildVideoArgs } from "../src/codecs/video.js";
import {
  qualityToCrf,
  VIDEO_CODECS,
  VIDEO_CONTAINERS,
  type VideoCodec,
} from "../src/types/video-formats.js";
import { toQuality } from "../src/types/brand.js";
import { compressImages } from "../src/core/compress.js";

/**
 * One test per defect found in the v1 audit.
 *
 * Each case is written to fail against v1's behaviour, so this file doubles as
 * an executable record of what was wrong and why the fix matters.
 */
describe("v1 regressions", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  describe("CLI crashes", () => {
    it("does not crash when stdout is a pipe", async () => {
      // v1: TypeError: process.stdout.clearLine is not a function
      const src = join(dir, "piped");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", join(dir, "piped-out")]);

      expect(result.stderr).not.toContain("clearLine");
      expect(result.stderr).not.toContain("TypeError");
      expect(result.exitCode).toBe(0);
    });

    it("does not crash when invoked with no arguments", async () => {
      // v1: TypeError: Cannot read properties of undefined (reading 'replace')
      const result = await runCli([]);

      expect(result.stderr).not.toContain("TypeError");
      expect(result.stderr).toContain("Usage:");
    });

    it("does not create a directory when the input path is missing", async () => {
      // v1 called mkdirSync on the missing path, then rejected without
      // returning, so fs.readdir ran on an already-rejected promise.
      const ghost = join(dir, "definitely-absent");
      const result = await runCli([ghost]);

      expect(result.exitCode).toBe(4);
      await expect(access(ghost)).rejects.toThrow();
    });

    it("rejects .svg output instead of throwing at encode time", async () => {
      // v1 advertised .svg in formats.json and mapped it to sharp.svg(),
      // which does not exist: "image[formatMethod] is not a function".
      const src = join(dir, "svg");
      await makeImage(join(src, "a.png"));

      const result = await runCli(["image", src, "--to", ".svg"]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/invalid|Allowed choices/i);
      expect(result.stderr).not.toContain("is not a function");
    });
  });

  describe("video encoding correctness", () => {
    it("keeps CRF inside every codec's valid range across the whole quality scale", () => {
      // v1: crf = 100 - quality, giving CRF 90 at --quality=10 (x264 max is 51)
      // and CRF 0 at --quality=100 (lossless, reliably larger than the source).
      for (const codec of Object.keys(VIDEO_CODECS) as VideoCodec[]) {
        const { crfMin, crfMax } = VIDEO_CODECS[codec];

        for (let q = 1; q <= 100; q++) {
          const crf = qualityToCrf(toQuality(q), codec);
          expect(crf, `${codec} @ quality ${q}`).toBeGreaterThanOrEqual(crfMin);
          expect(crf, `${codec} @ quality ${q}`).toBeLessThanOrEqual(crfMax);
        }
      }
    });

    it("maps higher quality to lower CRF, never inverted", () => {
      const low = qualityToCrf(toQuality(10), "libx264");
      const high = qualityToCrf(toQuality(90), "libx264");
      expect(high).toBeLessThan(low);
    });

    it("uses each codec's own scale rather than one shared formula", () => {
      // VP9 and AV1 run to 63; x264/x265 stop at 51. A single linear mapping
      // cannot be correct for both.
      expect(qualityToCrf(toQuality(1), "libvpx-vp9")).toBe(55);
      expect(qualityToCrf(toQuality(1), "libx264")).toBe(45);
      expect(qualityToCrf(toQuality(1), "libvpx-vp9")).not.toBe(
        qualityToCrf(toQuality(1), "libx264"),
      );
    });

    it("never asks for lossless at --quality 100", () => {
      // CRF 0 is mathematically lossless and reliably larger than the source,
      // which is the opposite of what a compressor should do at any setting.
      for (const codec of Object.keys(VIDEO_CODECS) as VideoCodec[]) {
        const crf = qualityToCrf(toQuality(100), codec);
        expect(crf, `${codec} at max quality`).toBeGreaterThan(0);
      }
    });

    it("never selects H.264 for a WebM container", () => {
      // v1 hardcoded libx264 for every container, producing a file ffmpeg
      // refuses to mux: WebM carries only VP8/VP9/AV1.
      expect(VIDEO_CONTAINERS[".webm"].video).not.toContain("libx264");

      const args = buildVideoArgs({
        inputPath: "in.mov",
        outputPath: "out.webm",
        container: ".webm",
        videoCodec: "libvpx-vp9",
        audioCodec: "libopus",
        crf: qualityToCrf(toQuality(60), "libvpx-vp9"),
      });

      expect(args).not.toContain("libx264");
      expect(args).toContain("libvpx-vp9");
    });

    it("does not force a frame rate when none was requested", () => {
      // v1 hardcoded .fps(30), juddering 24fps film and halving 60fps footage.
      const args = buildVideoArgs({
        inputPath: "in.mp4",
        outputPath: "out.mp4",
        container: ".mp4",
        videoCodec: "libx264",
        audioCodec: "aac",
        crf: qualityToCrf(toQuality(75), "libx264"),
      });

      expect(args).not.toContain("-r");
    });

    it("passes -b:v 0 for VP9 so CRF means constant quality", () => {
      // Without it libvpx treats -crf as a ceiling over a default bitrate.
      const args = buildVideoArgs({
        inputPath: "in.mp4",
        outputPath: "out.webm",
        container: ".webm",
        videoCodec: "libvpx-vp9",
        audioCodec: "libopus",
        crf: qualityToCrf(toQuality(50), "libvpx-vp9"),
      });

      const index = args.indexOf("-b:v");
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe("0");
    });

    it("sets an audio codec the container can actually carry", () => {
      const args = buildVideoArgs({
        inputPath: "in.mp4",
        outputPath: "out.webm",
        container: ".webm",
        videoCodec: "libvpx-vp9",
        audioCodec: "libopus",
        crf: qualityToCrf(toQuality(50), "libvpx-vp9"),
      });

      const index = args.indexOf("-c:a");
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe("libopus");
    });
  });

  describe("batch resilience", () => {
    it("completes the batch when one file is corrupt", async () => {
      // v1 used Promise.all, so the first rejection abandoned all remaining
      // work and reported nothing about what had already succeeded.
      const src = join(dir, "mixed");
      await makeImage(join(src, "good-1.png"));
      await makeImage(join(src, "good-2.png"));
      await makeCorruptImage(join(src, "broken.png"));

      const report = await compressImages([src], {
        outDir: join(dir, "mixed-out"),
      });

      expect(report.summary.compressed).toBe(2);
      expect(report.summary.failed).toBe(1);
      expect(report.results).toHaveLength(3);

      const failure = report.results.find((r) => r.status === "failed");
      expect(failure?.status === "failed" && failure.error.code).toBe("ENCODE_FAILED");
    });

    it("reports a partial-failure exit code rather than success", async () => {
      const src = join(dir, "exit");
      await makeImage(join(src, "ok.png"));
      await makeCorruptImage(join(src, "bad.png"));

      const result = await runCli(["image", src, "--out", join(dir, "exit-out")]);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("output reporting", () => {
    it("tells the user where the files went", async () => {
      // v1 printed the destination and then immediately overwrote that line
      // with the completion message, so it was never actually readable.
      const src = join(dir, "report");
      const out = join(dir, "report-out");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", out]);
      const written = await readdir(out);

      expect(written).toContain("a.webp");
      expect(result.stderr).toContain("a.webp");
    });

    it("reports the bytes saved, which v1 never did", async () => {
      const src = join(dir, "savings");
      await makeImage(join(src, "a.png"), { width: 400, height: 400 });

      const report = await compressImages([src], { outDir: join(dir, "savings-out") });

      expect(report.summary.inputBytes).toBeGreaterThan(0);
      expect(report.summary.outputBytes).toBeGreaterThan(0);
      expect(report.summary).toHaveProperty("savedBytes");
      expect(report.summary).toHaveProperty("savedRatio");
    });
  });
});
