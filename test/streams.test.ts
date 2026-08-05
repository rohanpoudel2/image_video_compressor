import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { tempDir, hasFfmpeg } from "./helpers.js";
import { compressVideos } from "../src/core/compress.js";
import { planStreams } from "../src/core/compress.js";
import { parseProbe } from "../src/codecs/ffmpeg.js";
import { curatedArgs } from "../src/codecs/video.js";
import {
  isImageSubtitle,
  subtitleCodecFor,
  VIDEO_CONTAINERS,
} from "../src/types/video-formats.js";
import { toQuality } from "../src/types/brand.js";
import type { MediaProbe } from "../src/codecs/ffmpeg.js";

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
}

/** codec_type,codec_name[,language] for every stream, one per line. */
function streamsOf(file: string): Promise<string> {
  return run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name:stream_tags=language",
    "-of",
    "csv=p=0",
    file,
  ]);
}

/**
 * Build a file with two audio tracks and a subtitle — the shape that exposed
 * the bug. ffmpeg's default stream selection takes exactly one stream per
 * type, so without explicit mapping the second language and any subtitle past
 * the first vanish with no warning.
 */
async function makeMultiTrack(dir: string): Promise<string> {
  const bare = join(dir, "bare.mkv");
  const srt = join(dir, "subs.srt");
  const out = join(dir, "input.mkv");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=15",
        "-t",
        "2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440",
        "-t",
        "2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880",
        "-t",
        "2",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:a",
        "-metadata:s:a:0",
        "language=eng",
        "-metadata:s:a:1",
        "language=jpn",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        bare,
      ],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${String(code)}`)),
    );
  });

  await writeFile(srt, "1\n00:00:00,000 --> 00:00:02,000\nhello\n");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        bare,
        "-i",
        srt,
        "-map",
        "0",
        "-map",
        "1",
        "-c",
        "copy",
        "-c:s",
        "srt",
        out,
      ],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${String(code)}`)),
    );
  });

  return out;
}

const probeOf = (streams: unknown[], duration = "2"): MediaProbe =>
  parseProbe(JSON.stringify({ streams, format: { duration } }));

describe("subtitle compatibility", () => {
  it("knows text subtitles from image ones", () => {
    // Image subtitles are pixels; the words cannot be recovered as text, so
    // they can only ever be copied, never transcoded.
    expect(isImageSubtitle("hdmv_pgs_subtitle")).toBe(true);
    expect(isImageSubtitle("dvd_subtitle")).toBe(true);
    expect(isImageSubtitle("subrip")).toBe(false);
    expect(isImageSubtitle("ass")).toBe(false);
  });

  it("picks the codec each container actually requires", () => {
    expect(subtitleCodecFor(".mkv", "subrip")).toBe("copy");
    // MP4 stores text subtitles only as mov_text.
    expect(subtitleCodecFor(".mp4", "subrip")).toBe("mov_text");
    expect(subtitleCodecFor(".webm", "subrip")).toBe("webvtt");
  });

  it("refuses what a container genuinely cannot carry", () => {
    expect(subtitleCodecFor(".avi", "subrip")).toBeNull();
    // MP4 has no place for image-based subtitles.
    expect(subtitleCodecFor(".mp4", "hdmv_pgs_subtitle")).toBeNull();
    // Matroska takes them untouched.
    expect(subtitleCodecFor(".mkv", "hdmv_pgs_subtitle")).toBe("copy");
  });

  it("declares subtitle support for every curated container", () => {
    for (const [ext, spec] of Object.entries(VIDEO_CONTAINERS)) {
      expect(spec.subtitles, `${ext} must declare subtitle support`).toBeDefined();
    }
  });
});

describe("stream planning", () => {
  it("keeps every audio track, not just the first", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "jpn" } },
    ]);

    const { plan, dropped } = planStreams(".mkv", probe);

    expect(plan.audio).toEqual([1, 2]);
    expect(dropped).toEqual([]);
  });

  it("keeps every subtitle track", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "subtitle", codec_name: "subrip" },
      { index: 2, codec_type: "subtitle", codec_name: "subrip" },
    ]);

    expect(planStreams(".mkv", probe).plan.subtitles).toHaveLength(2);
  });

  it("names the track it had to drop instead of dropping it silently", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      {
        index: 1,
        codec_type: "subtitle",
        codec_name: "subrip",
        tags: { language: "fre" },
      },
    ]);

    const { plan, dropped } = planStreams(".avi", probe);

    expect(plan.subtitles).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/dropped subtitle/i);
    expect(dropped[0]).toContain("fre"); // identifies *which* track
    expect(dropped[0]).toContain("AVI");
  });

  it("explains that an image subtitle is image-based", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" },
    ]);

    expect(planStreams(".mp4", probe).dropped[0]).toMatch(/image-based/i);
  });

  it("never hands cover art to the video encoder", () => {
    // Attached pictures are typed as video but are a single still frame.
    // Encoding one as video produces a broken one-frame track.
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      {
        index: 1,
        codec_type: "video",
        codec_name: "mjpeg",
        disposition: { attached_pic: 1 },
      },
      { index: 2, codec_type: "audio", codec_name: "aac" },
    ]);

    expect(probe.video.map((v) => v.index)).toEqual([0]);
    expect(probe.attachedPictures.map((p) => p.index)).toEqual([1]);
    expect(planStreams(".mp4", probe).plan.video).toEqual([0]);
  });

  it("ignores data streams, which most containers refuse to mux", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "data", codec_name: "bin_data" },
    ]);

    expect(planStreams(".mp4", probe).plan.video).toEqual([0]);
  });

  it("carries Matroska font attachments when subtitles need them", () => {
    const probe = probeOf([
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "subtitle", codec_name: "ass" },
      { index: 2, codec_type: "attachment", codec_name: "ttf" },
    ]);

    expect(planStreams(".mkv", probe).plan.attachments).toBe(true);
    // Nothing else carries them, and there is no point without subtitles.
    expect(planStreams(".mp4", probe).plan.attachments).toBe(false);
  });
});

