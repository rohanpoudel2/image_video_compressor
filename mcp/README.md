# image-and-video-compressor-mcp

[![npm version](https://img.shields.io/npm/v/image-and-video-compressor-mcp?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/image-and-video-compressor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/image-and-video-compressor-mcp?color=cb3837)](https://www.npmjs.com/package/image-and-video-compressor-mcp)
[![node](https://img.shields.io/node/v/image-and-video-compressor-mcp?logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/image-and-video-compressor-mcp)](https://github.com/rohanpoudel2/image_video_compressor/blob/main/LICENSE)

An [MCP](https://modelcontextprotocol.io) server that lets a coding agent compress images and videos, inspect media files, and find out what the local ffmpeg and sharp builds can actually do.

Wraps [`image-and-video-compressor`](https://www.npmjs.com/package/image-and-video-compressor). **Source files are never modified** — output goes to a separate directory, and if compressing would make a file bigger the original is kept.

## Install

Nothing to install first. `npx` fetches the server on demand.

**Claude Code**

```bash
claude mcp add image-video-compressor -- npx -y image-and-video-compressor-mcp
```

**Codex CLI**

```bash
codex mcp add image-video-compressor -- npx -y image-and-video-compressor-mcp
```

Or add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.image-video-compressor]
command = "npx"
args = ["-y", "image-and-video-compressor-mcp"]
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

**Any other MCP client** — it is a plain stdio server, so the same command works anywhere (Cursor, VS Code, Windsurf, Zed):

```json
{
  "command": "npx",
  "args": ["-y", "image-and-video-compressor-mcp"]
}
```

### Requirements

**Node 20.11+.** Images work out of the box — sharp ships prebuilt binaries.

Video needs `ffmpeg` on your `PATH`:

```bash
brew install ffmpeg                 # macOS
sudo apt install ffmpeg             # Debian/Ubuntu
winget install Gyan.FFmpeg          # Windows
```

Without it the image tools still work; the video ones say so plainly instead of failing obscurely. You can also point at a binary directly with the `ffmpegPath` parameter.

## What you can ask for

Once it is connected, these are ordinary requests:

> Compress every image in `./public/img` to WebP and tell me how much you saved.

> How much media is in this repo and what does it weigh?

> Will converting `interview.mkv` to mp4 lose the subtitles or the second audio track?

> Shrink these product photos to 1200px wide, but don't touch the originals.

> Can this machine even write AVIF?

The agent picks the tool. What matters is that it can check before acting rather than guessing.

## Tools

### `compress_media`

Compress images and/or videos. Accepts files or directories.

Output goes to a `compressed` folder beside the source, or wherever `outDir` points. Source files are never modified or overwritten. If compressing would make a file bigger, the original is kept and the file is reported as `skipped` rather than quietly made worse.

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

Returns per-file results with bytes saved, plus a summary. `dryRun: true` returns the same shape, including the output path each file would take, without writing anything.

### `discover_media`

List the image and video files under given paths without compressing or opening them. Classification is by extension, so it scans large trees cheaply.

Answers "what media is here and how much does it weigh" before deciding what to act on. Returns per-file path, kind and size, plus totals.

Parameters: `paths` (required), `kind`, `recursive`.

### `probe_media`

Identify one file: image or video, size on disk, and for video the duration and stream layout from ffprobe.

Identification is **by content, not by filename**. A `.jpg` that is really an MP4 is reported as the video it is, with a note that the extension disagrees.

Parameters: `path` (required).

### `plan_video_conversion`

For a video and a target container, report what converting would do — before writing anything.

Returns the codec that would be used, the audio codec, what the quality maps to on that codec's own scale (`encoderValue` — CRF counts down, Theora's scale counts up), the duration, which streams survive, and **which streams would be dropped and why**.

This is the tool for "will I lose my subtitles or the commentary track". Losing a track silently is worse than refusing outright, because nobody notices until they need it.

It also refuses to plan a conversion this ffmpeg cannot perform, rather than promising a codec the build does not have.

Parameters: `path` (required), `to` (required, a curated container), `quality`, `videoCodec`, `ffmpegPath`.

### `list_capabilities`

What this machine can genuinely encode and decode.

Worth calling before choosing an output format. Support is build-dependent rather than fixed by the package: AVIF, JPEG XL and HEIC are frequently missing from sharp, and a minimal ffmpeg carries a fraction of the containers and codecs a full one does. The response includes the actual muxer, video encoder and audio encoder names as well as their counts. The image list is produced by actually encoding a pixel with each candidate, so it reflects the binary you have rather than what the package hopes is there.

Parameters: `ffmpegPath` (optional).

## Notes for agents

- **Preview before writing.** `compress_media` with `dryRun: true` shows exactly which files would be written where; `plan_video_conversion` adds the stream-level detail. Both are free.
- **Check the format first.** `list_capabilities` prevents asking for an encoder this machine does not have.
- **Survey before acting.** `discover_media` is the cheap way to see what is there without decoding anything.
- **Failures are per-file.** A corrupt file is reported in `results` with a stable error code; the rest of the batch still completes. Branch on `error.code`, not on message text.
- **Skips are not failures.** `status: "skipped"` with `reason: "output-larger-than-input"` means compression was attempted and the original was genuinely better.

## Troubleshooting

**The server does not start.** Check Node with `node -v` — 20.11 or newer is required. Run `npx -y image-and-video-compressor-mcp` directly: it should start and sit waiting on stdin, printing nothing. Any output on stdout would corrupt the protocol, so silence is correct.

**Video tools report ffmpeg is missing, but it is installed.** The server inherits the `PATH` its client was launched with, which for a GUI app is often not your shell's. Pass an explicit `ffmpegPath`, or set `FFMPEG_PATH` in the client's `env` block. `list_capabilities` shows the binary actually resolved.

**A format is rejected as unsupported.** Ask `list_capabilities` rather than assuming. sharp and ffmpeg are both build-dependent, and a stock macOS sharp has no HEIC, JPEG 2000 or JPEG XL encoder.

**Compression reports files as skipped.** That is the tool declining to make a file worse. Small PNGs, already-optimised WebP and flat graphics often do not get smaller when re-encoded. Pass `skipLarger: false` if you want the output anyway, usually because the format conversion matters more than the bytes.

## Links

- [Main package](https://www.npmjs.com/package/image-and-video-compressor) — the CLI and Node library this wraps
- [Source and issues](https://github.com/rohanpoudel2/image_video_compressor)

## License

MIT © Rohan Poudel
