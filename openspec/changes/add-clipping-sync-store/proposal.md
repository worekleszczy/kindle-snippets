## Why

Kindle highlights accumulate only in `My Clippings.txt` on the device, a
single append-only file that the device can wipe at any time and that no other
tool can read incrementally. A real sample of that file (1342 records, 20
books, Feb 2024 – Jul 2026) shows the data is also lossy as written: 172
highlights are stale re-highlights of text that a later record supersedes, and
139 notes are stored as free-floating records that name a location but not the
highlight they belong to.

This change turns that file into a durable, git-backed store that other tooling
can pull from incrementally by commit id.

## What Changes

- **New `kindle-sync sync` command.** Parses `My Clippings.txt`, derives book
  and clipping identity, consolidates superseded highlights over the union of
  the store and the source, attaches notes to their highlights, writes one YAML
  file per clipping into a git-backed store, and commits. Re-running against
  input that changes nothing produces no commit. `--dry-run` prints the
  changeset without writing.
- **New `kindle-sync query` command.** Reads the store. Supports `--book <id>`,
  `--since <commit>`, `--books`, `--cursor`, and combinations. Emits JSON Lines
  carrying a `schemaVersion` and, for cursor queries, explicit
  `add`/`modify`/`delete` ops resolved from `git diff`.
- **New store format.** `books/<bookId>/book.yaml` plus
  `books/<bookId>/clippings/<local-date>--<id>.yaml`, with the source file
  committed verbatim under `source/` so consolidation stays reversible.
- **Sync is additive.** A clipping in the store but absent from the source is
  retained; the only deletion is a highlight that consolidation supersedes. A
  device wipe therefore cannot empty the store.
- **New dependency on the `git` binary** at runtime, invoked via `Bun.spawn`.
  Not an npm dependency, but a new external requirement that needs a dated
  entry in `tech.md`.
- **New use of `Bun.YAML`** for reading and writing store files. Keeps the
  zero-runtime-dependency rule intact but pins a minimum Bun version.
- **The real clippings sample is committed** as `src/fixtures/my-clippings.txt`
  so the specs' counts are directly assertable.

No existing behaviour changes. `help` and `version` are untouched.

## Capabilities

### New Capabilities

- `clippings-parsing`: Decoding `My Clippings.txt` into typed records —
  record splitting, per-record BOM handling, the metadata grammar (kind, page,
  location range, timestamp), and classification of empty and DRM-limit
  records. Must be total: every record in the source either parses or is
  reported as a failure, never silently skipped.
- `clipping-identity`: Deriving stable identifiers. `bookId` from the first
  four words of the title; `clippingId` from a SHA-256 over book, kind,
  location range and the verbatim local timestamp. Both must be pure functions
  of the records with no configuration input, so the same records always
  produce the same paths.
- `clipping-consolidation`: The two derivations that reduce the record set,
  computed over the union of stored and newly parsed records — collapsing a
  highlight into a later one that contains its text within an overlapping
  location range, and attaching each note to exactly one highlight by narrowest
  containing range, then nearest timestamp, then smallest identifier.
- `clipping-store`: The git-backed store on disk — directory layout, YAML
  record schema, additive write semantics, preconditions, commit message shape,
  and the guarantee that unchanged input produces no commit.
- `clipping-query`: The read surface and its contract with external consumers
  — book, cursor and book-record filters, deterministic ordering, the JSON
  Lines output shape, op semantics for cursor queries, and the history-stability
  guarantee that makes a commit id usable as a cursor.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first set of capabilities in the
repo.

## Impact

**New modules** in `src/`, each with a colocated test, per the one-module-per-
command convention:

| Module | Covers |
| --- | --- |
| `src/clippings.ts` | parsing `My Clippings.txt` into records |
| `src/identity.ts` | `bookId` and `clippingId` derivation |
| `src/consolidate.ts` | highlight collapse and note attachment |
| `src/store.ts` | store layout, YAML read/write, git invocation |
| `src/sync.ts` | the `sync` command |
| `src/query.ts` | the `query` command |

**Modified**: `src/cli.ts` gains two dispatch cases and usage text.
`README.md` gains the two commands and the store contract. `tech.md` gains a
dated entry for the `git` binary dependency and the `Bun.YAML` choice.
`package.json` gains an `engines.bun` floor.

**New fixture**: `src/fixtures/my-clippings.txt`, the real 636 KB sample,
committed so the counts in the specs are assertable.

**External**: requires `git` on `PATH` and a store repository initialised
outside this repo, with a resolvable commit identity. The store repo's history
must never be rewritten past a commit a consumer holds as a cursor — this is a
published contract, not an implementation detail.

**Not in scope**: chapter information (absent from the source file entirely —
the schema reserves a nullable field for later enrichment), a `prune` command,
pushing the store to a remote, syncing from more than one device, merging two
books that arrive under different title strings, and timestamp-range queries.
