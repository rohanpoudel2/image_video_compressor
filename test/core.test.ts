import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { access } from "node:fs/promises";

import { tempDir, makeImage } from "./helpers.js";
import { mapWithConcurrency, defaultConcurrency } from "../src/core/pool.js";
import { discoverFiles, classifyFile, isUnder } from "../src/core/discover.js";
import { compressImages } from "../src/core/compress.js";
import { CompressorError } from "../src/core/errors.js";
import { toQuality, toPixels } from "../src/types/brand.js";

describe("bounded concurrency", () => {
  it("never exceeds the configured limit", async () => {
    // v1's Promise.all had no ceiling: 500 videos meant 500 ffmpeg processes.
    let active = 0;
    let peak = 0;

    const items = Array.from({ length: 40 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order regardless of completion order", async () => {
    const items = [50, 10, 30, 5, 20];
    const results = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return ms;
    });

    expect(results).toEqual(items);
  });

  it("handles an empty input list", async () => {
    expect(await mapWithConcurrency([], 4, (x) => Promise.resolve(x))).toEqual([]);
  });

  it("stops early when the signal aborts", async () => {
    const controller = new AbortController();
    let processed = 0;

    const promise = mapWithConcurrency(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      async (i) => {
        processed++;
        if (processed === 5) controller.abort();
        await new Promise((r) => setTimeout(r, 1));
        return i;
      },
      controller.signal,
    );

    await expect(promise).rejects.toThrow();
    expect(processed).toBeLessThan(100);
  });

  it("picks a lower default for video than for images", () => {
    // ffmpeg saturates cores on its own; stacking processes only adds contention.
    expect(defaultConcurrency("video")).toBeLessThanOrEqual(
      defaultConcurrency("image"),
    );
    expect(defaultConcurrency("video")).toBeGreaterThanOrEqual(1);
  });
});

describe("file discovery", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    await makeImage(join(dir, "root.png"));
    await makeImage(join(dir, "nested", "deep.png"));
    await makeImage(join(dir, "nested", "more", "deeper.jpg"));
    await makeImage(join(dir, ".hidden.png"));
  });
  afterAll(() => cleanup());

  it("scans one level by default", async () => {
    const found = await discoverFiles([dir]);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toContain("root.png");
  });

  it("descends when recursive", async () => {
    const found = await discoverFiles([dir], { recursive: true });
    expect(found.length).toBe(3);
  });

  it("ignores dotfiles so .DS_Store never reaches the encoder", async () => {
    const found = await discoverFiles([dir], { recursive: true });
    expect(found.some((f) => f.path.includes(".hidden"))).toBe(false);
  });

  it("accepts an individual file, which v1 could not do at all", async () => {
    const found = await discoverFiles([join(dir, "root.png")]);
    expect(found).toHaveLength(1);
  });

  it("refuses to descend into the output directory", async () => {
    // Otherwise a second run re-compresses its own output: generation loss.
    const out = join(dir, "nested");
    const found = await discoverFiles([dir], { recursive: true, excludeDirs: [out] });

    expect(found.every((f) => !f.path.includes("nested"))).toBe(true);
  });

  it("deduplicates a path given twice", async () => {
    const found = await discoverFiles([dir, dir]);
    expect(found).toHaveLength(1);
  });

  it("filters by media kind", async () => {
    const found = await discoverFiles([dir], { recursive: true, kind: "video" });
    expect(found).toHaveLength(0);
  });

  it("throws a typed error for a missing path", async () => {
    await expect(discoverFiles([join(dir, "nope")])).rejects.toThrow(CompressorError);
  });

  it("throws rather than silently ignoring an unsupported named file", async () => {
    const readme = join(dir, "notes.txt");
    await makeImage(join(dir, "real.png"));
    await import("node:fs/promises").then((fs) => fs.writeFile(readme, "hi"));

    await expect(discoverFiles([readme])).rejects.toThrow(/Unrecognised file type/);
  });

  it("classifies by extension", async () => {
    expect(await classifyFile(join(dir, "root.png"))).toBe("image");
    // Non-existent paths fall through to a sniff that cannot open them, so the
    // extension is the only signal — which is exactly what is under test.
    expect(await classifyFile("a.PNG")).toBe("image");
    expect(await classifyFile("a.mp4")).toBe("video");
    expect(await classifyFile("a.txt")).toBe(null);
    expect(await classifyFile("a.svg")).toBe("image"); // readable, not writable
  });

  it("isUnder does not match a sibling with a shared prefix", () => {
    expect(isUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isUnder("/a/bcd", "/a/b")).toBe(false);
    expect(isUnder("/a/b", null)).toBe(false);
  });
});

