/**
 * Executable entry point. The shebang is prepended by tsup's `banner`, so it
 * must not also appear here or the bundle ends up with two of them.
 *
 * Kept separate from `main.ts` so that importing the program builder from tests
 * never parses argv or sets an exit code as a side effect. Detecting "am I the
 * main module?" from inside main.ts is unreliable once npm installs the bin as
 * a symlink, since argv[1] is then the link and import.meta.url is the target.
 */
import { main } from "./main.js";

process.exitCode = await main();
