## ADDED Requirements

### Requirement: Store layout

The store SHALL be a git repository outside this project with the layout:

```
meta.yaml
source/My Clippings.txt
books/<bookId>/book.yaml
books/<bookId>/clippings/<YYYY-MM-DD>--<clippingId>.yaml
```

The clipping filename date SHALL be the record's local date exactly as the
source file states it, with no timezone conversion.

#### Scenario: Clipping file path

- **WHEN** a highlight in book `the-silent-ledger` has timestamp
  `2026-01-02 19:13:49` and identifier `7c4e2a91b3d0`
- **THEN** it is written to
  `books/the-silent-ledger/clippings/2026-01-02--7c4e2a91b3d0.yaml`

#### Scenario: Path derives only from the record

- **WHEN** the same record is written on machines in different timezones
- **THEN** it lands at the identical path

### Requirement: Clipping record schema

Each clipping file SHALL be a YAML document carrying `schemaVersion`, `id`,
`kind`, `book`, `timestamp` as the verbatim zone-less local value, `page` as a
string or null, `location` with `lo` and `hi`, `text` as a string, `chapter` as
null, and the boolean flags `empty` and `drmLimited`. A highlight SHALL carry
`supersedes` as a possibly empty sorted list. A note SHALL carry `attachedTo`
holding a clipping identifier or null.

#### Scenario: Highlight record

- **WHEN** a consolidated highlight is written
- **THEN** its file contains `schemaVersion`, `id`, `kind: highlight`, `book`,
  `timestamp`, `page`, `location`, `text`, `chapter: null`, `empty`,
  `drmLimited` and `supersedes`

#### Scenario: Note record

- **WHEN** a note is written
- **THEN** its file contains `kind: note` and `attachedTo` holding either a
  highlight identifier or null

#### Scenario: Bookmark record

- **WHEN** a bookmark is written
- **THEN** its file contains `kind: bookmark`, `text` as the empty string and
  `empty: true`

#### Scenario: Record without a page

- **WHEN** the source metadata line carried no page field
- **THEN** the record's `page` is null

#### Scenario: Roman-numeral page survives to the store

- **WHEN** the source metadata line carried `on page xxvii`
- **THEN** the record's `page` is the string `"xxvii"`

#### Scenario: Chapter field is reserved

- **WHEN** any clipping is written by `sync`
- **THEN** `chapter` is present and null, because the source file carries no
  chapter information

### Requirement: Book record schema

Each `book.yaml` SHALL carry `schemaVersion`, `id`, `title`, `author` as a
single verbatim string or null, and `sources` listing every distinct raw title
line that has ever resolved to this book, sorted.

#### Scenario: Book written with its source title

- **WHEN** book `opowiesc-o-zazolconej-gesli` is written
- **THEN** its `title` is `Opowieść. O zażółconej gęśli jaźni`, its `author` is
  `Zofia Nałkowska`, and its `sources` contains the full raw title line
  including the author parenthetical

#### Scenario: Multi-author string is not split

- **WHEN** the title line's author field is `Ada Lovelace and Grace Hopper`
- **THEN** `author` is that exact string, not a list

#### Scenario: Sources accumulate across syncs

- **WHEN** a later sync encounters a new raw title line that resolves to an
  existing book
- **THEN** that line is added to the book's `sources` and the lines recorded by
  earlier syncs are retained

### Requirement: Store metadata

`meta.yaml` SHALL carry `schemaVersion` and `sourceTimezone`, and nothing that
changes between runs. `sourceTimezone` SHALL be written once when the store is
initialised, from `--timezone` or the system IANA zone, and SHALL NOT be read
by any identifier, path or consolidation derivation.

#### Scenario: Metadata does not churn

- **WHEN** `sync` runs against a source file that produces no record changes
- **THEN** `meta.yaml` is not rewritten and no commit is created

#### Scenario: Changing the declared timezone

- **WHEN** `sourceTimezone` in `meta.yaml` is edited by hand and `sync` is
  re-run
- **THEN** no clipping file is renamed, added or deleted, and the edited value
  is left as written

### Requirement: Source file is committed verbatim

Each sync SHALL write the source file to `source/My Clippings.txt` byte for
byte. Earlier versions SHALL remain recoverable through the store's git
history.

#### Scenario: Discarded highlight remains recoverable

- **WHEN** consolidation discards a highlight superseded by a longer one
- **THEN** the committed `source/My Clippings.txt` still contains the discarded
  highlight's original record

