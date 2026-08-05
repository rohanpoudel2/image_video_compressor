import { describe, it, expect, beforeEach } from "vitest";

import {
  encodeOptionsFor,
  imageCapabilities,
  resetImageCapabilities,
} from "../src/codecs/sharp-capabilities.js";
import {
  ffmpegCapabilities,
  muxerDetail,
  parseFormats,
  parseEncoders,
  parseMuxerDetail,
} from "../src/codecs/ffmpeg-capabilities.js";
import { hasFfmpeg } from "./helpers.js";

describe("sharp capability detection", () => {
  beforeEach(() => {
    resetImageCapabilities();
  });

  it("reports the formats this build can genuinely write", async () => {
    const caps = await imageCapabilities();

    // Universally present in any usable libvips build.
    const ids = caps.writable.map((c) => c.id);
    for (const id of ["jpeg", "png", "webp"] as const) {
      expect(ids, `${id} should be writable`).toContain(id);
    }
    expect(caps.writable.length).toBeGreaterThan(3);
  });

  it("only reports a format after actually encoding with it", async () => {
    const caps = await imageCapabilities();

    // Whatever the answer is per build, it must match a real encode attempt.
    const sharp = (await import("sharp")).default;
    for (const capability of caps.writable) {
      let buffer: Buffer | null = null;
      try {
        buffer = await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#000" },
        })
          .toFormat(capability.id, encodeOptionsFor(capability, 50))
          .toBuffer();
      } catch {
        buffer = null;
      }

      expect(
        buffer,
        `${capability.id} was reported writable but failed to encode`,
      ).not.toBeNull();
    }
  });

  it("never reports a writable format that sharp rejects", async () => {
    const caps = await imageCapabilities();
    const sharp = (await import("sharp")).default;

    // jp2/jxl/heif are commonly absent; whichever are missing here must not
    // appear in the table. v1 advertised all three unconditionally.
    for (const probe of [
      { id: "jp2", options: {} },
      { id: "jxl", options: {} },
      { id: "heif", options: { compression: "hevc" } },
    ] as const) {
      // try/catch, not .catch(): JP2 rejects synchronously from toFormat()
      // while JXL and HEIF only fail once the encode runs.
      let works: boolean;
      try {
        await sharp({
          create: { width: 1, height: 1, channels: 3, background: "#000" },
        })
          .toFormat(probe.id, { quality: 50, ...probe.options })
          .toBuffer();
        works = true;
      } catch {
        works = false;
      }

      const reported = caps.writable.some((c) => c.id === probe.id);
      expect(reported, `${probe.id} claim must match reality`).toBe(works);
    }
  });

  it("maps every alias extension to a writable format", async () => {
    const caps = await imageCapabilities();

    expect(caps.writableByExtension.get(".jpg")?.id).toBe("jpeg");
    expect(caps.writableByExtension.get(".jpeg")?.id).toBe("jpeg");
    // Aliases v1 never accepted at all.
    expect(caps.writableByExtension.get(".jfif")?.id).toBe("jpeg");
    expect(caps.writableByExtension.get(".tif")?.id).toBe("tiff");
  });

  it("can read strictly more than it can write", async () => {
    const caps = await imageCapabilities();

    // SVG decodes but has no encoder — the asymmetry v1 collapsed and crashed on.
    expect(caps.readableExtensions.has(".svg")).toBe(true);
    expect(caps.writableByExtension.has(".svg")).toBe(false);
    expect(caps.readableExtensions.size).toBeGreaterThan(caps.writableByExtension.size);
  });

  it("caches the probe rather than re-running it per call", async () => {
    const first = await imageCapabilities();
    const second = await imageCapabilities();
    expect(second).toBe(first);
  });
});

describe("ffmpeg output parsers", () => {
  it("parses the -muxers table", () => {
    const sample = [
      "Formats:",
      " D.. = Demuxing supported",
      " .E. = Muxing supported",
      " ---",
      "  E  3g2             3GP2 (3GPP2 file format)",
      " DE  matroska        Matroska",
      " DE  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV",
    ].join("\n");

    const formats = parseFormats(sample);

    expect(formats.has("3g2")).toBe(true);
    expect(formats.get("matroska")?.description).toBe("Matroska");
    // One line can register several independently usable names.
    expect(formats.has("mp4")).toBe(true);
    expect(formats.has("m4a")).toBe(true);
  });

  it("separates video from audio encoders", () => {
    const sample = [
      "Encoders:",
      " V..... = Video",
      " ------",
      " V....D libx264              H.264 (codec h264)",
      " A....D aac                  AAC (Advanced Audio Coding)",
      " S..... webvtt               WebVTT subtitle",
    ].join("\n");

    const { video, audio } = parseEncoders(sample);

    expect(video.has("libx264")).toBe(true);
    expect(audio.has("aac")).toBe(true);
    expect(video.has("aac")).toBe(false);
    expect(audio.has("libx264")).toBe(false);
    // Subtitles are neither.
    expect(video.has("webvtt")).toBe(false);
  });

  it("parses per-muxer detail", () => {
    const sample = [
      "Muxer webm [WebM]:",
      "    Common extensions: webm.",
      "    Mime type: video/webm.",
      "    Default video codec: vp9.",
      "    Default audio codec: opus.",
    ].join("\n");

    const detail = parseMuxerDetail("webm", sample);

    expect(detail?.extensions).toEqual([".webm"]);
    expect(detail?.defaultVideoCodec).toBe("vp9");
    expect(detail?.defaultAudioCodec).toBe("opus");
  });

  it("returns null for a muxer ffmpeg does not have", () => {
    expect(parseMuxerDetail("nope", "Unknown format 'nope'.")).toBeNull();
  });
});

describe.skipIf(!(await hasFfmpeg()))(
  "ffmpeg capability probing (requires ffmpeg)",
  () => {
    it("reads a large, realistic muxer and encoder set from the binary", async () => {
      const caps = await ffmpegCapabilities("ffmpeg");

      // A stock build carries well over a hundred muxers; a handful would mean
      // the parser silently matched almost nothing.
      expect(caps.muxers.size).toBeGreaterThan(50);
      expect(caps.demuxers.size).toBeGreaterThan(50);
      expect(caps.videoEncoders.size).toBeGreaterThan(10);
      expect(caps.audioEncoders.size).toBeGreaterThan(5);
    });

    it("finds the containers the curated matrix depends on", async () => {
      const caps = await ffmpegCapabilities("ffmpeg");
      for (const muxer of ["mp4", "webm", "matroska", "mov", "avi"]) {
        expect(caps.muxers.has(muxer), `${muxer} muxer`).toBe(true);
      }
    });

    it("does not mix video and audio encoders", async () => {
      const caps = await ffmpegCapabilities("ffmpeg");

      expect(caps.videoEncoders.has("libx264")).toBe(true);
      expect(caps.videoEncoders.has("aac")).toBe(false);
      expect(caps.audioEncoders.has("aac")).toBe(true);
      expect(caps.audioEncoders.has("libx264")).toBe(false);
    });

    it("reports WebM's real defaults, which are not H.264", async () => {
      const detail = await muxerDetail("ffmpeg", "webm");

      expect(detail?.defaultVideoCodec).toBe("vp9");
      expect(detail?.defaultAudioCodec).toBe("opus");
      expect(detail?.extensions).toContain(".webm");
    });

    it("returns null for an unknown muxer instead of throwing", async () => {
      expect(await muxerDetail("ffmpeg", "definitelynotamuxer")).toBeNull();
    });
  },
);
