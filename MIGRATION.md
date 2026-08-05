# Migrating from v1 to v2

**Nothing you have scripted breaks today.** The v1 commands still work, still write to the same folders, and still take the same flags. They print a deprecation notice and will be removed in v3.

```bash
# Still works
imgvidcompress optimise:image --loadFolder='./photos' --quality=40 --output='.webp'
```

## Command mapping

| v1                                                         | v2                                              |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `optimise:image --loadFolder=X --quality=Q --output=.webp` | `imgvidcompress image X --quality Q --to .webp` |
| `optimise:video --loadFolder=X --quality=Q --output=.mp4`  | `imgvidcompress video X --quality Q --to .mp4`  |
| _(not possible)_                                           | `imgvidcompress X` — both kinds, auto-detected  |

Differences worth knowing when you do move over:

- **Output directory.** v1 wrote to `<loadFolder>/optimised_images`. v2 writes to `<source>/compressed`, or wherever `--out` points. The deprecated commands keep the old location.
- **Default quality.** v1 defaulted to `20`; v2 defaults to `75`. The deprecated commands keep `20`.
- **Quality range.** v1 accepted 10-100. v2 accepts 1-100. The deprecated commands keep the 10-100 check.

## What changed, and why it matters

### Crashes

- **Piped output no longer dies.** v1 called `process.stdout.clearLine()` unconditionally. That method only exists on a TTY, so `imgvidcompress ... | tee log.txt`, any CI job, and any redirect to a file crashed with `TypeError: process.stdout.clearLine is not a function`. v2 checks before touching the cursor and falls back to plain append-only lines.
- **A bare invocation prints usage** instead of `TypeError: Cannot read properties of undefined (reading 'replace')`.
- **A missing input path no longer creates a directory.** v1 called `mkdirSync` on the path you got wrong, then rejected without returning, so `fs.readdir` ran on an already-rejected promise.
- **`--output=.svg` is rejected up front.** v1 listed `.svg` as a valid output and mapped it to `sharp.svg()`, a method that has never existed. sharp can read SVG but cannot write it; v2 models the input and output sets separately.

### Video correctness

- **Quality maps onto each codec's real CRF range.** v1 computed `crf = 100 - quality`. x264 accepts 0-51, so `--quality=10` asked for CRF 90 — outside the range entirely — and `--quality=100` asked for CRF 0, which is mathematically lossless and reliably _larger_ than the source. VP9 and AV1 run to 63, so one shared formula could never have been right for all of them.
- **WebM output actually plays.** v1 hardcoded `libx264` for every container. WebM carries only VP8/VP9/AV1, so ffmpeg refused to mux and every `.webm` run failed. v2 picks VP9 + Opus for WebM, and the container/codec matrix is enforced at compile time in library code.
- **Frame rate is preserved.** v1 hardcoded `.fps(30)`, which judders 24fps film and throws away half of 60fps footage. v2 only resamples when you pass `--fps`.
- **Audio is handled explicitly**, with a codec the container can legally carry.
- **MP4 gets `+faststart`**, so playback can begin before the file finishes downloading.

### Scale and resilience

- **Concurrency is bounded.** v1 ran `Promise.all` over every file, so a folder of 500 videos spawned 500 simultaneous ffmpeg processes. v2 uses a worker pool sized from the CPU count, with a lower default for video since ffmpeg already saturates cores on its own.
- **One bad file no longer kills the batch.** v1's `Promise.all` rejected on the first error and abandoned the rest with no record of what had already succeeded. v2 reports each file's outcome and always produces a complete report.
- **Re-runs do not re-compress their own output.** The default destination sits inside the source tree, so a recursive second pass would otherwise re-encode the first pass's output and lose a generation each time.

### New in v2

- Bytes saved, per file and in total — the one number a compressor exists to produce.
- `--max-width` / `--max-height`, usually a far bigger win than any quality setting.
- EXIF auto-rotate, so portrait photos stop coming out sideways.
- Skip-if-larger: when compression makes a file bigger, the original is kept and the run says so.
- `--recursive`, individual file arguments, and multiple paths in one invocation.
- `--dry-run` to see the plan before committing to it.
- `--json` with a stable schema, plus documented exit codes.
- A real programmatic API. In v1, `main` pointed at `cli.js`, so importing the package executed the CLI, argv parsing and all.

## Using it as a library

v1 could not be imported. v2 ships ESM and CommonJS builds with full type definitions:

```ts
import { compressImages, toQuality } from "image-and-video-compressor";

const report = await compressImages(["./photos"], { quality: toQuality(80) });
console.log(report.summary.savedBytes);
```

Quality goes through `toQuality()`, which validates the range and returns a branded type. Passing a bare `number` will not compile — the guard that stops a 1-100 quality reaching a flag that expects 0-51.
