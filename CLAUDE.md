# kindle-sync — repo conventions

CLI tool, Bun runtime, compiled to a single binary. Technology decisions and
their reasoning live in [tech.md](tech.md) — read it before changing the stack,
and append a dated entry when you do.

## Rules

- **No runtime dependencies.** Bun APIs and `node:` builtins only. Adding one
  is a decision: it needs a dated entry in `tech.md` explaining what it buys.
  devDependencies (Biome, TypeScript, `@types/bun`) are not covered by this.
- **Flags are parsed by hand** with the helpers in `src/args.ts`
  (`flagValue`, `positionals`, `checkFlags`, …). Do not add a parser library.
- **One module per command**, flat in `src/`, with its test colocated as
  `src/<name>.test.ts`. A module that outgrows a single purpose gets split.
- **`src/cli.ts` only dispatches.** It exports `run(argv): Promise<number>`
  and calls `process.exit` only under `if (import.meta.main)`. Command logic
  lives in its own module so it can be tested without the process exiting.
- **Exit codes:** `0` success, `1` runtime failure, `2` usage error. Return
  them; do not call `process.exit` outside `cli.ts`. Report errors through
  `usage()` / `failure()` in `src/args.ts` so every message is prefixed
  `kindle-sync:` and goes to stderr.
- **Never swallow an error.** No empty `catch`, no fallback that hides a
  failure. If a step cannot be completed, say what failed and return `1`.
- **`noUncheckedIndexedAccess` is on** and `noNonNullAssertion` is enforced:
  guard indexed reads with an explicit `undefined` check rather than `!`.

## Before calling work done

```sh
bun run verify     # tsc --noEmit, biome check, bun test
```

All three must pass. There is no CI — this command is the only gate.

## Layout

| Path | Purpose |
| --- | --- |
| `src/cli.ts` | Usage text, dispatch, `run()` |
| `src/args.ts` | Flag helpers, exit codes, error reporting |
| `link.sh` | Build if needed, symlink binary to `/usr/local/bin` |
| `tech.md` | Dated log of technology decisions |
