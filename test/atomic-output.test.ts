import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { tempDir } from "./helpers.js";
import { temporaryOutputPath, withAtomicOutput } from "../src/core/atomic-output.js";

describe("atomic output lifecycle", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it("uses unique hidden names that keep the destination extension last", () => {
    const output = join(dir, "hero.mp4");
    const first = temporaryOutputPath(output);
    const second = temporaryOutputPath(output);

    expect(dirname(first)).toBe(dir);
    expect(basename(first)).toMatch(/^\.hero-.+\.tmp\.mp4$/);
    expect(first).not.toBe(second);
  });

  it("atomically replaces the destination after a successful write", async () => {
    const output = join(dir, "success", "hero.webp");
    await withAtomicOutput(output, async (temporaryPath) => {
      await writeFile(temporaryPath, "new bytes");
      return { value: undefined, replace: true };
    });

    expect(await readFile(output, "utf8")).toBe("new bytes");
    expect(await readdir(dirname(output))).toEqual(["hero.webp"]);
  });

  it("preserves the destination and removes the temp file after failure", async () => {
    const output = join(dir, "failure", "hero.webp");
    await withAtomicOutput(output, async (temporaryPath) => {
      await writeFile(temporaryPath, "old bytes");
      return { value: undefined, replace: true };
    });

    await expect(
      withAtomicOutput(output, async (temporaryPath) => {
        await writeFile(temporaryPath, "partial bytes");
        throw new Error("encode failed");
      }),
    ).rejects.toThrow("encode failed");

    expect(await readFile(output, "utf8")).toBe("old bytes");
    expect(await readdir(dirname(output))).toEqual(["hero.webp"]);
  });

  it("preserves the destination when the caller declines replacement", async () => {
    const output = join(dir, "skipped", "hero.webp");
    await withAtomicOutput(output, async (temporaryPath) => {
      await writeFile(temporaryPath, "old bytes");
      return { value: undefined, replace: true };
    });

    await withAtomicOutput(output, async (temporaryPath) => {
      await writeFile(temporaryPath, "larger bytes");
      return { value: undefined, replace: false };
    });

    expect(await readFile(output, "utf8")).toBe("old bytes");
    expect(await readdir(dirname(output))).toEqual(["hero.webp"]);
  });

  it("removes the temp file when the operation is aborted", async () => {
    const output = join(dir, "aborted", "hero.webp");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    await expect(
      withAtomicOutput(output, async (temporaryPath) => {
        await writeFile(temporaryPath, "partial bytes");
        throw abortError;
      }),
    ).rejects.toBe(abortError);

    expect(await readdir(dirname(output))).toEqual([]);
  });
});