describe("argument construction for multiple streams", () => {
  it("maps each stream explicitly rather than letting ffmpeg choose", () => {
    const args = curatedArgs({
      inputPath: "in.mkv",
      outputPath: "out.mkv",
      container: ".mkv",
      videoCodec: "libx264",
      audioCodec: "copy",
      quality: toQuality(50),
      streams: {
        video: [0],
        audio: [1, 2],
        subtitles: [{ index: 3, codec: "copy" }],
        attachments: false,
      },
    });

    const maps = args.filter((_, i) => args[i - 1] === "-map");
    expect(maps).toEqual(["0:0", "0:1", "0:2", "0:3"]);
  });

  it("gives each audio stream its own capped bitrate", () => {
    // A single -b:a would inflate the quieter track to match the louder one.
    const args = curatedArgs({
      inputPath: "in.mkv",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      quality: toQuality(50),
      sourceAudioBitrates: [64_000, 192_000],
      streams: { video: [0], audio: [1, 2], subtitles: [], attachments: false },
    });

    expect(args[args.indexOf("-b:a:0") + 1]).toBe("64k");
    // Capped at the codec default rather than the richer source.
    expect(args[args.indexOf("-b:a:1") + 1]).toBe("128k");
  });

  it("assigns a subtitle codec per stream", () => {
    const args = curatedArgs({
      inputPath: "in.mkv",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "copy",
      quality: toQuality(50),
      streams: {
        video: [0],
        audio: [1],
        subtitles: [
          { index: 2, codec: "mov_text" },
          { index: 3, codec: "mov_text" },
        ],
        attachments: false,
      },
    });

    expect(args[args.indexOf("-c:s:0") + 1]).toBe("mov_text");
    expect(args[args.indexOf("-c:s:1") + 1]).toBe("mov_text");
  });

  it("emits no -map at all when the source could not be probed", () => {
    // Without a probe we must not guess; ffmpeg's default selection is the
    // only safe fallback.
    const args = curatedArgs({
      inputPath: "in.mkv",
      outputPath: "out.mp4",
      container: ".mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      quality: toQuality(50),
    });

    expect(args).not.toContain("-map");
  });
});

describe.skipIf(!(await hasFfmpeg()))(
  "multi-track end-to-end (requires ffmpeg)",
  () => {
    let dir: string;
    let cleanup: () => Promise<void>;
    let input: string;

    beforeAll(async () => {
      ({ dir, cleanup } = await tempDir());
      input = await makeMultiTrack(dir);
    }, 120_000);
    afterAll(() => cleanup());

    it("the fixture really has two audio tracks and a subtitle", async () => {
      const streams = await streamsOf(input);
      expect(streams.split("\n")).toHaveLength(4);
      expect(streams).toContain("jpn");
    });

    it("keeps both audio tracks through an MKV re-encode", async () => {
      // This is the regression: the Japanese track used to disappear silently.
      const out = join(dir, "mkv-out");
      await compressVideos([input], {
        outDir: out,
        to: ".mkv",
        quality: toQuality(50),
        skipLarger: false,
      });

      const streams = await streamsOf(join(out, "input.mkv"));
      expect(streams).toContain("eng");
      expect(streams).toContain("jpn");
      expect(streams.split("\n")).toHaveLength(4);
    }, 120_000);

    it("preserves the subtitle format when the container allows it", async () => {
      const streams = await streamsOf(join(dir, "mkv-out", "input.mkv"));
      // Matroska takes SubRip as-is; converting to ASS would lose nothing
      // visible but is needless churn.
      expect(streams).toContain("subrip");
    });

    it("converts subtitles to what MP4 requires", async () => {
      const out = join(dir, "mp4-out");
      await compressVideos([input], {
        outDir: out,
        to: ".mp4",
        quality: toQuality(50),
        skipLarger: false,
      });

      const streams = await streamsOf(join(out, "input.mp4"));
      expect(streams).toContain("mov_text");
      expect(streams).toContain("jpn");
    }, 120_000);

    it("converts subtitles to WebVTT for WebM and re-encodes audio to Opus", async () => {
      const out = join(dir, "webm-out");
      await compressVideos([input], {
        outDir: out,
        to: ".webm",
        quality: toQuality(45),
        skipLarger: false,
      });

      const streams = await streamsOf(join(out, "input.webm"));
      expect(streams).toContain("webvtt");
      expect(streams.match(/opus/g)).toHaveLength(2); // both tracks survived
    }, 180_000);

    it("reports the dropped subtitle when writing AVI", async () => {
      const out = join(dir, "avi-out");
      const report = await compressVideos([input], {
        outDir: out,
        to: ".avi",
        quality: toQuality(50),
        skipLarger: false,
      });

      const result = report.results[0];
      expect(result?.status).toBe("compressed");
      const warnings = result && "warnings" in result ? (result.warnings ?? []) : [];
      expect(warnings.join(" ")).toMatch(/dropped subtitle/i);

      // Audio still survives in full, even though the subtitle could not.
      const streams = await streamsOf(join(out, "input.avi"));
      expect(streams.match(/audio/g)).toHaveLength(2);
    }, 120_000);
  },
);
