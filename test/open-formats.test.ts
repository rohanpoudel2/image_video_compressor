import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { access } from "node:fs/promises";

import { tempDir, makeImage, makeVideo, hasFfmpeg, runCli } from "./helpers.js";
import { compressImages, compressVideos } from "../src/core/compress.js";
import { imageCapabilities } from "../src/codecs/sharp-capabilities.js";
import { buildOpenVideoArgs } from "../src/codecs/video.js";
import { toQuality } from "../src/types/brand.js";

/**
 * The open tier: formats outside the curated matrix.
 *
 * The point of these is that support is bounded by what sharp and ffmpeg can
 * actually do, not by a list someone typed. A format missing from the curated
 * set must still work.
 */
describe("image formats beyond the curated set", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("writes every format this build reports as writable", async () => {
    const caps = await imageCapabilities();
    const src = join(dir, "all");
    await makeImage(join(src, "source.png"), { width: 64, height: 64 });

    for (const capability of caps.writable) {
      const ext = capability.primaryExtension;
      const report = await compressImages([src], {
        outDir: join(dir, `out${ext.replace(".", "-")}`),
        to: ext,
        quality: toQuality(60),
        // Tiny sources often grow; the point here is that the encoder runs.
        skipLarger: false,
      });

      expect(report.summary.failed, `${ext} should encode`).toBe(0);
      await access(join(dir, `out${ext.replace(".", "-")}`, `source${ext}`));
    }
  }, 60_000);

  it("accepts alias extensions the old fixed list never had", async () => {
    const src = join(dir, "alias");
    await makeImage(join(src, "a.png"));

    // `.jfif` and `.tif` are ordinary JPEG/TIFF spellings that v1 rejected.
    for (const ext of [".jfif", ".tif"]) {
      const out = join(dir, `alias${ext.replace(".", "-")}`);
      const report = await compressImages([src], {
        outDir: out,
        to: ext,
        skipLarger: false,
      });
      expect(report.summary.failed, `${ext}`).toBe(0);
      await access(join(out, `a${ext}`));
    }
  });

  it("explains an unavailable format instead of just refusing it", async () => {
    const src = join(dir, "explain");
    await makeImage(join(src, "a.png"));

    await expect(
      compressImages([src], { outDir: join(dir, "explain-out"), to: ".svg" }),
    ).rejects.toThrow(/read but not written/i);
  });

  it("reads formats it cannot write", async () => {
    const caps = await imageCapabilities();
    // The asymmetry is the whole point: SVG in, never SVG out.
    expect(caps.readableExtensions.has(".svg")).toBe(true);
    expect(caps.writableByExtension.has(".svg")).toBe(false);
  });
});

describe("open-tier video argument construction", () => {
  it("omits the codec entirely when none is known", () => {
    // Forcing a guess would risk an illegal container/codec pairing; leaving it
    // out lets ffmpeg apply the muxer's own default, which is always muxable.
    const args = buildOpenVideoArgs({
      inputPath: "in.mp4",
      outputPath: "out.mxf",
      extension: ".mxf",
      videoCodec: null,
      audioCodec: null,
      quality: toQuality(70),
    });

    expect(args).not.toContain("-c:v");
    expect(args).not.toContain("-crf");
    expect(args).toContain("out.mxf");
  });

  it("applies a quality flag when the codec's scale is known", () => {
    const args = buildOpenVideoArgs({
      inputPath: "in.mp4",
      outputPath: "out.mkv",
      extension: ".mkv",
      videoCodec: "libx264",
      audioCodec: "aac",
      quality: toQuality(70),
    });

    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-crf");
  });

  it("uses the codec's own quality flag, not always -crf", () => {
    // Theora takes -q:v on an inverted scale; emitting -crf would be ignored.
    const args = buildOpenVideoArgs({
      inputPath: "in.mp4",
      outputPath: "out.ogv",
      extension: ".ogv",
      videoCodec: "libtheora",
      audioCodec: "libvorbis",
      quality: toQuality(90),
    });

    expect(args).toContain("-q:v");
    expect(args).not.toContain("-crf");
  });

  it("still applies faststart for MP4-family containers", () => {
    const args = buildOpenVideoArgs({
      inputPath: "in.mkv",
      outputPath: "out.m4v",
      extension: ".m4v",
      videoCodec: null,
      audioCodec: null,
      quality: toQuality(70),
    });
    expect(args).toContain("+faststart");
  });
});

describe.skipIf(!(await hasFfmpeg()))(
  "video formats beyond the curated set (requires ffmpeg)",
  () => {
    let dir: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ dir, cleanup } = await tempDir());
    });
    afterAll(() => cleanup());

    it("encodes to a container that is not in the curated matrix", async () => {
      const src = join(dir, "open");
      await makeVideo(join(src, "clip.mp4"));

      // `.m4v` has no curated entry; it must still work via ffmpeg's defaults.
      const report = await compressVideos([src], {
        outDir: join(dir, "open-out"),
        to: ".m4v",
        quality: toQuality(50),
        skipLarger: false,
      });

      expect(report.summary.failed).toBe(0);
      await access(join(dir, "open-out", "clip.m4v"));
    }, 120_000);

    it("rejects a container this ffmpeg genuinely cannot mux", async () => {
      const src = join(dir, "bogus");
      await makeVideo(join(src, "clip.mp4"));

      const report = await compressVideos([src], {
        outDir: join(dir, "bogus-out"),
        to: ".notarealformat",
        quality: toQuality(50),
      });

      expect(report.summary.failed).toBe(1);
    }, 120_000);

    it("names the format count rather than a hardcoded list", async () => {
      const result = await runCli(["formats"]);
      // Proves the listing is read from the binary, not from source.
      expect(result.stdout).toMatch(/\d+ muxers and \d+ demuxers/);
      expect(result.exitCode).toBe(0);
    });
  },
);