#### Scenario: Recovering an earlier source file

- **WHEN** the device has been wiped and a shorter source file has since been
  committed
- **THEN** the previous file is retrievable with
  `git show <commit>:source/My\ Clippings.txt`

### Requirement: Sync is additive

A clipping present in the store but absent from the source file SHALL be
retained. The only clipping a sync SHALL delete is one that consolidation
supersedes.

#### Scenario: Source file is wiped

- **WHEN** the device is reset and `sync` runs against an empty source file
- **THEN** no clipping is deleted, no commit is created, and the store still
  holds every previously synced clipping

#### Scenario: Source file loses a book

- **WHEN** the source file no longer contains any record for a previously
  synced book
- **THEN** that book's directory and clippings are left untouched

#### Scenario: Superseded record is the only deletion

- **WHEN** a sync produces deletions
- **THEN** every deleted file corresponds to a highlight named in some kept
  highlight's `supersedes`

### Requirement: Sync is idempotent

Running `sync` against input that produces an unchanged store tree SHALL leave
the store's git history untouched. No empty commit SHALL be created.

#### Scenario: Second run on unchanged input

- **WHEN** `sync` runs twice against the same source file
- **THEN** the second run reports that nothing changed, creates no commit, and
  exits `0`

#### Scenario: New clippings appended to the source

- **WHEN** the source file gains records for an already-synced book
- **THEN** `sync` writes only the new clipping files and creates one commit

#### Scenario: A highlight is extended after an earlier sync

- **WHEN** a highlight committed by a previous sync is superseded by a longer
  highlight in the current source
- **THEN** one commit deletes the old clipping file, adds the new one, and the
  new record's `supersedes` names the deleted identifier

### Requirement: Commit message records the changeset

Each commit SHALL carry a subject summarising counts and a body listing
per-book additions and deletions, so the store's log is readable without
diffing.

#### Scenario: Commit subject and body

- **WHEN** a sync adds 42 clippings and deletes 3 superseded ones across 2 books
- **THEN** the commit subject names those totals and the body lists each book
  with its own added and deleted counts

### Requirement: Store preconditions are verified before any write

`sync` SHALL verify that the source file is readable, that `git` is executable,
that the store path is a git repository, that its working tree is clean, and
that a commit identity resolves in that repository. Each unmet condition SHALL
be reported on its own and SHALL exit `1` before any file is written.

#### Scenario: Store path is not a git repository

- **WHEN** the configured store path exists but is not a git repository
- **THEN** `sync` reports the failure and exits `1` without writing files

#### Scenario: Store has uncommitted changes

- **WHEN** the store's working tree is dirty before `sync` runs
- **THEN** `sync` reports the failure and exits `1` without writing files

#### Scenario: `git` is not on PATH

- **WHEN** the `git` binary cannot be executed
- **THEN** `sync` reports the failure and exits `1`

#### Scenario: No commit identity configured

- **WHEN** `user.name` or `user.email` does not resolve in the store repository
- **THEN** `sync` reports which is missing and exits `1` before writing, rather
  than failing at `git commit` with files already on disk

#### Scenario: Source file missing

- **WHEN** the resolved source path does not exist or cannot be read
- **THEN** `sync` reports the failure naming the path and exits `1`

### Requirement: Unknown schema versions are refused

`sync` SHALL refuse to operate on a store whose `meta.yaml` declares a
`schemaVersion` it does not recognise, rather than reading records it may
misinterpret.

#### Scenario: Store written by a newer version

- **WHEN** the store's `schemaVersion` is higher than the binary supports
- **THEN** `sync` reports the mismatch and exits `1` without writing

### Requirement: Dry run writes nothing

`sync --dry-run` SHALL compute and print the changeset and SHALL NOT write
files, stage anything, or create a commit.

#### Scenario: Dry run on a source with new records

- **WHEN** `sync --dry-run` runs against a source containing unsynced records
- **THEN** the additions and deletions are printed, the store's `HEAD`, working
  tree and index are unchanged, and the command exits `0`

### Requirement: Write failures are not partially committed

If any part of a sync fails, the command SHALL report the failure and exit `1`
and SHALL NOT leave a commit representing a partial write.

#### Scenario: Failure midway through writing

- **WHEN** a file write fails after some clipping files have been written
- **THEN** no commit is created and the failure is reported
