#!/usr/bin/env bun
import { EXIT_OK, EXIT_USAGE, usage } from "./args";
import { query } from "./query";
import { DEFAULT_SOURCE, sync } from "./sync";

// Kept in step with package.json by `bun run verify` (see version.test.ts).
export const VERSION = "0.1.0";

const USAGE = `kindle-sync — Kindle snippets sync

Usage:
  kindle-sync sync  [--source <path>] --store <path> [--timezone <zone>] [--dry-run]
  kindle-sync query --store <path> [--book <id>] [--since <commit>] [--books]
  kindle-sync query --store <path> --cursor
  kindle-sync help
  kindle-sync version

sync   Parses My Clippings.txt, consolidates it against everything the store
       already holds, writes one YAML file per clipping and commits. Additive:
       the only clipping it deletes is one a longer highlight supersedes, and a
       run that changes nothing creates no commit. --dry-run prints the
       changeset and writes nothing.

query  Reads the store as JSON Lines on stdout. --since <commit> emits only
       what changed after that commit, each object carrying an op of add,
       modify or delete. --cursor prints the store's HEAD, which is the commit
       to pass to a later --since.

Locations:
  --source  falls back to KINDLE_SYNC_SOURCE, then ${DEFAULT_SOURCE}
  --store   falls back to KINDLE_SYNC_STORE; it has no default

Exit codes: 0 success, 1 runtime failure, 2 usage error.
`;

// run is the whole CLI: argv in, exit code out, nothing process-global. main()
// only runs when this file is executed directly, so tests drive run() without
// the process exiting underneath them.
export async function run(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case "sync":
      return await sync(rest);

    case "query":
      return await query(rest);

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
