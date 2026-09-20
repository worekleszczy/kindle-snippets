# clipping-query Specification

## Purpose
TBD - created by archiving change add-clipping-sync-store. Update Purpose after archive.
## Requirements
### Requirement: Query filters

`query` SHALL accept `--book <id>`, `--since <commit>` and `--books`,
independently or in combination, and SHALL accept none of them. It SHALL
reject any other flag as a usage error. Timestamp-range filtering is out of
scope.

#### Scenario: No filters

- **WHEN** `query` runs with no filters
- **THEN** every clipping in the store is emitted

#### Scenario: Book filter

- **WHEN** `query --book the-silent-ledger` runs
- **THEN** only clippings under `books/the-silent-ledger/` are emitted

#### Scenario: Cursor filter

- **WHEN** `query --since <commit>` runs
- **THEN** only clippings whose files changed between that commit and `HEAD`
  are emitted

#### Scenario: Both filters

- **WHEN** `query --book the-silent-ledger --since <commit>` runs
- **THEN** only changed clippings belonging to that book are emitted

#### Scenario: Unsupported filter

- **WHEN** `query --after 2026-01-01` runs
- **THEN** the command reports an unknown flag and exits `2`

#### Scenario: Unknown book

- **WHEN** `query --book the-silent-ledgerr` names a book that does not exist in
  the store
- **THEN** the command reports the unknown identifier and exits `1`, so that a
  typo cannot be mistaken for an empty book

### Requirement: Book records are queryable

`query --books` SHALL emit book records rather than clippings, and SHALL
combine with `--since` and `--book`.

#### Scenario: Listing books

- **WHEN** `query --books` runs
- **THEN** one object per book is emitted, each carrying the book's
  `schemaVersion`, `id`, `title`, `author` and `sources`

#### Scenario: Changed books since a cursor

- **WHEN** `query --books --since <commit>` runs and a book's `sources` gained
  a title line after that commit
- **THEN** that book is emitted with `op: "modify"`

### Requirement: Cursor resolution

A cursor SHALL be a commit identifier in the store repository. `query --since`
SHALL resolve changes via `git diff --name-status <commit>..HEAD` over the
store's record paths.

#### Scenario: Cursor equals HEAD

- **WHEN** the supplied commit is the store's current `HEAD`
- **THEN** nothing is emitted and the command exits `0`

#### Scenario: Unknown commit

- **WHEN** the supplied commit does not exist in the store repository
- **THEN** the command reports the failure and exits `1`

#### Scenario: Commit no longer reachable

- **WHEN** the supplied commit exists but is not an ancestor of `HEAD`
- **THEN** the command reports that the cursor is not reachable from `HEAD` and
  exits `1`, rather than emitting a misleading changeset

### Requirement: Output format

`query` SHALL write JSON Lines to stdout, one object per record, each carrying
`schemaVersion`. Diagnostics SHALL go to stderr so stdout stays
machine-readable.

#### Scenario: One object per line

- **WHEN** `query --book the-quiet-test` emits 18 clippings
- **THEN** stdout contains 18 lines, each a complete JSON object with a
  `schemaVersion` field

#### Scenario: Empty result

- **WHEN** a query matches nothing
- **THEN** stdout is empty and the command exits `0`

### Requirement: Output order is deterministic

Emitted records SHALL be ordered by book identifier, then by timestamp, then by
clipping identifier, so that two runs over an unchanged store produce
byte-identical output.

#### Scenario: Repeated query

- **WHEN** the same query runs twice against an unchanged store
- **THEN** both runs emit identical bytes on stdout

### Requirement: Cursor queries carry operations

When `--since` is supplied, every emitted object SHALL carry an `op` of `add`,
`modify` or `delete`, derived from the git status of its file. A `delete`
object SHALL carry exactly `schemaVersion`, `op`, `id`, `book` and `kind`.

#### Scenario: New clipping since the cursor

- **WHEN** a clipping file was added after the cursor commit
- **THEN** its object carries `op: "add"` and the full record

#### Scenario: Enriched clipping since the cursor

- **WHEN** a clipping file was modified after the cursor commit
- **THEN** its object carries `op: "modify"` and the full current record

#### Scenario: Superseded clipping since the cursor

- **WHEN** a highlight was collapsed into a longer one after the cursor commit
- **THEN** the consumer receives a `delete` for the old identifier and an `add`
  for the new one, and the new record's `supersedes` names the old identifier

#### Scenario: Delete object carries no body

- **WHEN** a `delete` op is emitted
- **THEN** the object contains no `text`, `location`, `timestamp` or `page`
  field

#### Scenario: Ops are absent without a cursor

- **WHEN** `query` runs without `--since`
- **THEN** emitted objects carry no `op` field

### Requirement: Current cursor is discoverable

`query --cursor` SHALL print the store's current `HEAD` commit identifier and
nothing else, so a consumer can record the point it has consumed up to.

#### Scenario: Reading the cursor

- **WHEN** `query --cursor` runs
- **THEN** stdout contains the store's `HEAD` commit identifier on one line and
  the command exits `0`

#### Scenario: Empty store

- **WHEN** `query --cursor` runs against a store with no commits
- **THEN** the command reports that the store has no history and exits `1`

### Requirement: Unknown schema versions are refused

`query` SHALL refuse to read a store whose `meta.yaml` declares a
`schemaVersion` it does not recognise, rather than emitting records it may be
misreading.

#### Scenario: Store written by a newer version

- **WHEN** the store's `schemaVersion` is higher than the binary supports
- **THEN** `query` reports the mismatch and exits `1` without emitting records

### Requirement: History stability is a published contract

The store's git history SHALL NOT be rewritten past any commit a consumer may
hold as a cursor. This constraint SHALL be documented for whoever operates the
store.

#### Scenario: Documented constraint

- **WHEN** the store's operating documentation is read
- **THEN** it states that rebasing, amending or garbage-collecting history past
  a published cursor invalidates consumers' cursors

### Requirement: Query does not mutate the store

`query` SHALL be read-only. It SHALL NOT write files, create commits, or alter
the store's working tree or index.

#### Scenario: Store is unchanged after a query

- **WHEN** any `query` invocation completes
- **THEN** the store's `HEAD`, working tree and index are unchanged

