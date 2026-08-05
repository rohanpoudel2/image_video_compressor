import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir, makeImage } from "./helpers.js";

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

  it("advertises its three tools, each documented", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compress_media",
      "list_capabilities",
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

  it("rejects arguments that violate the schema", async () => {
    const result = await client.callTool({
      name: "compress_media",
      arguments: { paths: ["x"], kind: "banana" },
    });

    expect(result.isError).toBe(true);
  });

  it("reports a missing file as an error rather than a crash", async () => {
    const result = await client.callTool({
      name: "probe_media",
      arguments: { path: join(root, "definitely-not-here.jpg") },
    });

    expect(result.isError).toBe(true);
  });
});
