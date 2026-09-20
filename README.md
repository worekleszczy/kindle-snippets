# kindle-sync

Kindle snippets sync CLI. Single self-contained binary, no runtime
dependencies.

Technology choices and the reasoning behind them: [tech.md](tech.md).
Repo conventions for contributors and agents: [CLAUDE.md](CLAUDE.md).

## Build & install

```sh
bun install
bun run verify     # typecheck + lint + tests
bun run build      # → ./kindle-sync (self-contained binary)
sudo ./link.sh     # symlink to /usr/local/bin/kindle-sync
```

The binary is architecture-specific and gitignored — each machine builds its
own.

## Usage

```sh
kindle-sync sync  [--source <path>] --store <path> [--timezone <zone>] [--dry-run]
kindle-sync query --store <path> [--book <id>] [--since <commit>] [--books]
kindle-sync query --store <path> --cursor
kindle-sync help
kindle-sync version
```

Exit codes: `0` success, `1` runtime failure, `2` usage error.

Both commands need the `git` binary on `PATH` and a store repository that
already exists, with a resolvable commit identity.

### `sync`

Parses `My Clippings.txt`, derives book and clipping identifiers, consolidates
superseded highlights over the union of the store and the source, attaches each
note to a highlight, writes one YAML file per clipping and commits.

| Flag | Falls back to | Meaning |
| --- | --- | --- |
| `--source <path>` | `KINDLE_SYNC_SOURCE`, then `/Volumes/Kindle/documents/My Clippings.txt` | The device file to read |
| `--store <path>` | `KINDLE_SYNC_STORE`; **no default** | The store repository to write |
| `--timezone <zone>` | the system IANA zone | Recorded once in `meta.yaml` as documentation; nothing reads it back |
| `--dry-run` | — | Print the changeset, write nothing, make no commit |

A run against input that changes nothing reports `nothing changed` and creates
no commit.

### `query`

Reads the store and writes JSON Lines to stdout — one object per record, each
carrying `schemaVersion`. Diagnostics go to stderr.

| Flag | Meaning |
| --- | --- |
| `--store <path>` | The store repository; falls back to `KINDLE_SYNC_STORE` |
| `--book <id>` | Only clippings of that book; an unknown identifier exits `1` |
| `--since <commit>` | Only what changed after that commit; every object carries `op` |
| `--books` | Emit book records instead of clippings |
| `--cursor` | Print the store's `HEAD` and nothing else |

`--since` maps `git diff --name-status <commit>..HEAD` onto ops: `add`,
`modify` and `delete`. A `delete` object carries only `schemaVersion`, `op`,
`id`, `book` and `kind`. Output is ordered by book identifier, then timestamp,
then clipping identifier, so two runs over an unchanged store produce identical
bytes.

```sh
cursor=$(kindle-sync query --store "$STORE" --cursor)
kindle-sync sync --store "$STORE"
kindle-sync query --store "$STORE" --since "$cursor"
```

## The store

```
meta.yaml                                             schemaVersion, sourceTimezone
source/My Clippings.txt                               the device file, verbatim
books/<bookId>/book.yaml                              id, title, author, sources
books/<bookId>/clippings/<YYYY-MM-DD>--<id>.yaml      one clipping
```

- `bookId` is the first four words of the title line, author parenthetical
  stripped, `-` and `_` treated as separators, ASCII-folded and lowercased.
- The clipping identifier is the first 12 hex characters of a SHA-256 over the
  book, kind, location range and local timestamp. Text is deliberately excluded,
  so correcting a text later is a `modify` rather than a delete and an add.
- The filename date is the record's **local** date as the source file states it.
  No timezone conversion is applied anywhere, so the same file syncs to the same
  paths on any machine.
- `chapter` is present and always null: `My Clippings.txt` carries no chapter
  information.

### Operating contract

- **History must never be rewritten past a commit a consumer holds as a
  cursor.** Rebasing, amending or garbage-collecting past that point
  invalidates consumers' cursors. `query --since` checks that the cursor is an
  ancestor of `HEAD` and exits `1` rather than emitting a misleading changeset.
- **Sync is additive.** A clipping in the store but absent from the source is
  retained, so a device reset cannot empty the store. The only file a sync
  deletes is a highlight that consolidation superseded, and the survivor names
  it in `supersedes`.
- **Removal is manual.** Deleting a clipping means editing the store and
  committing it yourself; there is no `prune` command.
- **An extended highlight reaches a consumer as a delete plus an add**, because
  collapse discards the superseded identifier. `supersedes` on the survivor is
  what reconnects the two.
- The store must be clean before a sync: uncommitted changes, a missing commit
  identity or a store whose `meta.yaml` declares an unknown `schemaVersion` are
  each reported on their own and exit `1` before anything is written.

## Development

| Command | What it does |
| --- | --- |
| `bun test` | Run the colocated `*.test.ts` files |
| `bun run typecheck` | `tsc --noEmit` — Bun does not typecheck on its own |
| `bun run check` | Biome lint + format check |
| `bun run fix` | Biome, applying safe fixes |
| `bun run verify` | All three, in order |

The test fixture `src/fixtures/clippings.txt` is an obfuscated extract of a real
clippings file — real structure, synthetic words and titles — built by
`scripts/obfuscate.ts` together with the constructed cases in
`scripts/fixture-cases.txt`. A real `My Clippings.txt` is gitignored and must
never be committed.
