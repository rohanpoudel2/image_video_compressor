import sharp from "sharp";
import type { Sharp } from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { CompressorError } from "../core/errors.js";
import {
  imageFormatSpec,
  isInputOnlyImageFormat,
  type ImageOutputFormat,
} from "../types/image-formats.js";
import type { Quality } from "../types/brand.js";
import type { ResizeOptions } from "../types/results.js";

export interface EncodeImageParams {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly format: ImageOutputFormat;
  readonly quality: Quality;
  readonly resize?: ResizeOptions | undefined;
  readonly autoRotate: boolean;
  readonly keepMetadata: boolean;
}

export interface EncodeImageResult {
  readonly bytes: number;
  readonly write: () => Promise<void>;
}

/**
 * Encode one image to a buffer, returning a deferred writer.
 *
 * Encoding to memory first is what makes "never write a file bigger than the
 * original" possible: the caller can compare sizes and simply drop the buffer.
 * Writing first and deleting afterwards would briefly leave a worse file on
 * disk, and would clobber the destination on a same-path re-encode.
 */
export async function encodeImage(
  params: EncodeImageParams,
): Promise<EncodeImageResult> {
  const { inputPath, outputPath, format, quality, resize } = params;
  const spec = imageFormatSpec(format);

  const inputExt = extname(inputPath).toLowerCase();
  // Read animated sources as full sequences so multi-frame GIF/WebP survive.
  // v1 always took frame one, silently flattening every animation it touched.
  const animated = spec.animated && (inputExt === ".gif" || inputExt === ".webp");

  let pipeline = sharp(inputPath, { animated, failOn: "error" });

  // Apply EXIF orientation. Without this, phone photos shot in portrait come
  // out sideways, because the orientation tag is stripped along with the rest
  // of the metadata but never baked into the pixels.
  if (params.autoRotate) pipeline = pipeline.rotate();

  if (resize?.maxWidth !== undefined || resize?.maxHeight !== undefined) {
    pipeline = pipeline.resize({
      width: resize.maxWidth,
      height: resize.maxHeight,
      fit: "inside",
      withoutEnlargement: resize.withoutEnlargement ?? true,
    });
  }

  if (params.keepMetadata) pipeline = pipeline.keepMetadata();

  pipeline = applyEncoder(pipeline, spec.encoder, quality);

  let buffer: Buffer;
  try {
    buffer = await pipeline.toBuffer();
  } catch (err) {
    throw new CompressorError(
      "ENCODE_FAILED",
      describeSharpError(err, inputPath),
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    bytes: buffer.byteLength,
    write: async () => {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, buffer);
    },
  };
}

/**
 * Dispatch to the right sharp encoder with defaults tuned per format.
 *
 * An explicit switch rather than `pipeline[spec.encoder](...)`: each encoder
 * takes a different options type, so indexed access would force the options
 * back to `any` and give up exactly the safety this module exists to provide.
 */
function applyEncoder(
  pipeline: Sharp,
  encoder: ReturnType<typeof imageFormatSpec>["encoder"],
  quality: Quality,
): Sharp {
  switch (encoder) {
    case "jpeg":
      // mozjpeg trades encode time for roughly 10% smaller files at equal quality.
      return pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
    case "png":
      // PNG ignores `quality` unless palette quantisation is on, which is where
      // essentially all of the savings on screenshots and flat graphics come from.
      return pipeline.png({ quality, compressionLevel: 9, palette: true });
    case "webp":
      return pipeline.webp({ quality, effort: 6 });
    case "avif":
      // effort 9 is dramatically slower for a fraction of a percent of size.
      return pipeline.avif({ quality, effort: 5 });
    case "tiff":
      return pipeline.tiff({ quality, compression: "jpeg" });
    case "gif":
      return pipeline.gif({ effort: 7 });
    case "jp2":
      return pipeline.jp2({ quality });
    case "heif":
      return pipeline.heif({ quality, compression: "hevc" });
    case "jxl":
      return pipeline.jxl({ quality });
    default:
      // Unreachable while the registry and SharpEncoder agree; if someone adds
      // an encoder to the union without handling it here, this stops compiling.
      return assertNever(encoder);
  }
}

function assertNever(value: never): never {
  throw new CompressorError(
    "UNSUPPORTED_FORMAT",
    `Unhandled image encoder: ${String(value)}`,
  );
}

function describeSharpError(err: unknown, inputPath: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  const ext = extname(inputPath).toLowerCase();
  if (isInputOnlyImageFormat(ext) && /unsupported image format/i.test(raw)) {
    return `Cannot read ${inputPath}: this build of sharp lacks ${ext} decode support.`;
  }
  if (/Input file is missing/i.test(raw)) {
    return `Cannot read ${inputPath}: file is missing or unreadable.`;
  }
  if (/unsupported image format|VipsForeignLoad/i.test(raw)) {
    return `Cannot decode ${inputPath}: unrecognised or corrupt image data.`;
  }
  return `Failed to encode ${inputPath}: ${raw}`;
}
