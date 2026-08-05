# image-and-video-compressor

Compress images and videos from the command line or from Node. Parallel by default, honest about what it did, and safe to drive from a script.

```bash
npm install -g image-and-video-compressor
imgvidcompress ./photos
```

```
  imgvidcompress  compressing images and videos

  ✓ hero.jpg                        4.2 MB → 388 KB   −91.0%
  ✓ team-photo.jpg                  2.8 MB → 241 KB   −91.4%
  ✓ promo.mp4                      18.4 MB → 5.1 MB   −72.3%
  ○ icon.png                        skipped — compressing made it bigger, original kept

  ──────────────────────────────────────────────────────────
  Total   25.4 MB → 5.7 MB   −19.7 MB (77.6%)
  3 compressed · 1 skipped · 12.4s
```

## Why v2

v1 worked, but only on the happy path. v2 is a rewrite in TypeScript that fixes the things v1 got wrong and adds what a compressor should have had from the start.

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

Full detail in [MIGRATION.md](./MIGRATION.md).

## Install

```bash
npm install -g image-and-video-compressor
```

Requires **Node 20.11+**. Images work out of the box. Video needs `ffmpeg` on your `PATH`:

```bash
brew install ffmpeg                 # macOS
sudo apt install ffmpeg             # Debian/Ubuntu
winget install Gyan.FFmpeg          # Windows
```

Or point at an existing binary with `--ffmpeg-path` / `FFMPEG_PATH`.

## Usage

```bash
imgvidcompress <paths...> [options]     # auto-detects images and videos
imgvidcompress image <paths...>         # images only
imgvidcompress video <paths...>         # videos only
imgvidcompress formats                  # what this build supports
```

Paths can be files or directories, and your shell's globs work as usual.

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
```

### Options

| Option                                   | Description                                                 |
| ---------------------------------------- | ----------------------------------------------------------- |
| `-q, --quality <1-100>`                  | Higher is better looking. Default `75`                      |
| `-t, --to <format>`                      | Output format. Default `.webp` for images, `.mp4` for video |
| `-o, --out <dir>`                        | Output directory. Default `<source>/compressed`             |
| `-r, --recursive`                        | Descend into subdirectories                                 |
| `-c, --concurrency <n>`                  | Files at once. Defaults to a value based on CPU count       |
| `--max-width <px>` / `--max-height <px>` | Shrink to fit, never enlarge                                |
| `--overwrite`                            | Replace existing output files                               |
| `--dry-run`                              | Report the plan, write nothing                              |
| `--json`                                 | JSON report on stdout                                       |
| `--quiet` / `--no-color`                 | Quieten or decolour the output                              |
| `--no-skip-larger`                       | Write output even when it ends up bigger than the source    |

**Images:** `--keep-metadata`, `--no-auto-rotate`

**Video:** `--codec`, `--audio-codec`, `--fps`, `--preset`, `--ffmpeg-path`

### Formats

Images read `.jpg .jpeg .png .webp .avif .tiff .gif .svg .heic .heif`, and write everything except `.svg`, `.heic` and `.heif` — those decode but have no encoder.

Video containers, with the codecs each can legally carry:

| Container | Video                  | Audio       |
| --------- | ---------------------- | ----------- |
| `.mp4`    | H.264, H.265, AV1      | AAC         |
| `.mkv`    | H.264, H.265, AV1, VP9 | AAC, Opus   |
| `.mov`    | H.264, H.265           | AAC         |
| `.webm`   | VP9, AV1               | Opus        |
| `.avi`    | H.264                  | passthrough |

WebM genuinely cannot carry H.264 — that restriction is enforced by the compiler, not by a runtime check. Asking for an impossible pairing is a build error in library code and a clear message on the CLI.

## Programmatic API

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

`compressImages`, `compressVideos` and `compress` always resolve. Per-file problems appear as `status: "failed"` inside `results`; only setup errors (no inputs, a bad option) reject. Pass an `AbortSignal` to cancel.

Quality and pixel values go through `toQuality()` and `toPixels()`, which validate the range and return branded types. A raw `number` will not typecheck — that is what stops a 1-100 quality being fed to a flag that expects 0-51.

## Scripting and AI agents

`--json` writes exactly one JSON document to stdout. Every human-facing byte — banner, progress, summary — goes to stderr, so the stream is always safe to parse.

```bash
imgvidcompress ./assets --json | jq '.summary.savedBytes'
imgvidcompress ./assets --dry-run --json | jq '.results[].outputPath'
imgvidcompress formats --json | jq '.video.output'
```

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "dryRun": false,
  "summary": {
    "totalFiles": 3,
    "compressed": 3,
    "failed": 0,
    "savedBytes": 20658176,
    "savedRatio": 0.776,
  },
  "results": [
    {
      "status": "compressed",
      "inputPath": "…/hero.jpg",
      "outputPath": "…/compressed/hero.webp",
      "savedRatio": 0.91,
    },
  ],
}
```

Exit codes:

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | Everything succeeded                                        |
| `1`  | The run completed but some files failed                     |
| `2`  | Bad usage — unknown flag, invalid format, colliding outputs |
| `3`  | ffmpeg not found                                            |
| `4`  | No matching input files                                     |

Error codes in JSON (`FFMPEG_NOT_FOUND`, `ENCODE_FAILED`, `UNSUPPORTED_FORMAT`, …) are stable across releases; the human-readable messages are not. Branch on the code.

`imgvidcompress formats --json` reports this build's actual capabilities, including which codecs each container accepts, so a caller can discover the constraints instead of hardcoding them.

## Deprecated v1 commands

The v1 commands still work and still write to `optimised_images/` and `optimised_videos/`. They print a deprecation notice and will be removed in v3.

```bash
# Still works — prints a notice
imgvidcompress optimise:image --loadFolder='./photos' --quality=40 --output='.webp'

# The v2 equivalent
imgvidcompress image ./photos --quality 40 --to .webp
```

Nothing you have scripted needs to change today. They run on the v2 pipeline, so they pick up every fix above while keeping v1's output layout and defaults.

## Development

```bash
npm install
npm run build
npm test              # builds, then runs the suite
npm run typecheck     # also enforces the compile-time guarantees
npm run lint
```

Video end-to-end tests skip themselves when ffmpeg is missing; the codec matrix and quality mapping are pure functions and always run. `npm run typecheck` is a real test here — `test/types.test.ts` uses `@ts-expect-error` to assert that invalid container/codec pairings and unbranded quality values still fail to compile.

## Credits

Built on [sharp](https://sharp.pixelplumbing.com/) and [ffmpeg](https://ffmpeg.org/).

## License

MIT © Rohan Poudel
