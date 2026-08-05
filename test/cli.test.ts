import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { access } from "node:fs/promises";

import { tempDir, makeImage, makeCorruptImage, runCli } from "./helpers.js";

/**
 * End-to-end CLI tests.
 *
 * These spawn the built binary with both streams piped, which is the exact
 * condition v1 could not survive. Run `npm run build` first; `npm test` does.
 */
describe("CLI", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    await access("dist/cli.js").catch(() => {
      throw new Error(
        "dist/cli.js is missing — run `npm run build` before the CLI tests.",
      );
    });
  });
  afterAll(() => cleanup());

  describe("--json contract", () => {
    it("puts exactly one JSON document on stdout and nothing else", async () => {
      const src = join(dir, "json");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", join(dir, "json-out"), "--json"]);

      // Must parse without any stripping: a stray banner would break agents.
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed["ok"]).toBe(true);
      expect(parsed["schemaVersion"]).toBe(1);
    });

    it("keeps human output on stderr in JSON mode", async () => {
      const src = join(dir, "json2");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", join(dir, "json2-out"), "--json"]);

      expect(result.stdout.trimStart().startsWith("{")).toBe(true);
      // Banner and summary text belong on stderr; stdout is the data channel.
      expect(result.stdout).not.toContain("compressing images");
      expect(result.stdout).not.toContain("Total");
    });

    it("reports failures as structured JSON with a stable code", async () => {
      const src = join(dir, "jsonfail");
      await makeCorruptImage(join(src, "bad.png"));

      const result = await runCli([
        "image",
        src,
        "--out",
        join(dir, "jsonfail-out"),
        "--json",
      ]);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        results: { status: string; error?: { code: string } }[];
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.results[0]?.status).toBe("failed");
      expect(parsed.results[0]?.error?.code).toBe("ENCODE_FAILED");
    });

    it("emits a JSON error object for a setup failure", async () => {
      const result = await runCli([join(dir, "no-such-dir"), "--json"]);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string };
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INPUT_NOT_FOUND");
      expect(result.exitCode).toBe(4);
    });

    it("describes this build's real capabilities for a caller to discover", async () => {
      const result = await runCli(["formats", "--json"]);
      const parsed = JSON.parse(result.stdout) as {
        image: { read: string[]; write: { extensions: string[] }[] };
        video: {
          available: boolean;
          curated: { extension: string; videoCodecs: string[] }[];
          videoEncoders: string[];
        };
      };

      const writable = parsed.image.write.flatMap((w) => w.extensions);
      // SVG decodes but has no encoder, on every build.
      expect(writable).not.toContain(".svg");
      expect(parsed.image.read).toContain(".svg");
      expect(writable).toContain(".webp");

      if (parsed.video.available) {
        const webm = parsed.video.curated.find((c) => c.extension === ".webm");
        expect(webm?.videoCodecs).not.toContain("libx264");
        // Reported from `ffmpeg -encoders`, so it reflects the real binary.
        expect(parsed.video.videoEncoders.length).toBeGreaterThan(5);
      }
    });
  });

  describe("exit codes", () => {
    it.each([
      ["--help", 0],
      ["--version", 0],
    ])("%s exits %i", async (flag, expected) => {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(expected);
    });

    it("exits 2 for an unknown option", async () => {
      const result = await runCli(["image", dir, "--nonsense"]);
      expect(result.exitCode).toBe(2);
    });

    it("exits 2 for an out-of-range quality", async () => {
      const src = join(dir, "q");
      await makeImage(join(src, "a.png"));

      const result = await runCli(["image", src, "--quality", "500"]);
      expect(result.exitCode).toBe(2);
    });
  });

  describe("dry run", () => {
    it("plans without writing anything", async () => {
      const src = join(dir, "dry");
      const out = join(dir, "dry-out");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", out, "--dry-run", "--json"]);
      const parsed = JSON.parse(result.stdout) as {
        dryRun: boolean;
        results: { status: string; reason?: string; outputPath: string }[];
      };

      expect(parsed.dryRun).toBe(true);
      expect(parsed.results[0]?.reason).toBe("dry-run");
      // The planned destination is still reported, so a caller can preview it.
      expect(parsed.results[0]?.outputPath).toContain("a.webp");
      await expect(access(out)).rejects.toThrow();
    });
  });

  describe("deprecated v1 commands", () => {
    it("still runs optimise:image", async () => {
      const src = join(dir, "legacy-img");
      await makeImage(join(src, "a.png"));

      const result = await runCli([
        "optimise:image",
        `--loadFolder=${src}`,
        "--quality=40",
        "--output=.webp",
      ]);

      expect(result.exitCode).toBe(0);
      // v1 wrote into <loadFolder>/optimised_images; that layout is preserved.
      await access(join(src, "optimised_images", "a.webp"));
    });

    it("warns that optimise:image is deprecated without failing", async () => {
      const src = join(dir, "legacy-warn");
      await makeImage(join(src, "a.png"));

      const result = await runCli(["optimise:image", `--loadFolder=${src}`]);

      expect(result.stderr).toContain("deprecated");
      expect(result.stderr).toContain("imgvidcompress image");
      expect(result.exitCode).toBe(0);
    });

    it("keeps v1's 10-100 quality validation", async () => {
      const src = join(dir, "legacy-q");
      await makeImage(join(src, "a.png"));

      const result = await runCli([
        "optimise:image",
        `--loadFolder=${src}`,
        "--quality=5",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("between 10 and 100");
    });

    it("still requires --loadFolder, as v1 did", async () => {
      const result = await runCli(["optimise:image"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/loadFolder/i);
    });
  });

  describe("output", () => {
    it("emits no ANSI escape codes with --no-color", async () => {
      const src = join(dir, "nocolor");
      await makeImage(join(src, "a.png"));

      const result = await runCli([
        src,
        "--out",
        join(dir, "nocolor-out"),
        "--no-color",
      ]);

      // eslint-disable-next-line no-control-regex
      expect(result.stderr).not.toMatch(/\[[0-9;]*m/);
    });

    it("prints nothing on success with --quiet", async () => {
      const src = join(dir, "quiet");
      await makeImage(join(src, "a.png"));

      const result = await runCli([src, "--out", join(dir, "quiet-out"), "--quiet"]);

      expect(result.stdout.trim()).toBe("");
      expect(result.stderr.trim()).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("lists formats in human-readable form", async () => {
      const result = await runCli(["formats"]);
      expect(result.stdout).toContain("WebP");
      expect(result.stdout).toContain("WebM");
      expect(result.exitCode).toBe(0);
    });
  });
});
