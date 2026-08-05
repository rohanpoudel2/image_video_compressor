import sharp from "sharp";

/**
 * What *this* sharp build can actually do.
 *
 * A hardcoded format list is always a guess about someone else's machine.
 * sharp is compiled against libvips with an optional set of codecs, so support
 * genuinely differs per install: this package previously advertised `.jp2`,
 * `.jxl` and `.heif` as writable, and none of the three work on a stock macOS
 * build. HEIC is usually absent because HEVC is patent-encumbered.
 *
 * The table is therefore derived at runtime: declared capability from
 * `sharp.format` for reads, and an actual one-pixel encode for writes, which is
 * the only answer that cannot be wrong. `sharp.format[id].output.file` claims
 * support for formats that then fail at encode time, so the flag alone is not
 * trustworthy.
 *
 * The probe must be async: JP2 rejects synchronously from `toFormat()`, while
 * JXL and HEIC only fail once the encode runs. It costs single-digit
 * milliseconds and is cached for the process.
 */

/** Format ids `sharp.toFormat()` accepts. `.heic` is written by the heif encoder. */
export type SharpFormatId =
  "jpeg" | "png" | "webp" | "avif" | "tiff" | "gif" | "heif" | "jp2" | "jxl";

interface Candidate {
  readonly id: SharpFormatId;
  readonly extensions: readonly string[];
  readonly label: string;
  /**
   * Encoder settings applied on every write.
   *
   * Kept beside the capability rather than in a separate tuning table so a
   * format cannot be declared supported in one place and left untuned in
   * another. These are also the options the probe uses, so what is tested is
   * exactly what runs.
   */
  readonly options: Record<string, unknown>;
  readonly supportsQuality?: boolean;
  readonly supportsAnimation?: boolean;
}

/**
 * Candidate output formats.
 *
 * `sharp.format[id].input.fileSuffix` covers reads but is incomplete for
 * writes — the `heif` entry lists only `.avif`, and JPEG 2000's four spellings
 * appear nowhere — so extensions are declared here.
 */
const CANDIDATES: readonly Candidate[] = [
  {
    id: "jpeg",
    extensions: [".jpg", ".jpeg", ".jpe", ".jfif"],
    label: "JPEG",
    // mozjpeg trades encode time for roughly 10% smaller files at equal quality.
    options: { mozjpeg: true, progressive: true },
  },
  {
    id: "png",
    extensions: [".png"],
    label: "PNG",
    // PNG ignores `quality` unless palette quantisation is on, which is where
    // essentially all of the savings on screenshots and flat graphics come from.
    options: { compressionLevel: 9, palette: true },
  },
  {
    id: "webp",
    extensions: [".webp"],
    label: "WebP",
    options: { effort: 6 },
    supportsAnimation: true,
  },
  {
    id: "avif",
    extensions: [".avif"],
    label: "AVIF",
    // effort 9 is dramatically slower for a fraction of a percent of size.
    options: { effort: 5 },
  },
  {
    id: "tiff",
    extensions: [".tif", ".tiff"],
    label: "TIFF",
    options: { compression: "jpeg" },
  },
  {
    id: "gif",
    extensions: [".gif"],
    label: "GIF",
    options: { effort: 7 },
    supportsQuality: false,
    supportsAnimation: true,
  },
  {
    id: "heif",
    extensions: [".heic", ".heif"],
    label: "HEIC / HEIF",
    // Probed and written with HEVC specifically, because that is what a `.heic`
    // file means. Using AV1 here would succeed and then produce an AVIF payload
    // wearing a HEIC extension.
    options: { compression: "hevc" },
  },
  {
    id: "jp2",
    extensions: [".jp2", ".jpx", ".j2k", ".j2c"],
    label: "JPEG 2000",
    options: {},
  },
  { id: "jxl", extensions: [".jxl"], label: "JPEG XL", options: {} },
];

export interface ImageFormatCapability {
  readonly id: SharpFormatId;
  readonly extensions: readonly string[];
  readonly primaryExtension: string;
  readonly label: string;
  readonly options: Record<string, unknown>;
  readonly supportsQuality: boolean;
  readonly supportsAnimation: boolean;
}

export interface ImageCapabilities {
  readonly writable: readonly ImageFormatCapability[];
  /** Lowercased extension -> the format that writes it. */
  readonly writableByExtension: ReadonlyMap<string, ImageFormatCapability>;
  /** Every extension sharp can decode, including write-incapable ones like SVG. */
  readonly readableExtensions: ReadonlySet<string>;
}

let cached: Promise<ImageCapabilities> | null = null;

/** Discard the memoised probe. Intended for tests. */
export function resetImageCapabilities(): void {
  cached = null;
}

export function imageCapabilities(): Promise<ImageCapabilities> {
  cached ??= detect();
  return cached;
}

/** The exact options used to write (and to probe) a given format. */
export function encodeOptionsFor(
  capability: ImageFormatCapability,
  quality: number,
): Record<string, unknown> {
  return {
    ...(capability.supportsQuality ? { quality } : {}),
    ...capability.options,
  };
}

async function detect(): Promise<ImageCapabilities> {
  const probes = await Promise.all(
    CANDIDATES.map(async (candidate) => ({
      candidate,
      ok: await canEncode(candidate),
    })),
  );

  const writable: ImageFormatCapability[] = [];
  const writableByExtension = new Map<string, ImageFormatCapability>();

  for (const { candidate, ok } of probes) {
    if (!ok) continue;

    const capability: ImageFormatCapability = {
      id: candidate.id,
      extensions: candidate.extensions,
      primaryExtension: candidate.extensions[0] ?? `.${candidate.id}`,
      label: candidate.label,
      options: candidate.options,
      supportsQuality: candidate.supportsQuality ?? true,
      supportsAnimation: candidate.supportsAnimation ?? false,
    };

    writable.push(capability);
    for (const ext of candidate.extensions) {
      // First writer wins, so `.tif` resolves to tiff rather than a later alias.
      if (!writableByExtension.has(ext)) writableByExtension.set(ext, capability);
    }
  }

  return {
    writable,
    writableByExtension,
    readableExtensions: collectReadableExtensions(writable),
  };
}

/** Encode a single pixel to find out whether the codec is really present. */
async function canEncode(candidate: Candidate): Promise<boolean> {
  try {
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#000" },
    })
      .toFormat(candidate.id, { quality: 50, ...candidate.options })
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}

function collectReadableExtensions(
  writable: readonly ImageFormatCapability[],
): ReadonlySet<string> {
  const extensions = new Set<string>();

  // sharp types `format` as an enum of named members, so iterating its values
  // generically lands on `any`. Narrow it to the shape actually being read.
  const table = sharp.format as unknown as Record<
    string,
    { input?: { file?: boolean; fileSuffix?: readonly string[] } } | undefined
  >;

  for (const entry of Object.values(table)) {
    if (!entry?.input?.file) continue;
    for (const suffix of entry.input.fileSuffix ?? []) {
      extensions.add(suffix.toLowerCase());
    }
  }

  // Anything writable is by definition also readable.
  for (const capability of writable) {
    for (const ext of capability.extensions) extensions.add(ext);
  }

  // libvips decodes these regardless of whether it can encode them, and does
  // not list every spelling in fileSuffix. Decoding HEIC is routinely available
  // on builds that cannot encode it.
  for (const ext of [".heic", ".heif", ".avif", ".jfif", ".jpe", ".tif", ".svg"]) {
    extensions.add(ext);
  }

  return extensions;
}
