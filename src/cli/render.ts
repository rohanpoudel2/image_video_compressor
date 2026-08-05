import pc from "picocolors";
import { basename } from "node:path";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  padEnd,
  padStart,
} from "./format.js";
import type {
  CompressionJob,
  CompressionReport,
  JobResult,
  ProgressEvent,
} from "../types/results.js";

/**
 * Terminal renderer.
 *
 * The central rule: *every* cursor manipulation is gated behind an `isTty`
 * check. v1 called `process.stdout.clearLine()` unconditionally, which throws
 * `TypeError: process.stdout.clearLine is not a function` the moment output is
 * piped — so the tool could not be used in CI, in a shell pipeline, or with its
 * output redirected to a file. Non-TTY mode here degrades to plain append-only
 * lines rather than failing.
 */
export class Renderer {
  private readonly stream: NodeJS.WriteStream;
  private readonly isTty: boolean;
  private readonly quiet: boolean;
  private readonly active = new Map<string, { job: CompressionJob; ratio: number }>();
  private linesDrawn = 0;
  private completed = 0;
  private total = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { stream?: NodeJS.WriteStream; quiet?: boolean } = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.quiet = opts.quiet ?? false;
    // `isTTY` is undefined rather than false on a pipe, hence the coercion.
    this.isTty = Boolean(this.stream.isTTY) && !this.quiet;
  }

  banner(title: string, subtitle: string): void {
    if (this.quiet) return;
    this.write(`\n  ${pc.bold(pc.cyan(title))}  ${pc.dim(subtitle)}\n\n`);
  }

  start(total: number): void {
    this.total = total;
    if (!this.isTty || this.timer) return;
    // Repaint on a timer so video progress advances even between ffmpeg ticks.
    this.timer = setInterval(() => this.paint(), 100);
    this.timer.unref();
  }

  handle(event: ProgressEvent): void {
    if (this.quiet) return;

    switch (event.type) {
      case "run-start":
        this.start(event.total);
        break;
      case "job-start":
        this.active.set(event.job.inputPath, { job: event.job, ratio: 0 });
        break;
      case "job-progress": {
        const entry = this.active.get(event.job.inputPath);
        if (entry) entry.ratio = event.ratio;
        break;
      }
      case "job-done":
        this.active.delete(event.job.inputPath);
        this.completed++;
        // Without a TTY there is no live region to update, so completed files
        // are simply appended as they land. This is also the nicer CI log.
        if (!this.isTty) this.write(`${plainLine(event.result)}\n`);
        break;
    }

    if (this.isTty) this.paint();
  }

  private paint(): void {
    if (!this.isTty) return;

    this.clear();
    const lines: string[] = [];

    const done = Math.min(this.completed, this.total);
    lines.push(
      `  ${overallBar(done, this.total)} ${pc.bold(`${done}/${this.total}`)} files`,
    );

    for (const { job, ratio } of [...this.active.values()].slice(0, 8)) {
      const name = padEnd(basename(job.inputPath), 32);
      const bar = job.kind === "video" ? fileBar(ratio) : pc.dim("encoding…");
      lines.push(`    ${pc.dim(name)} ${bar}`);
    }

    this.write(lines.join("\n") + "\n");
    this.linesDrawn = lines.length;
  }

  private clear(): void {
    if (!this.isTty || this.linesDrawn === 0) return;
    this.stream.moveCursor(0, -this.linesDrawn);
    this.stream.clearScreenDown();
    this.linesDrawn = 0;
  }

  /** Tear down the live region before printing anything final. */
  finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
  }

  summary(report: CompressionReport): void {
    if (this.quiet) return;
    this.finish();

    const { summary, results } = report;

    // Without a TTY each file was already printed as it finished, so repeating
    // the list here would just double every line in the log. Skipped files are
    // included: "1 skipped" with no indication of which file, or why, is the
    // kind of summary that sends someone hunting through the output directory.
    const rows = this.isTty
      ? results
      : results.filter((r) => r.status === "skipped" && report.dryRun);

    if (rows.length > 0) this.write("\n");
    for (const result of rows) {
      this.write(`  ${detailLine(result)}\n`);
      // Anything the target container could not carry is named here, so a lost
      // subtitle or commentary track is never a silent surprise.
      const warnings = "warnings" in result ? (result.warnings ?? []) : [];
      for (const warning of warnings) {
        this.write(`    ${pc.yellow("!")} ${pc.dim(warning)}\n`);
      }
    }

    const failures = results.filter((r) => r.status === "failed");
    if (failures.length > 0) {
      this.write(`\n  ${pc.bold(pc.red("Failures"))}\n`);
      for (const failure of failures) {
        if (failure.status !== "failed") continue;
        this.write(
          `    ${pc.red("✗")} ${basename(failure.inputPath)} ${pc.dim(`[${failure.error.code}]`)}\n`,
        );
        for (const line of failure.error.message.split("\n")) {
          this.write(`      ${pc.dim(line)}\n`);
        }
      }
    }

    if (report.dryRun) {
      this.write(
        `\n  ${pc.bold(pc.yellow("Dry run"))} ${pc.dim(`— ${summary.totalFiles} file(s) planned, nothing written.`)}\n\n`,
      );
      return;
    }

    const saved = summary.savedBytes;
    const tone = saved > 0 ? pc.green : saved < 0 ? pc.red : pc.dim;

    this.write(`\n  ${pc.dim("─".repeat(58))}\n`);
    this.write(
      `  ${pc.bold("Total")}   ` +
        `${pc.dim(formatBytes(summary.inputBytes))} ${pc.dim("→")} ${pc.bold(formatBytes(summary.outputBytes))}   ` +
        `${tone(pc.bold(`${saved >= 0 ? "−" : "+"}${formatBytes(Math.abs(saved))}`))} ` +
        `${tone(`(${formatPercent(Math.abs(summary.savedRatio))})`)}\n`,
    );

    const parts = [
      `${summary.compressed} compressed`,
      summary.skipped > 0 ? `${summary.skipped} skipped` : null,
      summary.failed > 0 ? pc.red(`${summary.failed} failed`) : null,
      formatDuration(summary.durationMs),
    ].filter((p): p is string => p !== null);

    this.write(`  ${pc.dim(parts.join(pc.dim(" · ")))}\n\n`);
  }

  error(message: string, code?: string): void {
    this.finish();
    const tag = code ? pc.dim(` [${code}]`) : "";
    this.write(`\n  ${pc.bold(pc.red("Error"))}${tag}\n`);
    for (const line of message.split("\n")) {
      this.write(`  ${line}\n`);
    }
    this.write("\n");
  }

  warn(message: string): void {
    if (this.quiet) return;
    this.write(`  ${pc.yellow("!")} ${pc.yellow(message)}\n`);
  }

  note(message: string): void {
    if (this.quiet) return;
    this.write(`  ${pc.dim(message)}\n`);
  }

  private write(text: string): void {
    this.stream.write(text);
  }
}

