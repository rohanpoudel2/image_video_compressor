const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte sizes. Negative values are rendered with a leading `-`. */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  const decimals = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${sign}${value.toFixed(decimals)} ${UNITS[unit]}`;
}

/** A 0-1 ratio as a percentage. */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Shorten a path to fit a column, keeping the filename readable.
 *
 * Truncating from the left preserves the part that distinguishes one file from
 * another; chopping the tail would leave a column of identical prefixes.
 */
export function truncatePath(path: string, max: number): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

/** Pad to an exact display width, truncating when the text is too long. */
export function padEnd(text: string, width: number): string {
  return text.length > width ? truncatePath(text, width) : text.padEnd(width, " ");
}

export function padStart(text: string, width: number): string {
  return text.padStart(width, " ");
}
