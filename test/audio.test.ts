import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { tempDir, makeVideo, hasFfmpeg } from "./helpers.js";
import { compressVideos } from "../src/core/compress.js";
import { resolveAudioBitrate, curatedArgs } from "../src/codecs/video.js";
import { parseProbe } from "../src/codecs/ffmpeg.js";
import { canCopyAudioInto } from "../src/types/video-formats.js";
import { toQuality } from "../src/types/brand.js";

function probeAudio(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,bit_rate",
        "-of",
        "csv=p=0",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
}

/**
 * Audio handling.
 *
 * The bug these lock in: a fixed `-b:a 128k` re-encoded a 70 kbps source
 * *upwards*, adding 80% to the audio track. On a short clip whose video
 * compresses to almost nothing — a 3s SMPTE-bars clip is 79% audio — that
 * alone pushed the output 49% past the original, and skip-larger then declined
 * to write anything at all.
 */
describe("audio bitrate never exceeds the source", () => {
  it("caps the bitrate at what the source already spends", () => {
    // 70 kbps source must not become a 128 kbps output.
    expect(resolveAudioBitrate("aac", 69_584)).toBe("70k");
    expect(resolveAudioBitrate("libopus", 48_000)).toBe("48k");
  });

  it("uses the codec default when the source is richer", () => {
    expect(resolveAudioBitrate("aac", 320_000)).toBe("128k");
    expect(resolveAudioBitrate("libopus", 256_000)).toBe("96k");
  });

  it("falls back to the default when the source bitrate is unknown", () => {
    // Some containers simply do not record a per-stream bitrate.
    expect(resolveAudioBitrate("aac", null)).toBe("128k");
  });

  it("does not collapse to an unusable bitrate for very quiet sources", () => {
    expect(resolveAudioBitrate("aac", 1_000)).toBe("32k");
  });

  it("returns null for codecs that take no bitrate", () => {
    expect(resolveAudioBitrate("copy", 128_000)).toBeNull();
    expect(resolveAudioBitrate("flac", 128_000)).toBeNull();
  });

  it("emits a capped -b:a in the argument vector", () => {
    const args = curatedArgs({
      inputPath: "in.mov",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      quality: toQuality(45),
      sourceAudioBitrates: [69_584],
    });

    const index = args.indexOf("-b:a:0");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("70k");
  });
});

describe("copying audio instead of re-encoding it", () => {
  it("knows which source streams a container can carry untouched", () => {
    expect(canCopyAudioInto(".mp4", "aac")).toBe(true);
    expect(canCopyAudioInto(".webm", "opus")).toBe(true);
    expect(canCopyAudioInto(".mkv", "vorbis")).toBe(true);

    // AAC is not legal in WebM, so its audio genuinely must be re-encoded.
    expect(canCopyAudioInto(".webm", "aac")).toBe(false);
    expect(canCopyAudioInto(".mp4", "opus")).toBe(false);
  });

  it("maps stream names to encoder names, which differ", () => {
    // ffprobe reports `opus`; the encoder is `libopus`.
    expect(canCopyAudioInto(".webm", "libopus")).toBe(false);
    expect(canCopyAudioInto(".webm", "opus")).toBe(true);
  });

  it("omits a bitrate entirely when copying", () => {
    const args = curatedArgs({
      inputPath: "in.mov",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "copy",
      quality: toQuality(45),
      sourceAudioBitrates: [69_584],
    });

    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("copy");
    expect(args.some((a) => a.startsWith("-b:a"))).toBe(false);
  });
});

describe("ffprobe JSON parsing", () => {
  it("reads duration and the audio stream together", () => {
    const raw = JSON.stringify({
      streams: [
        { index: 0, codec_name: "h264", codec_type: "video", bit_rate: "8677" },
        { index: 1, codec_name: "aac", codec_type: "audio", bit_rate: "69584" },
      ],
      format: { duration: "3.000000" },
    });

    const probe = parseProbe(raw);
    expect(probe.durationSeconds).toBe(3);
    expect(probe.audio).toHaveLength(1);
    expect(probe.audio[0]).toMatchObject({ codec: "aac", bitrate: 69584 });
    expect(probe.video).toHaveLength(1);
  });

  it("reports no audio for a silent source", () => {
    const raw = JSON.stringify({
      streams: [{ index: 0, codec_name: "h264", codec_type: "video" }],
      format: { duration: "10" },
    });

    expect(parseProbe(raw).audio).toEqual([]);
    expect(parseProbe(raw).durationSeconds).toBe(10);
  });

  it("survives a missing bitrate field", () => {
    const raw = JSON.stringify({
      streams: [{ index: 0, codec_name: "opus", codec_type: "audio" }],
      format: {},
    });

    expect(parseProbe(raw).audio[0]).toMatchObject({ codec: "opus", bitrate: null });
    expect(parseProbe(raw).durationSeconds).toBeNull();
  });

  it("returns empty rather than throwing on unparseable output", () => {
    const probe = parseProbe("not json at all");
    expect(probe.durationSeconds).toBeNull();
    expect(probe.audio).toEqual([]);
    expect(probe.video).toEqual([]);
  });
});

describe.skipIf(!(await hasFfmpeg()))("audio end-to-end (requires ffmpeg)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("copies an AAC track into MP4 bit-for-bit", async () => {
    const src = join(dir, "copy");
    await makeVideo(join(src, "clip.mp4"), 2);

    await compressVideos([src], {
      outDir: join(dir, "copy-out"),
      quality: toQuality(45),
      skipLarger: false,
    });

    const before = await probeAudio(join(src, "clip.mp4"));
    const after = await probeAudio(join(dir, "copy-out", "clip.mp4"));

    // Identical codec *and* bitrate proves the stream was copied, not re-encoded.
    expect(after).toBe(before);
  }, 120_000);

  it("re-encodes to Opus for WebM, which cannot carry AAC", async () => {
    const src = join(dir, "webm");
    await makeVideo(join(src, "clip.mp4"), 2);

    await compressVideos([src], {
      outDir: join(dir, "webm-out"),
      to: ".webm",
      quality: toQuality(45),
      skipLarger: false,
    });

    const after = await probeAudio(join(dir, "webm-out", "clip.webm"));
    expect(after).toContain("opus");
  }, 180_000);

  it("never inflates the audio track past the source", async () => {
    const src = join(dir, "inflate");
    await makeVideo(join(src, "clip.mp4"), 2);

    await compressVideos([src], {
      outDir: join(dir, "inflate-out"),
      to: ".webm", // forces a re-encode, so the bitrate cap must apply
      quality: toQuality(45),
      skipLarger: false,
    });

    const sourceRate = Number(
      (await probeAudio(join(src, "clip.mp4"))).split(",")[1] ?? 0,
    );
    const outputRate = Number(
      (await probeAudio(join(dir, "inflate-out", "clip.webm"))).split(",")[1] ?? 0,
    );

    if (sourceRate > 0 && outputRate > 0) {
      // Allow encoder overshoot, but nothing like the 70k -> 128k jump.
      expect(outputRate).toBeLessThan(sourceRate * 1.3);
    }
  }, 180_000);
});
