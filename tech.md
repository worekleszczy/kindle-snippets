# kindle-sync — technology decisions

Dated entries. Where this file and older docs disagree, the newer entry wins.

## 2026-09-20 — Bootstrap: Bun, compiled binary, zero runtime dependencies

### Context

New repo for a CLI that runs on a developer machine. The sibling tool
`../focusmux` already solves the same shape of problem, so its stack is the
default unless there is a reason to deviate.

### Decisions

**Runtime: Bun.** Runs TypeScript directly (no build step in development),
ships a test runner, and compiles to a self-contained binary. Cost: Bun-specific
APIs and `bun:test` make a move to Node a rewrite of the edges, not a
recompile. Accepted — this is a personal-machine tool, not a library.

**Distribution: `bun build --compile` + `link.sh`.** The binary is
self-contained, so the machine needs no Node or Bun at runtime. It is ~60 MB and
architecture-specific, therefore gitignored; each machine runs `bun run build`
and `sudo ./link.sh`. Rejected: publishing to npm — no second consumer to
justify the release process.

**Zero runtime dependencies.** Flag parsing is hand-rolled in `src/args.ts`
(ported from focusmux); everything else comes from Bun and `node:` builtins.
Keeps the binary small and the supply chain empty, at the cost of writing help
text and validation by hand. Rejected: citty/commander — a CLI framework earns
its place at a scale this tool has not reached. Adding a runtime dependency
later is a decision that belongs in this file.

**TypeScript strict, plus a typecheck gate.** `strict`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noEmit`.
Bun strips types without checking them, so `typescript` is a devDependency and
`bun run typecheck` runs `tsc --noEmit`. Deviation from focusmux, which has no
typecheck gate and therefore does not enforce the strict mode it configures.

**Biome for lint and format.** One binary, one config file, no plugin
ecosystem. Deviation from focusmux, which has neither. `noNonNullAssertion`
overlaps with the `noUncheckedIndexedAccess` idiom — the index loops carry an
explicit `undefined` guard instead of `!`, so the rule stays on. `lineWidth`
100 makes the test files repo-specific: `src/args.test.ts:66` sits at 99
characters with `"sync"` as the `checkFlags` label, so copying this repo's
tests into a sibling whose command name is two or more characters longer fails
`biome check` until `bun run fix` rewraps them. (Found by the spec-reviewer
repo, which hit it at 108.)

**Tests: `bun test`, colocated.** `src/foo.test.ts` sits next to `src/foo.ts`.
No CI — `bun run verify` is the gate, run locally. Cost: nothing catches a
broken `main` except the next person to run it. Revisit if a second person ever
uses this repo.

**CLI shape: `run(argv) → exit code`.** `src/cli.ts` exports `run`, and calls
`process.exit` only under `if (import.meta.main)`. Deviation from focusmux,
whose `cli.ts` runs `main()` at import time — that is why its `args.ts` had to
be split out, and why its dispatch cannot be tested directly.

**Exit codes: 0 success, 1 runtime failure, 2 usage error.** Errors go to
stderr prefixed `kindle-sync:`, via `usage()` and `failure()` in `src/args.ts`.

**Name: `kindle-sync`.** Binary, package name and error prefix. The repo
directory stays `kindle-snippets-sync`.
