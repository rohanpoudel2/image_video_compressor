import type { Sharp } from "sharp";

/**
 * Image format registry.
 *
 * v1 listed `.svg` as a valid output format in formats.json and mapped it to a
 * `sharp.svg()` method that has never existed, so `--output=.svg` died with
 * "image[formatMethod] is not a function" at runtime.
 *
 * The fix is structural rather than a patch: `encoder` below is constrained to
 * `Extract<keyof Sharp, ...>`, so a method name that sharp does not actually
 * expose cannot be written here. Adding `.svg` back would resolve to `never`
 * and fail to compile. The bug class is gone, not just this instance of it.
 */

/** Sharp instance methods that encode output. Verified against sharp's own types. */
type SharpEncoder = Extract<
  keyof Sharp,
  "jpeg" | "png" | "webp" | "avif" | "tiff" | "gif" | "jp2" | "heif" | "jxl"
>;

interface ImageFormatSpec {
  /** The sharp method used to encode this format. */
  readonly encoder: SharpEncoder;
  /** Whether the encoder honours a `quality` option. */
  readonly lossy: boolean;
  /** Whether the format can carry an alpha channel. */
  readonly alpha: boolean;
  /** Whether the format supports multi-frame animation. */
  readonly animated: boolean;
  /** Human-facing label used in help output. */
  readonly label: string;
}

export const IMAGE_FORMATS = {
  ".jpg": {
    encoder: "jpeg",
    lossy: true,
    alpha: false,
    animated: false,
    label: "JPEG",
  },
  ".jpeg": {
    encoder: "jpeg",
    lossy: true,
    alpha: false,
    animated: false,
    label: "JPEG",
  },
  ".png": {
    encoder: "png",
    lossy: true,
    alpha: true,
    animated: false,
    label: "PNG",
  },
  ".webp": {
    encoder: "webp",
    lossy: true,
    alpha: true,
    animated: true,
    label: "WebP",
  },
  ".avif": {
    encoder: "avif",
    lossy: true,
    alpha: true,
    animated: false,
    label: "AVIF",
  },
  ".tiff": {
    encoder: "tiff",
    lossy: true,
    alpha: true,
    animated: false,
    label: "TIFF",
  },
  ".gif": {
    encoder: "gif",
    lossy: false,
    alpha: true,
    animated: true,
    label: "GIF",
  },
} as const satisfies Record<`.${string}`, ImageFormatSpec>;

/** Extensions this tool can write. */
export type ImageOutputFormat = keyof typeof IMAGE_FORMATS;

/**
 * Extensions this tool can read. Sharp decodes SVG and HEIC even though it
 * cannot encode them, so the input set is deliberately wider than the output
 * set — the asymmetry v1 collapsed into one list and got wrong.
 */
export const IMAGE_INPUT_ONLY_FORMATS = [
  ".svg",
  ".heic",
  ".heif",
] as const satisfies readonly `.${string}`[];

export type ImageInputOnlyFormat = (typeof IMAGE_INPUT_ONLY_FORMATS)[number];
export type ImageInputFormat = ImageOutputFormat | ImageInputOnlyFormat;

export const IMAGE_OUTPUT_FORMATS = Object.keys(IMAGE_FORMATS) as ImageOutputFormat[];

export const IMAGE_INPUT_FORMATS: readonly ImageInputFormat[] = [
  ...IMAGE_OUTPUT_FORMATS,
  ...IMAGE_INPUT_ONLY_FORMATS,
];

export function isImageOutputFormat(ext: string): ext is ImageOutputFormat {
  return Object.prototype.hasOwnProperty.call(IMAGE_FORMATS, ext);
}

export function isImageInputFormat(ext: string): ext is ImageInputFormat {
  return (IMAGE_INPUT_FORMATS as readonly string[]).includes(ext);
}

/** True for formats readable but not writable, so we can explain *why*. */
export function isInputOnlyImageFormat(ext: string): ext is ImageInputOnlyFormat {
  return (IMAGE_INPUT_ONLY_FORMATS as readonly string[]).includes(ext);
}

export function imageFormatSpec(format: ImageOutputFormat): ImageFormatSpec {
  return IMAGE_FORMATS[format];
}
