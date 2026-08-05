/**
 * Image format types.
 *
 * The authoritative capability table lives in `codecs/sharp-capabilities.ts`
 * and is probed from the running sharp build, because support genuinely
 * differs per install — JP2, JXL and HEIC are all commonly absent. This module
 * holds the *types*, which exist for editor autocomplete rather than to limit
 * what can be written.
 *
 * The previous version hardcoded a list that was both too narrow (no `.jfif`,
 * no `.tif`) and too broad (it advertised `.svg`, which sharp can read but has
 * never been able to write, and crashed on it at encode time).
 */

/** Extensions the curated defaults are tuned for. Not the limit. */
export const CURATED_IMAGE_FORMATS = [
  ".jpg",
  ".jpeg",
  ".jpe",
  ".jfif",
  ".png",
  ".webp",
  ".avif",
  ".tif",
  ".tiff",
  ".gif",
  ".heic",
  ".heif",
  ".jp2",
  ".jpx",
  ".j2k",
  ".j2c",
  ".jxl",
] as const;

export type CuratedImageFormat = (typeof CURATED_IMAGE_FORMATS)[number];

/**
 * Any image extension, with the curated ones offered as suggestions.
 *
 * `string & {}` widens the union without collapsing the literals, so an editor
 * still autocompletes `".webp"` while a format this build happens to support
 * remains equally valid.
 */
export type ImageOutputFormat = CuratedImageFormat | (string & {});

export function isCuratedImageFormat(ext: string): ext is CuratedImageFormat {
  return (CURATED_IMAGE_FORMATS as readonly string[]).includes(ext);
}

/**
 * Extensions sharp can decode but never encode.
 *
 * Kept explicit so the error can say *why* rather than "unsupported format":
 * these are legitimate inputs, just not legitimate outputs.
 */
export const IMAGE_INPUT_ONLY_FORMATS = [
  ".svg",
  ".svgz",
  ".svg.gz",
  ".pdf",
  ".ppm",
  ".pgm",
  ".pbm",
  ".fits",
  ".exr",
  ".hdr",
  ".dcm",
  ".raw",
  ".arw",
  ".cr2",
  ".nef",
  ".dng",
  ".orf",
  ".rw2",
] as const;

export type ImageInputOnlyFormat = (typeof IMAGE_INPUT_ONLY_FORMATS)[number];

export function isInputOnlyImageFormat(ext: string): ext is ImageInputOnlyFormat {
  return (IMAGE_INPUT_ONLY_FORMATS as readonly string[]).includes(ext);
}
