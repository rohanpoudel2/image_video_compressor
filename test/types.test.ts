import { describe, it, expect } from "vitest";

import {
  VIDEO_CONTAINERS,
  defaultVideoCodec,
  isCodecAllowedIn,
  qualityToCrf,
  type VideoCodecFor,
  type VideoContainer,
} from "../src/types/video-formats.js";
import { IMAGE_FORMATS, isImageOutputFormat } from "../src/types/image-formats.js";
import { toQuality, toPixels, RangeValidationError } from "../src/types/brand.js";

/**
 * Compile-time guarantees.
 *
 * The `@ts-expect-error` lines are the real assertions here: each fails the
 * build if the error it marks ever stops occurring. `npm run typecheck` is what
 * enforces them, so these regressions cannot return silently.
 */
describe("type-level guarantees", () => {
  it("rejects a codec the container cannot mux", () => {
    function encode<C extends VideoContainer>(_c: C, _codec: VideoCodecFor<C>): void {}

    encode(".mp4", "libx264");
    encode(".webm", "libvpx-vp9");
    encode(".mkv", "libx265");

    // @ts-expect-error WebM cannot carry H.264 — the exact pairing v1 emitted.
    encode(".webm", "libx264");
    // @ts-expect-error AVI is x264-only in this matrix.
    encode(".avi", "libvpx-vp9");

    expect(true).toBe(true);
  });

  it("rejects a raw number where a validated quality is required", () => {
    qualityToCrf(toQuality(50), "libx264");

    // @ts-expect-error Quality is branded; an unchecked number is not one.
    qualityToCrf(50, "libx264");

    expect(true).toBe(true);
  });

  it("narrows the default codec to a single literal, not the union", () => {
    const webm: "libvpx-vp9" = defaultVideoCodec(".webm");
    const mp4: "libx264" = defaultVideoCodec(".mp4");

    expect(webm).toBe("libvpx-vp9");
    expect(mp4).toBe("libx264");
  });
});

describe("runtime matrix agrees with the types", () => {
  it("every container lists at least one legal video and audio codec", () => {
    for (const [ext, spec] of Object.entries(VIDEO_CONTAINERS)) {
      expect(spec.video.length, `${ext} video codecs`).toBeGreaterThan(0);
      expect(spec.audio.length, `${ext} audio codecs`).toBeGreaterThan(0);
    }
  });

  it("isCodecAllowedIn matches the declared matrix", () => {
    expect(isCodecAllowedIn(".webm", "libx264")).toBe(false);
    expect(isCodecAllowedIn(".webm", "libvpx-vp9")).toBe(true);
    expect(isCodecAllowedIn(".mp4", "libx264")).toBe(true);
    expect(isCodecAllowedIn(".mp4", "libvpx-vp9")).toBe(false);
  });

  it("does not advertise an image output format sharp cannot write", () => {
    // .svg is readable but never writable; it must not appear as an output.
    expect(isImageOutputFormat(".svg")).toBe(false);
    expect(Object.keys(IMAGE_FORMATS)).not.toContain(".svg");
  });
});

describe("branded constructors", () => {
  it("accepts the documented quality range", () => {
    expect(toQuality(1)).toBe(1);
    expect(toQuality(100)).toBe(100);
  });

  it.each([0, 101, -5, 3.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects quality %s",
    (value) => {
      expect(() => toQuality(value)).toThrow(RangeValidationError);
    },
  );

  it.each([0, -1, 2.5, Number.NaN])("rejects dimension %s", (value) => {
    expect(() => toPixels(value)).toThrow(RangeValidationError);
  });

  it("names the offending field in the error", () => {
    expect(() => toPixels(-1, "--max-width")).toThrow(/--max-width/);
  });
});
