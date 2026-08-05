/**
 * stdio entry point.
 *
 * The shebang comes from the tsup banner, matching the root CLI build — adding
 * one here too would emit it twice and the file would not parse.
 *
 * stdout is the JSON-RPC channel and nothing else may touch it. The library is
 * safe here — it writes no stdout of its own, and the CLI renderer that does
 * print is not used by this server — but anything added later must log to
 * stderr, or it will corrupt the protocol stream.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(
    `image-and-video-compressor-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
