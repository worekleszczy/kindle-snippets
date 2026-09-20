#!/usr/bin/env bun
import { EXIT_OK, EXIT_USAGE, usage } from "./args";

// Kept in step with package.json by `bun run verify` (see version.test.ts).
export const VERSION = "0.1.0";

const USAGE = `kindle-sync — Kindle snippets sync

Usage:
  kindle-sync help
  kindle-sync version

Exit codes: 0 success, 1 runtime failure, 2 usage error.
`;

// run is the whole CLI: argv in, exit code out, nothing process-global. main()
// only runs when this file is executed directly, so tests drive run() without
// the process exiting underneath them.
export async function run(args: string[]): Promise<number> {
  const [cmd, ..._rest] = args;

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return EXIT_OK;

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return EXIT_OK;

    case undefined:
      console.error(USAGE);
      return EXIT_USAGE;

    default:
      return usage(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
