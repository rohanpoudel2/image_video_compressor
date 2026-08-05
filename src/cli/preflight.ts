/**
 * Must be imported before picocolors.
 *
 * picocolors decides whether to emit escape codes once, at import time, so
 * `--no-color` has to be honoured before that module is evaluated. ESM
 * evaluates dependencies in source order, which makes importing this first a
 * reliable way to get in ahead of it.
 */
if (process.argv.includes("--no-color")) {
  process.env["NO_COLOR"] = "1";
}
export {};