function overallBar(done: number, total: number): string {
  const width = 24;
  const ratio = total === 0 ? 0 : done / total;
  const filled = Math.round(ratio * width);
  return pc.cyan("█".repeat(filled)) + pc.dim("░".repeat(Math.max(0, width - filled)));
}

function fileBar(ratio: number): string {
  const width = 16;
  const filled = Math.round(ratio * width);
  return (
    pc.green("█".repeat(filled)) +
    pc.dim("░".repeat(Math.max(0, width - filled))) +
    pc.dim(` ${padStart(`${Math.round(ratio * 100)}%`, 4)}`)
  );
}

/** One-line-per-file output for non-TTY streams: greppable, no escape codes. */
function plainLine(result: JobResult): string {
  switch (result.status) {
    case "compressed": {
      const notes = (result.warnings ?? []).map((w) => `\n  warn    ${w}`).join("");
      return `  ok      ${basename(result.inputPath)} → ${basename(result.outputPath)}  ${formatBytes(result.inputBytes)} → ${formatBytes(result.outputBytes)} (${formatPercent(result.savedRatio)})${notes}`;
    }
    case "skipped": {
      const notes = (result.warnings ?? []).map((w) => `\n  warn    ${w}`).join("");
      return `  skip    ${basename(result.inputPath)}  (${result.reason})${notes}`;
    }
    case "failed":
      return `  FAIL    ${basename(result.inputPath)}  [${result.error.code}] ${result.error.message.split("\n")[0] ?? ""}`;
  }
}

function detailLine(result: JobResult): string {
  const name = padEnd(basename(result.inputPath), 34);

  switch (result.status) {
    case "compressed": {
      const grew = result.savedBytes < 0;
      const tone = grew ? pc.red : pc.green;
      const arrow = `${pc.dim(formatBytes(result.inputBytes))} ${pc.dim("→")} ${formatBytes(result.outputBytes)}`;
      return `${pc.green("✓")} ${name} ${padStart(arrow, 30)}  ${tone(`${grew ? "+" : "−"}${formatPercent(Math.abs(result.savedRatio))}`)}`;
    }
    case "skipped":
      return `${pc.yellow("○")} ${name} ${pc.dim(skipLabel(result.reason))}`;
    case "failed":
      return `${pc.red("✗")} ${name} ${pc.red(result.error.code)}`;
  }
}

function skipLabel(reason: string): string {
  switch (reason) {
    case "output-larger-than-input":
      return "skipped — compressing made it bigger, original kept";
    case "output-exists":
      return "skipped — output exists (use --overwrite)";
    case "dry-run":
      return "planned";
    default:
      return reason;
  }
}
