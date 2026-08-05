import type { ErrorCode, JobFailure } from "../types/results.js";

/**
 * Every failure this library raises carries a stable {@link ErrorCode}.
 *
 * Agents and scripts consuming `--json` need something to branch on that is not
 * a human-readable sentence, since those get reworded. Codes never change
 * meaning once shipped.
 */
export class CompressorError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CompressorError";
    this.code = code;
    this.detail = detail;
  }

  toFailure(): JobFailure {
    return this.detail === undefined
      ? { message: this.message, code: this.code }
      : { message: this.message, code: this.code, detail: this.detail };
  }
}

/** Coerce an unknown thrown value into a structured failure. */
export function toFailure(err: unknown): JobFailure {
  if (err instanceof CompressorError) return err.toFailure();

  if (err instanceof Error) {
    const code = mapNodeErrno((err as NodeJS.ErrnoException).code);
    return { message: err.message, code };
  }

  return { message: String(err), code: "UNKNOWN" };
}

function mapNodeErrno(errno: string | undefined): ErrorCode {
  switch (errno) {
    case "ENOENT":
      return "INPUT_NOT_FOUND";
    case "EACCES":
    case "EPERM":
      return "PERMISSION_DENIED";
    default:
      return "UNKNOWN";
  }
}
