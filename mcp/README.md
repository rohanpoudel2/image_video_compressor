# image-and-video-compressor-mcp

An [MCP](https://modelcontextprotocol.io) server that lets a coding agent compress images and videos, inspect media files, and find out what the local ffmpeg and sharp builds can actually do.

Wraps [`image-and-video-compressor`](https://www.npmjs.com/package/image-and-video-compressor). Source files are never modified — output goes to a separate directory.

## Install

Add it to your MCP client's config. Nothing to install first; `npx` fetches it on demand.

**Claude Code**

```bash
claude mcp add image-video-compressor -- npx -y image-and-video-compressor-mcp
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "image-video-compressor": {
      "command": "npx",
      "args": ["-y", "image-and-video-compressor-mcp"]
    }
  }
}
```

Requires **Node 20.11+**. Images work out of the box. Video needs `ffmpeg` on your `PATH` — without it the image tools still work and the video ones say so rather than failing obscurely.

## Tools

### `compress_media`

Compress images and/or videos. Accepts files or directories.

Source files are never modified or overwritten; output is written to a `compressed` folder beside the source, or wherever `outDir` points. If compressing would make a file bigger, the original is kept and the file is reported as skipped rather than quietly made worse.

| Parameter                | Applies to | Notes                                                           |
| ------------------------ | ---------- | --------------------------------------------------------------- |
| `paths`                  | both       | Required. Files or directories.                                 |
| `kind`                   | both       | `auto` (default), `image`, `video`.                             |
| `quality`                | both       | 1-100, default 75. Mapped onto each codec's own scale.          |
| `to`                     | both       | `.webp`, `.avif`, `.mp4`, `.webm`, …                            |
| `outDir`                 | both       | Default: a `compressed` folder beside the source.               |
| `recursive`              | both       | Mirrors the input tree in the output.                           |
| `overwrite`              | both       | Otherwise an existing output is skipped.                        |
| `dryRun`                 | both       | Plan only, writes nothing.                                      |
| `maxWidth` / `maxHeight` | both       | Shrink to fit. Never enlarges.                                  |
| `concurrency`            | both       | Default is per media kind.                                      |
| `skipLarger`             | both       | Default true: keep the original when compression would grow it. |
| `keepMetadata`           | images     | Preserve EXIF/ICC. Default false — stripping saves real bytes.  |
| `autoRotate`             | images     | Apply EXIF orientation. Default true.                           |
| `videoCodec`             | video      | `libx264`, `libx265`, `libsvtav1`, `libvpx-vp9`, …              |
| `audioCodec`             | video      | `aac`, `libopus`, or `copy`.                                    |
| `fps`                    | video      | Cap the frame rate. Default keeps the source rate.              |
| `preset`                 | video      | Codec-specific speed/efficiency tradeoff.                       |
| `ffmpegPath`             | video      | Explicit binary path.                                           |

Set `dryRun: true` to see the plan and the output paths without writing anything.

### `discover_media`

List the image and video files under given paths without compressing or opening them. Classification is by extension, so it scans large trees cheaply.

Answers "what media is in this project and how much does it weigh" before deciding what to act on. Returns per-file path, kind and size, plus totals.

Parameters: `paths` (required), `kind`, `recursive`.

### `plan_video_conversion`

For a video and a target container, report what converting would do — before writing anything.

Returns the codec that would be used, the audio codec, what the given quality maps to on that codec's own scale (`encoderValue` — CRF counts down, Theora's scale counts up), the duration, which streams survive, and **which streams would be dropped and why**.

This is the tool for "will I lose my subtitles or the commentary track if I convert this to mp4". Losing a track silently is worse than refusing outright, because nobody notices until they need it.

Parameters: `path` (required), `to` (required, a curated container), `quality`, `videoCodec`, `ffmpegPath`.

### `probe_media`

Identify one file without modifying it: image or video, size on disk, and for video the duration and stream layout from ffprobe.

Detection uses content bytes when the extension is missing or wrong, so a `.jpg` that is really an MP4 is reported correctly.

### `list_capabilities`

What this machine can genuinely encode and decode.

Worth calling before choosing an output format. Support is build-dependent rather than fixed by the package: AVIF, JPEG XL and HEIC are frequently missing from sharp, and a minimal ffmpeg carries a fraction of the containers and codecs a full one does. The image list is produced by actually encoding a pixel with each candidate, so it reflects the binary you have rather than what the package hopes is there.

## Notes for agents

- **Preview before writing.** `compress_media` with `dryRun: true` shows exactly which files would be written where; `plan_video_conversion` adds the stream-level detail. Both are free.
- **Check the format first.** `list_capabilities` prevents asking for an encoder this machine does not have.
- **Survey before acting.** `discover_media` is the cheap way to see what is there without decoding anything.
- **Failures are per-file.** A corrupt file is reported in `results` with a stable error code; the rest of the batch still completes. Branch on `error.code`, not on the message text.
- **Skips are not failures.** `status: "skipped"` with `reason: "output-larger-than-input"` means compression was attempted and the original was better.

## License

MIT © Rohan Poudel