describe("compression behaviour", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("writes nothing on a dry run", async () => {
    const src = join(dir, "dry");
    const out = join(dir, "dry-out");
    await makeImage(join(src, "a.png"));

    const report = await compressImages([src], { outDir: out, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.planned).toBe(1);
    expect(report.summary.plannedInputBytes).toBeGreaterThan(0);
    expect(report.summary.inputBytes).toBe(0);
    expect(report.summary.savedBytes).toBe(0);
    await expect(access(out)).rejects.toThrow();
  });

  it("reports an existing output as skipped in a dry run", async () => {
    const src = join(dir, "dry-existing");
    const out = join(dir, "dry-existing-out");
    await makeImage(join(src, "a.png"));
    await makeImage(join(out, "a.webp"), { format: "webp" });

    const report = await compressImages([src], { outDir: out, dryRun: true });

    expect(report.results[0]).toMatchObject({
      status: "skipped",
      reason: "output-exists",
      targetFormat: ".webp",
    });
    expect(report.summary.planned).toBe(0);
    expect(report.summary.plannedInputBytes).toBe(0);
  });

  it("skips an existing output unless --overwrite", async () => {
    const src = join(dir, "over");
    const out = join(dir, "over-out");
    await makeImage(join(src, "a.png"));

    await compressImages([src], { outDir: out });
    const second = await compressImages([src], { outDir: out });

    expect(second.summary.skipped).toBe(1);

    const third = await compressImages([src], { outDir: out, overwrite: true });
    expect(third.summary.compressed).toBe(1);
  });

  it("keeps the original when compression would make it bigger", async () => {
    const src = join(dir, "larger");
    const out = join(dir, "larger-out");
    // A tiny noisy source: re-encoding overhead exceeds any saving.
    await makeImage(join(src, "noise.png"), { width: 8, height: 8, noise: true });

    const report = await compressImages([src], {
      outDir: out,
      to: ".png",
      quality: toQuality(100),
    });

    const result = report.results[0];
    if (result?.status === "skipped") {
      expect(result.reason).toBe("output-larger-than-input");
      await expect(access(result.outputPath)).rejects.toThrow();
    } else {
      expect(result?.status).toBe("compressed");
    }
  });

  it("mirrors the directory structure under the output root", async () => {
    const src = join(dir, "tree");
    const out = join(dir, "tree-out");
    await makeImage(join(src, "top.png"));
    await makeImage(join(src, "sub", "inner.png"));

    await compressImages([src], { outDir: out, recursive: true });

    await access(join(out, "top.webp"));
    await access(join(out, "sub", "inner.webp"));
  });

  it("resizes without enlarging a smaller source", async () => {
    const src = join(dir, "resize");
    const out = join(dir, "resize-out");
    await makeImage(join(src, "small.png"), { width: 100, height: 100 });

    await compressImages([src], {
      outDir: out,
      to: ".png",
      resize: { maxWidth: toPixels(500) },
    });

    const sharp = (await import("sharp")).default;
    const meta = await sharp(join(out, "small.png")).metadata();
    expect(meta.width).toBe(100);
  });

  it("shrinks a source larger than the requested bound", async () => {
    const src = join(dir, "shrink");
    const out = join(dir, "shrink-out");
    await makeImage(join(src, "big.png"), { width: 1000, height: 500 });

    await compressImages([src], {
      outDir: out,
      to: ".png",
      resize: { maxWidth: toPixels(200) },
    });

    const sharp = (await import("sharp")).default;
    const meta = await sharp(join(out, "big.png")).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100); // aspect ratio preserved
  });

  it("does not re-compress its own output on a recursive re-run", async () => {
    // The default destination is `<source>/compressed`, which sits inside the
    // scanned tree. Without excluding it, every run would re-encode the
    // previous run's output and lose a generation of quality each time.
    const src = join(dir, "rerun");
    await makeImage(join(src, "a.png"));

    const first = await compressImages([src], { recursive: true });
    expect(first.summary.compressed).toBe(1);

    const second = await compressImages([src], { recursive: true });
    expect(second.summary.totalFiles).toBe(1);
    expect(second.results.every((r) => !r.inputPath.includes("compressed"))).toBe(true);
  });

  it("allows converting in place to a different format", async () => {
    // --out pointing at the source is legitimate when the extension changes;
    // only writing over the exact source path is refused.
    const src = join(dir, "inplace-ok");
    await makeImage(join(src, "a.png"));

    const report = await compressImages([src], { outDir: src, to: ".webp" });

    expect(report.summary.compressed).toBe(1);
    await access(join(src, "a.webp"));
  });

  it("refuses to write output over its own source", async () => {
    const src = join(dir, "inplace");
    await makeImage(join(src, "a.png"));

    await expect(compressImages([src], { outDir: src, to: ".png" })).rejects.toThrow(
      /in place/i,
    );
  });

  it("rejects two sources that would collide on one destination", async () => {
    const src = join(dir, "collide");
    await makeImage(join(src, "a.png"));
    await makeImage(join(src, "sub", "a.png"));

    await expect(
      compressImages([src], {
        outDir: join(dir, "collide-out"),
        recursive: true,
        to: ".webp",
      }),
    ).resolves.toBeDefined(); // distinct subpaths are mirrored, so no collision

    await expect(
      compressImages([join(src, "a.png"), join(src, "sub", "a.png")], {
        outDir: join(dir, "collide-out2"),
      }),
    ).rejects.toThrow(/would be written to/);
  });
});
