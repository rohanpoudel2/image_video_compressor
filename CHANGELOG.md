# Changelog

Notable changes to `image-and-video-compressor`. Versions before 2.1.0 predate
this file; see [MIGRATION.md](./MIGRATION.md) for the v1 → v2 story and the
[releases page](https://github.com/rohanpoudel2/image_video_compressor/releases)
for the rest.

This project follows [semantic versioning](https://semver.org/). Error codes,
exit codes and the `--json` `schemaVersion` are the stable contract; human-
readable messages are not.

## 2.1.0

The theme of this release is that the tool should do what its documentation
says it does. Three things it claimed were not true.

### Fixed

- **A failed or skipped re-run could destroy a good output file.** Both
  encoders wrote straight to the destination, and two paths then removed it. In
  an `--overwrite` re-run over a directory that already had output, that cost
  you a valid file — while reporting `skipped — output-larger-than-input`,
  whose documented meaning is that nothing was touched. Encoding now goes to a
  hidden staging file beside the destination and is renamed onto it only after
  the encode succeeds and clears the skip-larger check. Failure, abort and
  skip-larger remove the staging file only. ([#22])

- **`--dry-run` reported nothing about size.** Every dry-run result is a skip,
  and the summary only counted encoded files, so `--dry-run --json | jq
.summary` returned zeros. ([#24])

- **`--dry-run` could not tell you the run would fail.** It never resolved
  ffmpeg, so a machine without it reported a clean plan and then died for real.
  ([#24])

- **`--dry-run` misreported what would be skipped.** Files a real run would
  skip as `output-exists` were reported as `dry-run`. ([#24])

- **The CLI rejected codecs the library and this ffmpeg both supported.**
  `--codec` and `--audio-codec` were pinned to hardcoded lists, so
  `--audio-codec libmp3lame` failed even though the container matrix, the
  library and the README all allowed it. Both lists are gone; validation now
  runs against the registries and the encoders your ffmpeg actually reports.
  ([#23])

- Aborting a run could strand staging files, because the worker pool rejected
  on the first abort without waiting for sibling cleanup. ([#22])

### Added

- **A capability preflight.** Before any file is encoded, the run checks every
  planned codec against your ffmpeg build. A missing explicitly requested
  encoder fails once, up front, listing what that build does have — instead of
  one wall of ffmpeg stderr per file. A missing default is substituted with an
  available legal codec and reported. ([#23])

- `summary.planned` and `summary.plannedInputBytes`, counting the files a dry
  run would send to an encoder. Savings are never estimated: they cannot be
  known without encoding. ([#24])

- Results carry the resolved `targetFormat`, and video results carry
  `videoCodec` and `audioCodec`. ([#24])

- Dry runs report the stream drops a real run would emit — the answer to "will
  this lose my subtitles" before a byte is written. ([#24])

- The MCP server's `list_capabilities` returns muxer and encoder _names_
  alongside the counts it already reported. A count cannot be used to plan a
  conversion. ([#23])

### Changed

- **A dry run with video planned and no usable ffmpeg now exits 3 instead of 0.** A plan that cannot be executed is not a passing plan. If you rely on
  `--dry-run` exiting 0 on a machine without ffmpeg, this will surface.

- **Video dry runs are slower.** Reporting stream drops means probing each
  source. Accuracy is the purpose of a plan.

- `CompressionJob.targetFormat` widens from `VideoContainer` to
  `VideoOutputSpec`. The runtime could always produce an arbitrary muxer
  extension here, so the old type was simply wrong. TypeScript consumers
  exhaustively switching on it will see a wider union.

- The MCP server reports its real package version instead of a hardcoded
  `0.1.0`. ([#23])

### Security

- Cleared the dev-only `nanoid` (high) and `esbuild` (low) advisories. Neither
  ever reached published output — both are build-time dependencies, and the
  esbuild issue affects its dev server, which this project does not run.

`schemaVersion` stays at **1**. Every reporting change above is additive; no
existing field changed meaning.

[#22]: https://github.com/rohanpoudel2/image_video_compressor/pull/22
[#23]: https://github.com/rohanpoudel2/image_video_compressor/pull/23
[#24]: https://github.com/rohanpoudel2/image_video_compressor/pull/24
