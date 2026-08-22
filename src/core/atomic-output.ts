import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export interface AtomicOutputDecision<T> {
  readonly value: T;
  readonly replace: boolean;
}

/**
 * Produce a file beside its destination and replace the destination atomically.
 *
 * The leading dot keeps discovery from treating an in-flight encode as input
 * during a concurrent or later run. Keeping the real extension last also lets
 * tools such as ffmpeg infer the correct output format.
 */
export function temporaryOutputPath(outputPath: string): string {
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  return join(dirname(outputPath), `.${stem}-${randomUUID()}.tmp${extension}`);
}

export async function withAtomicOutput<T>(
  outputPath: string,
  produce: (temporaryPath: string) => Promise<AtomicOutputDecision<T>>,
): Promise<T> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = temporaryOutputPath(outputPath);

  try {
    const decision = await produce(temporaryPath);
    if (decision.replace) await rename(temporaryPath, outputPath);
    return decision.value;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
