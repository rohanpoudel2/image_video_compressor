import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

/** Create an isolated temp directory, returning it plus a cleanup function. */
export async function tempDir(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "imgvidcompress-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface MakeImageOptions {
  width?: number;
  height?: number;
  format?: "png" | "jpeg" | "webp";
  /** Noise makes the image genuinely incompressible; flat colour does not. */
  noise?: boolean;
}

/** Write a real, decodable image to `path`. */
export async function makeImage(
  path: string,
  options: MakeImageOptions = {},
): Promise<void> {
  const { width = 200, height = 150, format = "png", noise = false } = options;

  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < pixels.length; i++) {
    // Deterministic pseudo-noise: no Math.random, so failures reproduce.
    pixels[i] = noise ? (i * 2654435761) % 256 : 120;
  }

  const image = sharp(pixels, { raw: { width, height, channels } });
  const encoded =
    format === "png" ? image.png() : format === "jpeg" ? image.jpeg() : image.webp();

  await mkdir(join(path, ".."), { recursive: true });
  await encoded.toFile(path);
}

/** A file with the right extension but garbage contents. */
export async function makeCorruptImage(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "this is definitely not image data");
}

let ffmpegAvailable: boolean | null = null;

/**
 * Whether a usable ffmpeg exists on this machine.
 *
 * End-to-end video tests are skipped rather than failed when it is missing, so
 * a contributor without ffmpeg still gets a green suite. The codec matrix and
 * CRF mapping are pure functions and are always tested.
 */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;

  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

/** Generate a short test video with ffmpeg's synthetic source. */
export async function makeVideo(path: string, seconds = 1): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${seconds}:size=320x240:rate=30`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    path,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg fixture failed: ${String(code)}`)),
    );
  });
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the built CLI as a real child process with pipes on both streams.
 *
 * Piped stdio is deliberate: it is exactly the condition under which v1 died
 * with `process.stdout.clearLine is not a function`.
 */
export function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}
