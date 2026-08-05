import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir, makeImage, hasFfmpeg } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "mcp", "dist", "bin.js");

/**
 * The MCP server is a separate workspace package, so it may not be built when
 * only the library has been. Skipping mirrors how the video suite behaves
 * without ffmpeg: absent tooling means untested, never a false pass.
 */
const built = existsSync(serverPath);

describe.skipIf(!built)("mcp server", () => {
  let client: Client;
  let fixtures: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    // Generated rather than read from samples/, which is gitignored and absent
    // in CI — depending on it made this suite pass locally and fail on a runner.
    ({ dir: fixtures, cleanup } = await tempDir());
    await makeImage(join(fixtures, "photo.png"), {
      width: 400,
      height: 300,
      noise: true,
    });
    await makeImage(join(fixtures, "flat.png"), { width: 300, height: 200 });

    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [serverPath] }),
    );
  });

  afterAll(async () => {
    await client?.close();
    await cleanup?.();
  });

  /**
   * Every tool answers with JSON in a single text block.
   *
   * Takes `unknown` because `callTool` is typed as a union that still carries
   * the legacy `{ toolResult }` shape, which has no `content` at all.
   */
  function text<T>(result: unknown): T {
    const { content } = result as { content?: { type: string; text: string }[] };
    if (!content?.[0]) throw new Error("tool returned no content");
    return JSON.parse(content[0].text) as T;
  }

  it("advertises every tool, each documented", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compress_media",
      "discover_media",
      "list_capabilities",
      "plan_video_conversion",
      "probe_media",
    ]);

    // The description is the only thing an agent reads before choosing a tool,
    // so an empty or throwaway one is a real defect.
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.inputSchema, `${tool.name} schema`).toBeTruthy();
    }
  });

  it("exposes every library option through compress_media", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "compress_media")!.inputSchema;
    const params = Object.keys(schema.properties ?? {});

    // Guards against the gap this list was written to close: keepMetadata,
    // autoRotate and preset were library options with no way to reach them.
    for (const option of [
      "paths",
      "kind",
      "quality",
      "to",
      "outDir",
      "recursive",
      "overwrite",
      "dryRun",
      "maxWidth",
      "maxHeight",
      "concurrency",
      "skipLarger",
      "keepMetadata",
      "autoRotate",
      "videoCodec",
      "audioCodec",
      "fps",
      "preset",
      "ffmpegPath",
    ]) {
      expect(params, `compress_media is missing ${option}`).toContain(option);
    }
  });

  it("reports capabilities actually present on this machine", async () => {
    const caps = text<{ image: { write: { extensions: string[] }[] } }>(
      await client.callTool({ name: "list_capabilities", arguments: {} }),
    );

    expect(caps.image.write.length).toBeGreaterThan(0);
    // WebP is the default output format; if it is missing the tool is unusable.
    const extensions = caps.image.write.flatMap((format) => format.extensions);
    expect(extensions).toContain(".webp");
  });

  it("never writes anything on a dry run", async () => {
    const outDir = join(fixtures, "dry-output");
    const report = text<{ dryRun: boolean; summary: { totalFiles: number } }>(
      await client.callTool({
        name: "compress_media",
        arguments: { paths: [fixtures], dryRun: true, outDir },
      }),
    );

    expect(report.dryRun).toBe(true);
    expect(report.summary.totalFiles).toBeGreaterThan(0);
    expect(existsSync(outDir)).toBe(false);
  });

  it("compresses for real and reports what it saved", async () => {
    const outDir = join(fixtures, "real-output");
    const report = text<{
      ok: boolean;
      summary: { compressed: number; savedBytes: number };
      results: { status: string; outputPath?: string }[];
    }>(
      await client.callTool({
        name: "compress_media",
        arguments: {
          paths: [fixtures],
          kind: "image",
          to: ".webp",
          outDir,
          overwrite: true,
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.summary.compressed).toBeGreaterThan(0);

    for (const result of report.results) {
      if (result.status === "compressed")
        expect(existsSync(result.outputPath!)).toBe(true);
    }
  });

  it("identifies a file it was given", async () => {
    const probe = text<{ kind: string; bytes: number }>(
      await client.callTool({
        name: "probe_media",
        arguments: { path: join(fixtures, "photo.png") },
      }),
    );

    expect(probe.kind).toBe("image");
    expect(probe.bytes).toBeGreaterThan(0);
  });

  it("tells a dry run WHERE each file would be written", async () => {
    const report = text<{ results: { status: string; outputPath?: string }[] }>(
      await client.callTool({
        name: "compress_media",
        arguments: { paths: [fixtures], kind: "image", dryRun: true },
      }),
    );

    // Without this the dry-run preview cannot answer the one question it
    // exists to answer, even though the library computed the path already.
    for (const result of report.results) {
      expect(result.outputPath, JSON.stringify(result)).toBeTruthy();
    }
  });

  it("identifies a misnamed file by its contents, not its extension", async () => {
    // A real JPEG called .mp4. Trusting the name meant ffprobe ran on it and
    // the image2 demuxer reported a one-frame "mjpeg video stream" — a
    // fabricated answer that looked entirely plausible.
    const liar = join(fixtures, "actually-an-image.mp4");
    await copyFile(join(fixtures, "photo.png"), liar);

    const probe = text<{ kind: string; note?: string; video?: unknown }>(
      await client.callTool({ name: "probe_media", arguments: { path: liar } }),
    );

    expect(probe.kind).toBe("image");
    expect(probe.note).toBeTruthy();
    expect(probe.video).toBeUndefined();
  });

  it("rejects arguments that violate the schema", async () => {
    const result = await client.callTool({
      name: "compress_media",
      arguments: { paths: ["x"], kind: "banana" },
    });

    expect(result.isError).toBe(true);
  });

  it("refuses to plan a conversion this ffmpeg cannot actually perform", async () => {
    if (!(await hasFfmpeg())) return;

    // Which encoders exist is build-dependent, so ask rather than assume, then
    // name one that is genuinely absent. The curated table alone would happily
    // promise it and the compression that followed would die on "Unknown
    // encoder" — a plan predicting success for something unrunnable.
    const caps = text<{
      video: { containers: { extension: string; videoCodecs: string[] }[] };
    }>(await client.callTool({ name: "list_capabilities", arguments: {} }));
    const empty = caps.video.containers.find((c) => c.videoCodecs.length === 0);
    if (!empty) return;

    const result = await client.callTool({
      name: "plan_video_conversion",
      arguments: { path: join(fixtures, "photo.png"), to: empty.extension },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects a container it cannot plan for", async () => {
    const result = await client.callTool({
      name: "plan_video_conversion",
      arguments: { path: join(fixtures, "photo.png"), to: ".nonsense" },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects a codec the target container cannot carry", async () => {
    // WebM genuinely cannot carry H.264. Caught before any work starts.
    const result = await client.callTool({
      name: "plan_video_conversion",
      arguments: {
        path: join(fixtures, "photo.png"),
        to: ".webm",
        videoCodec: "libx264",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("lists what is on disk without decoding it", async () => {
    const found = text<{ totalFiles: number; images: number; videos: number }>(
      await client.callTool({
        name: "discover_media",
        arguments: { paths: [fixtures] },
      }),
    );

    expect(found.totalFiles).toBeGreaterThan(0);
    expect(found.images + found.videos).toBe(found.totalFiles);
  });

  it("reports a missing file as an error rather than a crash", async () => {
    const result = await client.callTool({
      name: "probe_media",
      arguments: { path: join(root, "definitely-not-here.jpg") },
    });

    expect(result.isError).toBe(true);
  });
});
