import { availableParallelism } from "node:os";

/**
 * Bounded-concurrency map preserving input order.
 *
 * v1 ran `Promise.all` over every file in the folder, which meant a directory
 * of 500 videos spawned 500 simultaneous ffmpeg processes and took the machine
 * down with it. Work is now pulled off a shared cursor by a fixed number of
 * workers, so peak resource use is a function of `limit`, not of input size.
 *
 * Unlike `Promise.all`, a rejected task does not cancel its siblings — `fn` is
 * expected to resolve with a failure value instead of throwing, so a run always
 * yields one result per input.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      signal?.throwIfAborted();
      // Guarded by the bounds check above; satisfies noUncheckedIndexedAccess.
      results[index] = await fn(items[index]!, index);
    }
  }

  // An aborted sibling may still be unwinding an encoder. Waiting for every
  // active worker ensures its output cleanup finishes before the run rejects.
  const settled = await Promise.allSettled(
    Array.from({ length: workers }, () => worker()),
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return results;
}

/** Logical cores available to this process, honouring cgroup limits. */
export function cpuCount(): number {
  return Math.max(1, availableParallelism());
}

/**
 * Default worker counts, chosen per media kind.
 *
 * sharp releases the event loop and parallelises internally via libvips, so
 * images scale close to core count. ffmpeg saturates several cores per process
 * on its own, so stacking them mostly adds contention and memory pressure.
 */
export function defaultConcurrency(kind: "image" | "video"): number {
  const cores = cpuCount();
  return kind === "image"
    ? Math.max(1, Math.min(cores, 8))
    : Math.max(1, Math.floor(cores / 4));
}
