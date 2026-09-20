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

## 2026-09-20 — Clipping store: the `git` binary, `Bun.YAML`, and a hand-rolled emitter

### Context

`kindle-sync sync` turns `My Clippings.txt` into a git-backed store of one YAML
file per clipping, and `kindle-sync query` reads it, using a commit id as an
incremental cursor. That needs a version-controlled store and a record format.

### Decisions

**`git` as a runtime requirement, invoked through `Bun.spawn`.** The store is a
git repository outside this repo; `sync` stages and commits, and `query --since`
resolves a cursor through `git diff --name-status <commit>..HEAD`. All calls go
through one wrapper in `src/store.ts` that treats a non-zero exit as a failure
carrying stderr. This is not an npm dependency — the zero-runtime-dependency
rule is intact — but it is a new external requirement: the machine needs `git`
on `PATH` and a resolvable commit identity in the store repository. Rejected: a
JavaScript git implementation (`isomorphic-git`), a large runtime dependency for
operations the binary already does correctly.

**YAML as the record format, parsed with `Bun.YAML.parse`.** Ships with the
runtime, so it costs no dependency, and it keeps a 10 KB highlight readable in a
`git diff`. This pins a minimum Bun version, recorded as `engines.bun` in
`package.json`. Rejected: JSON (unreadable diffs for long text), and one file per
book (a single-clipping change would rewrite a 400-record file, which breaks the
cursor contract that maps one file to one clipping).

**Writing is a hand-rolled emitter, not `Bun.YAML.stringify`.** As of Bun 1.3.14
`Bun.YAML.stringify` emits flow style on a single line — `{schemaVersion: 1,id:
abc}` — which defeats both the diff-readability argument above and the
byte-stability the store needs. `src/store.ts` emits the fixed record schema
itself: fixed key order, block scalar for text where it is safe and a
double-quoted scalar otherwise, and `Bun.YAML.parse` on the way back in.
Revisit if a later Bun ships a block-style `stringify`.

**The real `My Clippings.txt` is never committed.** It is gitignored, and the
test fixture is an obfuscated extract built by `scripts/obfuscate.ts` plus the
deliberately constructed cases in `scripts/fixture-cases.txt`. Rejected:
committing the real file — 1342 personal highlights in the history permanently.
