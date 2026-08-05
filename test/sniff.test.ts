import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { writeFile, rename } from "node:fs/promises";

import { tempDir, makeImage, makeVideo, hasFfmpeg } from "./helpers.js";
import { sniff, sniffFile } from "../src/core/sniff.js";
import { classifyFile } from "../src/core/discover.js";

/** Build a header buffer from bytes, padded so length checks pass. */
function header(...bytes: number[]): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);
}

describe("content sniffing", () => {
  it("identifies unambiguous image signatures", () => {
    expect(sniff(header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.format).toBe(
      "PNG",
    );
    expect(sniff(header(0xff, 0xd8, 0xff, 0xe0))?.format).toBe("JPEG");
    expect(sniff(Buffer.from("GIF89a" + "\0".repeat(32)))?.format).toBe("GIF");
    expect(sniff(header(0x49, 0x49, 0x2a, 0x00))?.format).toBe("TIFF");
  });

  it("identifies unambiguous video signatures", () => {
    expect(sniff(header(0x1a, 0x45, 0xdf, 0xa3))?.kind).toBe("video");
    expect(sniff(Buffer.from("FLV\x01" + "\0".repeat(32)))?.kind).toBe("video");
    expect(sniff(Buffer.from("OggS" + "\0".repeat(32)))?.kind).toBe("video");
  });

  it("separates WebP from AVI, which share the RIFF magic", () => {
    // Both start `RIFF`; only the type at offset 8 tells them apart.
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
      Buffer.alloc(32),
    ]);
    const avi = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("AVI "),
      Buffer.alloc(32),
    ]);

    expect(sniff(webp)).toEqual({ kind: "image", format: "WebP" });
    expect(sniff(avi)).toEqual({ kind: "video", format: "AVI" });
  });

  it("separates AVIF/HEIC from MP4, which share the ISO container", () => {
    // The `ftyp` brand is the only difference between an image and a video here.
    const iso = (brand: string) =>
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from("ftyp"),
        Buffer.from(brand),
        Buffer.alloc(32),
      ]);

    expect(sniff(iso("avif"))).toEqual({ kind: "image", format: "AVIF" });
    expect(sniff(iso("heic"))).toEqual({ kind: "image", format: "HEIC" });
    expect(sniff(iso("mp42"))?.kind).toBe("video");
    expect(sniff(iso("isom"))?.kind).toBe("video");
  });

  it("recognises SVG, which is text rather than binary", () => {
    expect(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="..."></svg>'))).toEqual({
      kind: "image",
      format: "SVG",
    });
    expect(sniff(Buffer.from('<svg width="10"></svg>'))?.format).toBe("SVG");
  });

  it("requires a repeating sync byte for MPEG-TS, not just one 0x47", () => {
    // A single 0x47 is the letter "G" and would match far too much.
    expect(sniff(Buffer.from("Good morning" + " ".repeat(64)))).toBeNull();

    const ts = Buffer.alloc(600, 0);
    for (const offset of [0, 188, 376, 564]) ts[offset] = 0x47;
    expect(sniff(ts)?.format).toBe("MPEG-TS");
  });

  it("returns null for data it cannot identify", () => {
    expect(sniff(Buffer.from("just some plain text here, nothing special"))).toBeNull();
    expect(sniff(Buffer.alloc(2))).toBeNull();
  });
});

describe("sniffing real files", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("reads a real encoded image off disk", async () => {
    const path = join(dir, "real.png");
    await makeImage(path, { format: "png" });
    expect(await sniffFile(path)).toEqual({ kind: "image", format: "PNG" });
  });

  it("returns null for a file that does not exist", async () => {
    expect(await sniffFile(join(dir, "absent.png"))).toBeNull();
  });

  it("classifies a file with no extension at all", async () => {
    // The extension index cannot help here; only the bytes can.
    const named = join(dir, "with-ext.png");
    await makeImage(named);
    const unnamed = join(dir, "no-extension-at-all");
    await rename(named, unnamed);

    expect(await classifyFile(unnamed)).toBe("image");
  });

  it("classifies an unknown extension by its contents", async () => {
    const path = join(dir, "mystery.bin");
    await makeImage(join(dir, "src.png"));
    const { readFile } = await import("node:fs/promises");
    await writeFile(path, await readFile(join(dir, "src.png")));

    expect(await classifyFile(path)).toBe("image");
  });

  it("prefers the extension when it is recognised", async () => {
    // Cheap and correct almost always; sharp and ffmpeg detect real content
    // themselves, so a merely mislabelled file still encodes fine.
    const path = join(dir, "plain.jpg");
    await makeImage(path, { format: "png" }); // PNG bytes, .jpg name
    expect(await classifyFile(path)).toBe("image");
  });
});

describe.skipIf(!(await hasFfmpeg()))("sniffing video (requires ffmpeg)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("identifies a real MP4 as video, not as an AVIF image", async () => {
    const path = join(dir, "clip.mp4");
    await makeVideo(path);

    const result = await sniffFile(path);
    expect(result?.kind).toBe("video");
  }, 60_000);

  it("classifies a video wearing an image extension by its contents", async () => {
    // The extension index says image; the bytes say otherwise. Only an
    // explicitly named file gets the sniff, which is what happens here.
    const real = join(dir, "real.mp4");
    await makeVideo(real);
    const disguised = join(dir, "sneaky.mp4");
    await rename(real, disguised);

    expect((await sniffFile(disguised))?.kind).toBe("video");
  }, 60_000);
});
