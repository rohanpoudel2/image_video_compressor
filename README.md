<div align="center">

# image-and-video-compressor

**Compress images and videos from the command line or from Node.**
Parallel by default, honest about what it did, and safe to drive from a script.

[![npm version](https://img.shields.io/npm/v/image-and-video-compressor?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/image-and-video-compressor)
[![npm downloads](https://img.shields.io/npm/dm/image-and-video-compressor?color=cb3837)](https://www.npmjs.com/package/image-and-video-compressor)
[![CI](https://github.com/rohanpoudel2/image_video_compressor/actions/workflows/ci.yml/badge.svg)](https://github.com/rohanpoudel2/image_video_compressor/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/image-and-video-compressor?logo=node.js&logoColor=white)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/image-and-video-compressor?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![license](https://img.shields.io/npm/l/image-and-video-compressor)](./LICENSE)

</div>

---

```bash
npx image-and-video-compressor ./photos
```

That is the whole quick start. No install, no config file, no flags.

```
  imgvidcompress  compressing images and videos

  ✓ graphic-flat.png                   976 KB → 64 KB  −93.5%
  ✓ hero-huge.jpg                      330 KB → 148 KB  −55.3%
  ✓ portrait-tall.jpg                  55 KB → 20 KB  −62.9%
  ✓ clip-1080p-30fps.mp4               4.3 MB → 2.4 MB  −44.9%
  ✓ clip-720p-60fps.mp4                4.4 MB → 2.0 MB  −55.0%
  ○ clip-480p-24fps.mov                skipped — compressing made it bigger, original kept

  ──────────────────────────────────────────────────────────
  Total   14 MB → 7.1 MB   −7.4 MB (51.1%)
  15 compressed · 1 skipped · 1.2s
```

<sub>Real output from `npm run samples && imgvidcompress samples --recursive`. Your numbers will differ; these are the project's own test fixtures.</sub>

## What you get

- **One command for both.** Images and videos in the same run, detected by extension and, where that is not enough, by content.
- **Parallel, but bounded.** A worker pool sized to your CPU count, not one process per file.
- **It never lies about the result.** If compressing made a file bigger, the original is kept and the file is reported as skipped.
- **Safe in a pipeline.** `--json` puts exactly one document on stdout and every human-facing byte on stderr. Distinct exit codes, stable error codes.
- **A real library.** Typed ESM and CJS exports, `AbortSignal` support, progress events. Importing it does not run the CLI.
- **Honest about your machine.** `formats` reports what your sharp and ffmpeg builds can actually do, verified by encoding, not by a hardcoded list.

## Contents

- [Install](#install)
- [CLI](#cli)
  - [Commands](#commands)
  - [Options](#options)
  - [Examples](#examples)
- [Formats](#formats)
- [File detection](#file-detection)
- [Node API](#node-api)
  - [Functions](#functions)
  - [Options reference](#options-reference)
  - [Results](#results)
  - [Progress and cancellation](#progress-and-cancellation)
  - [Branded types](#branded-types)
- [Automation and AI agents](#automation-and-ai-agents)
  - [The `--json` contract](#the---json-contract)
  - [Exit codes](#exit-codes)
  - [Error codes](#error-codes)
- [Recipes](#recipes)
- [FAQ](#faq)
- [Coming from v1](#coming-from-v1)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install -g image-and-video-compressor    # CLI everywhere
npm install image-and-video-compressor       # as a dependency
npx image-and-video-compressor ./photos      # no install at all
```

Requires **Node 20.11 or newer**.

Images work out of the box — [sharp](https://sharp.pixelplumbing.com/) ships prebuilt binaries. Video needs `ffmpeg` on your `PATH`:

```bash
brew install ffmpeg                 # macOS
sudo apt install ffmpeg             # Debian/Ubuntu
winget install Gyan.FFmpeg          # Windows
```

Or point at a binary you already have with `--ffmpeg-path` or the `FFMPEG_PATH` environment variable. Without ffmpeg the image half still works; only video is unavailable, and the error says so.

## CLI

```bash
imgvidcompress <paths...> [options]     # auto-detects images and videos
imgvidcompress image <paths...>         # images only
imgvidcompress video <paths...>         # videos only
imgvidcompress formats                  # what this build supports
```

Paths can be files or directories, and your shell's globs work as usual. Output goes to `<source>/compressed` unless you say otherwise, and a recursive run mirrors the input directory structure.

### Commands

| Command                | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `imgvidcompress <paths...>` | Compress every image and video found. The default command.    |
| `imgvidcompress image <paths...>` | Images only. Ignores video files entirely.              |
| `imgvidcompress video <paths...>` | Videos only.                                            |
| `imgvidcompress formats`   | Print this machine's real capabilities. Add `--json` for a machine-readable version. |
| `imgvidcompress --help`    | Full usage, including per-command help such as `image --help`. |

### Options

Shared by `run`, `image` and `video`:

| Option                          | Default                | Description                                                    |
| ------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `-q, --quality <1-100>`         | `75`                   | Higher is better looking. Mapped onto each codec's own scale.  |
| `-t, --to <format>`             | `.webp` / `.mp4`       | Output format. Run `formats` to see what is available.<sup>†</sup> |
| `-o, --out <dir>`               | `<source>/compressed`  | Output directory. Structure is mirrored under it.              |
| `-r, --recursive`               | off                    | Descend into subdirectories.                                   |
| `-c, --concurrency <n>`         | see below              | Files processed at once.                                       |
| `--max-width <px>`              | —                      | Shrink anything wider. Never enlarges.                         |
| `--max-height <px>`             | —                      | Shrink anything taller. Never enlarges.                        |
| `--overwrite`                   | off                    | Replace existing output files instead of skipping them.        |
| `--dry-run`                     | off                    | Report the plan, write nothing.                                |
| `--json`                        | off                    | One JSON document on stdout; human output moves to stderr.     |
| `--quiet`                       | off                    | Suppress all non-error output.                                 |
| `--no-color`                    | —                      | Disable coloured output.                                       |
| `--no-skip-larger`              | —                      | Write the output even when it ends up bigger than the source.  |

<sup>†</sup> Images default to WebP, except that a source already in a modern format keeps it — an `.avif` input stays AVIF and a `.webp` input stays WebP rather than being pointlessly transcoded. Videos default to `.mp4`.

Concurrency defaults differ by media kind, because the two libraries behave differently: images get `min(cores, 8)` since sharp parallelises internally through libvips, videos get `cores / 4` since a single ffmpeg process already saturates several cores. Stacking more mostly buys contention.

**Image options**

| Option              | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `--keep-metadata`   | off     | Preserve EXIF and ICC instead of stripping it.       |
| `--no-auto-rotate`  | —       | Do not apply EXIF orientation.                       |

**Video options**

| Option                 | Default            | Description                                                 |
| ---------------------- | ------------------ | ----------------------------------------------------------- |
| `--codec <name>`       | per container      | `libx264`, `libx265`, `libvpx-vp9`, `libvpx`, `libsvtav1`, `libaom-av1`, `mpeg4`, `libtheora`. Must be legal for the container. |
| `--audio-codec <name>` | per container      | `aac`, `libopus`, or `copy` to pass the original track through. |
| `--fps <n>`            | source rate        | Cap the frame rate. Left alone by default.                  |
| `--preset <name>`      | per codec          | Encoder speed/efficiency tradeoff. Codec-specific.          |
| `--ffmpeg-path <path>` | `$FFMPEG_PATH`, then `PATH` | Path to the ffmpeg binary.                     |

### Examples

```bash
# Everything in a folder, into ./photos/compressed
imgvidcompress ./photos

# Convert to AVIF, cap the width, write somewhere specific
imgvidcompress ./photos --to .avif --quality 60 --max-width 2000 --out ./dist

# Walk a whole tree; the directory structure is mirrored in the output
imgvidcompress image ./src/assets --recursive --out ./dist/assets

# Individual files
imgvidcompress hero.png banner.jpg

# See the plan without touching anything
imgvidcompress ./assets --dry-run

# Web-ready video: VP9 in WebM, keeping the source frame rate
imgvidcompress video ./clips --to .webm --quality 55

# Re-run over a folder you have already processed
imgvidcompress ./photos --overwrite
```

## Formats

Support is bounded by what your sharp and ffmpeg builds can actually do, not by a list in this README. Both are build-dependent, so ask the tool:

```bash
imgvidcompress formats          # human-readable
imgvidcompress formats --json   # machine-readable
```

**Images.** The writable set is established at startup by encoding a single pixel with each candidate, which is the only check that cannot be wrong: `sharp.format` claims support for formats that then fail at encode time. JPEG 2000, JPEG XL and HEIC are all commonly missing, and a stock macOS build has none of the three. Reads cover everything libvips decodes, which is a strictly wider set than writes — SVG, PDF, and camera raw (`.arw`, `.cr2`, `.nef`, `.dng`, and friends) come in but never go out.

**Videos.** Two tiers. Curated containers get a verified codec matrix and tuned per-codec flags:

| Container | Video                       | Audio                        |
| --------- | --------------------------- | ---------------------------- |
| `.mp4`    | H.264, H.265, AV1           | AAC, MP3, FLAC               |
| `.mkv`    | H.264, H.265, AV1, VP9, VP8 | AAC, Opus, MP3, Vorbis, FLAC |
| `.mov`    | H.264, H.265                | AAC                          |
| `.webm`   | VP9, AV1, VP8               | Opus, Vorbis                 |
| `.avi`    | H.264, MPEG-4               | MP3                          |
| `.ogv`    | Theora                      | Vorbis, Opus                 |

Beyond those, **any muxer your ffmpeg reports is a valid `--to`**. A stock Homebrew build carries 184 of them, with around 100 video encoders available to `--codec`. For an uncurated container the muxer's own defaults apply, which are muxable by construction.

WebM genuinely cannot carry H.264. For curated containers that restriction is enforced by the compiler rather than by a runtime check: an impossible pairing is a build error in library code and a clear message on the CLI.

Quality maps onto each codec's own scale and direction — CRF counts down, Theora's `-q:v` counts up, MPEG-4 uses qscale — so `--quality 70` means the same thing regardless of codec.

Streams that the target container cannot carry are reported rather than dropped in silence. Losing a commentary track or a subtitle without a word is worse than refusing outright, because nobody notices until they need it.

## File detection

Extension first, since it is free and almost always right. Content sniffing takes over where a name genuinely cannot answer: a file with no extension, an unknown one, or an ISO container where only the brand bytes distinguish an AVIF image from an MP4 video.

A merely mislabelled file needs no special handling, because sharp and ffmpeg both detect their input's real format. When a decode does fail, the file is sniffed so the error can say "this .jpg is actually an MP4" instead of "unrecognised data".

## Node API

```ts
import { compressImages, toQuality, toPixels } from "image-and-video-compressor";

const report = await compressImages(["./photos"], {
  quality: toQuality(80),
  to: ".avif",
  resize: { maxWidth: toPixels(2000) },
  recursive: true,
  onProgress: (event) => {
    if (event.type === "job-done") console.log(event.job.inputPath);
  },
});

console.log(`Saved ${report.summary.savedBytes} bytes`);

for (const result of report.results) {
  if (result.status === "failed") console.error(result.inputPath, result.error.code);
}
```

Ships as ESM and CommonJS with bundled type declarations. `require()` and `import` both work.

### Functions

| Function | Signature |
| -------- | --------- |
| `compress` | `(paths: string[], options?: CompressOptions) => Promise<CompressionReport>` — images and videos, auto-detected |
| `compressImages` | `(paths: string[], options?: ImageOptions) => Promise<CompressionReport>` |
| `compressVideos` | `(paths: string[], options?: VideoOptions) => Promise<CompressionReport>` |
| `discoverFiles` | Walk paths and classify what is there, without compressing |
| `imageCapabilities` | What this sharp build can genuinely read and write |
| `ffmpegCapabilities` | Muxers, demuxers and encoders this ffmpeg reports |
| `resolveFfmpeg` | Locate the ffmpeg binary and its version |
| `probeMedia` | ffprobe a file into typed stream information |
| `sniff` / `sniffFile` | Identify a file by content rather than name |
| `toQuality` / `toPixels` | Validating constructors for the branded scalar types |

The three compression functions **always resolve**. Per-file problems appear as `status: "failed"` inside `results`; only setup errors — no inputs, a bad option, ffmpeg missing — reject with a `CompressorError`.

Format registries (`VIDEO_CONTAINERS`, `VIDEO_CODECS`, `AUDIO_CODECS`, `CURATED_IMAGE_FORMATS`) and the codec-matrix predicates (`isCodecAllowedIn`, `isVideoContainer`, `qualityToCrf`, …) are exported too, so a caller can validate a combination before running one.

### Options reference

Shared by every entry point:

| Option        | Type                            | Default               |
| ------------- | ------------------------------- | --------------------- |
| `quality`     | `Quality`                       | `75`                  |
| `outDir`      | `string`                        | `<source>/compressed` |
| `recursive`   | `boolean`                       | `false`               |
| `concurrency` | `number`                        | per media kind        |
| `overwrite`   | `boolean`                       | `false`               |
| `dryRun`      | `boolean`                       | `false`               |
| `skipLarger`  | `boolean`                       | `true`                |
| `resize`      | `ResizeOptions`                 | —                     |
| `signal`      | `AbortSignal`                   | —                     |
| `onProgress`  | `(event: ProgressEvent) => void` | —                    |

`ImageOptions` adds `to`, `autoRotate` (default `true`) and `keepMetadata` (default `false`).
`VideoOptions` adds `to`, `videoCodec`, `audioCodec`, `fps`, `preset` and `ffmpegPath`.
`CompressOptions` is the union used by `compress()`, where `to` widens to accept either kind.

### Results

Every file produces one entry in a discriminated union, so a run always yields a complete record of what happened:

```ts
type JobResult =
  | { status: "compressed"; inputPath; outputPath; inputBytes; outputBytes;
      savedBytes; savedRatio; durationMs; warnings? }
  | { status: "skipped";    inputPath; outputPath; inputBytes; reason; warnings? }
  | { status: "failed";     inputPath; outputPath; error: { code; message; detail? } };
```

`isCompressed`, `isSkipped` and `isFailed` are exported as type guards, so consumers never hand-check `status`:

```ts
import { isFailed, isCompressed } from "image-and-video-compressor";

const failures = report.results.filter(isFailed);
const bytes = report.results.filter(isCompressed)
  .reduce((sum, r) => sum + r.savedBytes, 0);
```

`reason` on a skip is one of `output-larger-than-input`, `output-exists` or `dry-run`.

### Progress and cancellation

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

await compress(["./assets"], {
  signal: controller.signal,
  onProgress: (event) => {
    switch (event.type) {
      case "run-start":    console.log(`${event.total} files`); break;
      case "job-start":    break;
      case "job-progress": console.log(event.job.inputPath, event.ratio); break;
      case "job-done":     console.log(event.result.status); break;
    }
  },
});
```

`run-start` arrives once, after discovery and planning, because the total is not knowable before then. `job-progress` carries a 0-1 ratio and is video-only; images complete atomically.

### Branded types

Quality and pixel values go through `toQuality()` and `toPixels()`, which validate the range and return branded types. A raw `number` will not typecheck:

```ts
compressImages(["./photos"], { quality: 80 });            // ✗ compile error
compressImages(["./photos"], { quality: toQuality(80) }); // ✓
```

This is what stops a 1-100 quality value being fed to a flag that expects a 0-51 CRF. `toQuality(150)` throws a `RangeValidationError` at the boundary rather than producing a quietly wrong encode. The project's own `npm run typecheck` asserts these failures with `@ts-expect-error`.

## Automation and AI agents

The tool is built to be driven by something that is not a person: a build script, a CI job, or a coding agent.

### The `--json` contract

`--json` writes exactly one JSON document to stdout. Every human-facing byte — banner, progress, summary, warnings — goes to stderr, so the stream is always safe to parse.

```bash
imgvidcompress ./assets --json | jq '.summary.savedBytes'
imgvidcompress ./assets --dry-run --json | jq -r '.results[].outputPath'
imgvidcompress formats --json | jq '.video.curated[].extension'
```

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "dryRun": false,
  "summary": {
    "totalFiles": 2,
    "compressed": 2,
    "skipped": 0,
    "failed": 0,
    "inputBytes": 64931,
    "outputBytes": 33106,
    "savedBytes": 31825,
    "savedRatio": 0.4901,
    "durationMs": 55,
  },
  "results": [
    {
      "status": "compressed",
      "kind": "image",
      "inputPath": "…/photo-medium.jpg",
      "outputPath": "…/compressed/photo-medium.webp",
      "inputBytes": 44331,
      "outputBytes": 17902,
      "savedBytes": 26429,
      "savedRatio": 0.5962,
      "durationMs": 46,
    },
  ],
}
```

`schemaVersion` is bumped on any breaking change to these shapes, so a consumer can pin behaviour instead of guessing whether a field still means what it did last release. Errors use the same envelope with `ok: false` and an `error` object.

`imgvidcompress formats --json` reports the installation's actual capabilities, including which codecs each container accepts. A caller can discover the constraints instead of hardcoding assumptions that are wrong on some machines.

### Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | Everything succeeded                                       |
| `1`  | The run completed but some files failed                    |
| `2`  | Bad usage — unknown flag, invalid format, colliding outputs |
| `3`  | ffmpeg not found                                           |
| `4`  | No matching input files                                    |

### Error codes

`FFMPEG_NOT_FOUND`, `FFMPEG_FAILED`, `DECODE_FAILED`, `ENCODE_FAILED`, `UNSUPPORTED_FORMAT`, `INPUT_NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_OPTION`, `NO_INPUT_FILES`, `ABORTED`, `UNKNOWN`.

These are stable across releases. The human-readable messages are not — branch on the code.

## Recipes

**Compress assets as part of a build**

```json
{
  "scripts": {
    "build:assets": "imgvidcompress image ./src/assets --recursive --to .webp --out ./dist/assets"
  }
}
```

**Fail CI when an asset is too big to ship**

```bash
imgvidcompress ./public/img --dry-run --json \
  | jq -e '[.results[].inputBytes] | max < 500000' \
  || { echo "An image exceeds 500 KB"; exit 1; }
```

**Report the saving without writing anything**

```bash
imgvidcompress ./assets --dry-run --json | jq '.summary'
```

**Use it from a build script**

```ts
import { compressImages, toQuality, isFailed } from "image-and-video-compressor";

const report = await compressImages(["./src/assets"], {
  quality: toQuality(82),
  to: ".webp",
  recursive: true,
  outDir: "./dist/assets",
});

const failed = report.results.filter(isFailed);
if (failed.length > 0) process.exit(1);
```

**Check what the machine supports before offering a format**

```ts
import { imageCapabilities } from "image-and-video-compressor";

const caps = await imageCapabilities();
const canAvif = caps.writable.some((f) => f.extensions.includes(".avif"));
```

## FAQ

**A file came out bigger. Why is it in the output as "skipped"?**
Because the original was kept. Some inputs — small PNGs, already-optimised WebP, low-detail graphics — do not get smaller when re-encoded. Rather than write a worse file, the tool keeps the original and tells you. Pass `--no-skip-larger` if you want the bigger output anyway, usually because you need the format conversion more than the bytes.

**Where did my files go?**
`<source>/compressed`, next to the input. Use `--out` to choose. A recursive run mirrors the input tree under the output directory rather than flattening it.

**Does it overwrite my originals?**
Never. Output always goes to a separate directory, and an existing output file is skipped unless you pass `--overwrite`.

**`FFMPEG_NOT_FOUND`, but ffmpeg is installed.**
It is not on the `PATH` this process sees, which is common with GUI-launched editors and some CI images. Pass `--ffmpeg-path /full/path/to/ffmpeg`, or set `FFMPEG_PATH` (and `FFPROBE_PATH`, which is derived from it by default). Confirm with `imgvidcompress formats`, which prints the resolved ffmpeg version; `formats --json` carries the full path in `video.ffmpeg`.

**`--to .webm` rejected my `--codec libx264`.**
WebM cannot carry H.264. Use `libvpx-vp9` or `libsvtav1`, or target `.mp4` instead. `imgvidcompress formats` lists the legal codecs per container for your build.

**Why is `.avif` or `.jxl` missing from `formats`?**
Your sharp build was compiled without it. The list is produced by actually encoding a pixel with each candidate, so it reflects the binary you have rather than what the package hopes is there.

**Can I compress in place?**
Not directly, and deliberately so. Write to a directory, verify, then move. A crash mid-encode over the original is not recoverable.

**Is quality 75 the same for JPEG and for H.265?**
Yes, in the sense that matters: the value is mapped onto each codec's own scale and direction. You do not need to remember that CRF counts down while Theora counts up.

**Does it work when output is piped or redirected?**
Yes. The progress display degrades to plain append-only lines when stdout is not a TTY, which is also the nicer CI log. (v1 crashed here; see below.)

## Coming from v1

**Nothing you have scripted breaks today.** The v1 commands still work, still write to `optimised_images/` and `optimised_videos/`, and still take the same flags. They print a deprecation notice and will be removed in v3.

```bash
# Still works — prints a notice
imgvidcompress optimise:image --loadFolder='./photos' --quality=40 --output='.webp'

# The v2 equivalent
imgvidcompress image ./photos --quality 40 --to .webp
```

They run on the v2 pipeline, so they pick up every fix below while keeping v1's output layout and defaults.

|                              | v1                                                     | v2                                 |
| ---------------------------- | ------------------------------------------------------ | ---------------------------------- |
| Output piped to a file or CI | **crashed** (`clearLine is not a function`)            | works                              |
| `--output=.webm`             | produced an unplayable file (H.264 in WebM)            | VP9/Opus, or AV1                   |
| Video quality                | `crf = 100 - quality`, often outside the codec's range | mapped onto each codec's own scale |
| Frame rate                   | forced to 30fps, wrecking 24fps and 60fps sources      | preserved unless you ask           |
| 500 files                    | 500 simultaneous processes                             | bounded worker pool                |
| One corrupt file             | killed the whole batch                                 | reported, batch continues          |
| Bytes saved                  | never shown                                            | per file and in total              |
| Use from a script            | `require()` ran the CLI                                | real library with types            |

Full detail, including the exact command mapping and changed defaults, is in [MIGRATION.md](./MIGRATION.md).

## Contributing

Issues and pull requests are welcome at [rohanpoudel2/image_video_compressor](https://github.com/rohanpoudel2/image_video_compressor).

```bash
npm install
npm run build
npm test              # builds, then runs the suite
npm run typecheck     # also enforces the compile-time guarantees
npm run lint
npm run format:check
```

**Trying it locally**

```bash
npm run samples       # downloads/generates ~14MB of test media into samples/
npm run build

node dist/cli.js samples --dry-run        # see the plan
node dist/cli.js image samples/images     # real photos
node dist/cli.js video samples/videos     # generated clips
```

`samples/` is gitignored: photos come from Lorem Picsum (Unsplash-licensed) and videos are generated by ffmpeg's synthetic sources, so both are reproducible rather than committed.

**How the suite is structured.** Video end-to-end tests skip themselves when ffmpeg is missing; the codec matrix, quality mapping and output parsers are pure functions and always run. `npm run typecheck` is a real test here — `test/types.test.ts` uses `@ts-expect-error` to assert that invalid container/codec pairings and unbranded quality values still fail to compile. Capability tests assert that what the tool _claims_ to support matches what the local binaries actually do, so a build missing JPEG XL or HEVC is described accurately rather than optimistically.

CI runs on Node 20, 22 and 24 across Linux, macOS and Windows, with ffmpeg installed on each, and verifies the published tarball imports cleanly from both ESM and CommonJS.

## Credits

Built on [sharp](https://sharp.pixelplumbing.com/) and [ffmpeg](https://ffmpeg.org/).

## License

MIT © [Rohan Poudel](https://github.com/rohanpoudel2)
