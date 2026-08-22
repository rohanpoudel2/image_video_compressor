import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { CompressorError } from "../core/errors.js";
import { withAtomicOutput } from "../core/atomic-output.js";
import { sniffFile } from "../core/sniff.js";
import { isInputOnlyImageFormat } from "../types/image-formats.js";
import {
  encodeOptionsFor,
  imageCapabilities,
  type ImageFormatCapability,
} from "./sharp-capabilities.js";
import type { Quality } from "../types/brand.js";
import type { ResizeOptions } from "../types/results.js";

export interface EncodeImageParams {
  readonly inputPath: string;
  readonly outputPath: string;
  /** Extension of the desired output, e.g. `.webp`. */
  readonly format: string;
  readonly quality: Quality;
  readonly resize?: ResizeOptions | undefined;
  readonly autoRotate: boolean;
  readonly keepMetadata: boolean;
}

export interface EncodeImageResult {
  readonly bytes: number;
  readonly write: () => Promise<void>;
}

/** Resolve an extension to a capability this build can actually write. */
export async function resolveImageTarget(
  extension: string,
): Promise<ImageFormatCapability> {
  const caps = await imageCapabilities();
  const capability = caps.writableByExtension.get(extension.toLowerCase());
  if (capability) return capability;

  const available = [...caps.writableByExtension.keys()].sort().join(" ");

  if (isInputOnlyImageFormat(extension)) {
    throw new CompressorError(
      "UNSUPPORTED_FORMAT",
      `${extension} can be read but not written — no encoder exists for it.\n` +
        `Writable formats in this build: ${available}`,
    );
  }

  throw new CompressorError(
    "UNSUPPORTED_FORMAT",
    `This sharp build cannot write ${extension}.\n` +
      `Writable formats: ${available}\n` +
      "Run `imgvidcompress formats` for the full capability list.",
  );
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
  const { inputPath, outputPath, quality, resize } = params;
  const capability = await resolveImageTarget(params.format);

  const inputExt = extname(inputPath).toLowerCase();
  // Read animated sources as full sequences so multi-frame GIF/WebP survive.
  // v1 always took frame one, silently flattening every animation it touched.
  const animated =
    capability.supportsAnimation && (inputExt === ".gif" || inputExt === ".webp");

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

  let buffer: Buffer;
  try {
    buffer = await pipeline
      .toFormat(capability.id, encodeOptionsFor(capability, quality))
      .toBuffer();
  } catch (err) {
    throw new CompressorError(
      "ENCODE_FAILED",
      await describeSharpError(err, inputPath),
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    bytes: buffer.byteLength,
    write: async () => {
      await withAtomicOutput(outputPath, async (temporaryPath) => {
        await writeFile(temporaryPath, buffer);
        return { value: undefined, replace: true };
      });
    },
  };
}

/**
 * Turn an encoder failure into something actionable.
 *
 * When decoding fails we sniff the file, because the most confusing version of
 * this error is a video or a PDF wearing an image extension — "unrecognised
 * image data" sends people hunting for corruption that is not there.
 */
async function describeSharpError(err: unknown, inputPath: string): Promise<string> {
  const raw = err instanceof Error ? err.message : String(err);
  const ext = extname(inputPath).toLowerCase();

  const decodeFailed =
    /unsupported image format|VipsForeignLoad|Input buffer contains unsupported/i.test(
      raw,
    );

  if (decodeFailed) {
    const actual = await sniffFile(inputPath);
    if (actual && actual.kind !== "image") {
      return `${inputPath} is named like an image but contains ${actual.format} ${actual.kind} data.`;
    }
    if (actual) {
      return `Cannot decode ${inputPath}: this build of sharp lacks ${actual.format} support.`;
    }
    if (isInputOnlyImageFormat(ext)) {
      return `Cannot read ${inputPath}: this build of sharp lacks ${ext} decode support.`;
    }
    return `Cannot decode ${inputPath}: unrecognised or corrupt image data.`;
  }

  if (/Input file is missing/i.test(raw)) {
    return `Cannot read ${inputPath}: file is missing or unreadable.`;
  }
  return `Failed to encode ${inputPath}: ${raw}`;
}
