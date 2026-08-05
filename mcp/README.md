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

Key parameters: `paths` (required), `kind` (`auto`/`image`/`video`), `quality` (1-100), `to` (e.g. `.webp`, `.avif`, `.mp4`, `.webm`), `outDir`, `recursive`, `dryRun`, `maxWidth`, `maxHeight`, `overwrite`, plus `videoCodec`, `audioCodec`, `fps` and `ffmpegPath` for video.

Set `dryRun: true` to see the plan and the output paths without writing anything.

### `probe_media`

Identify one file without modifying it: image or video, size on disk, and for video the duration and stream layout from ffprobe.

Detection uses content bytes when the extension is missing or wrong, so a `.jpg` that is really an MP4 is reported correctly.

### `list_capabilities`

What this machine can genuinely encode and decode.

Worth calling before choosing an output format. Support is build-dependent rather than fixed by the package: AVIF, JPEG XL and HEIC are frequently missing from sharp, and a minimal ffmpeg carries a fraction of the containers and codecs a full one does. The image list is produced by actually encoding a pixel with each candidate, so it reflects the binary you have rather than what the package hopes is there.

## Notes for agents

- **Preview before writing.** `compress_media` with `dryRun: true` is free and shows exactly which files would be written where.
- **Check the format first.** `list_capabilities` prevents asking for an encoder this machine does not have.
- **Failures are per-file.** A corrupt file is reported in `results` with a stable error code; the rest of the batch still completes. Branch on `error.code`, not on the message text.
- **Skips are not failures.** `status: "skipped"` with `reason: "output-larger-than-input"` means compression was attempted and the original was better.

## License

MIT © Rohan Poudel
