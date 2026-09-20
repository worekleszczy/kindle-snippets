## 1. Fixture and groundwork

- [x] 1.1 Add `My Clippings.txt` to `.gitignore` so the real file can never be committed by accident
- [x] 1.2 Write a one-off obfuscation script (kept under `scripts/`, not shipped in the binary) that takes a real clippings file and emits a fixture: word-level deterministic substitution of highlight and note text, synthetic book titles, everything else preserved byte for byte
- [x] 1.3 Build `src/fixtures/clippings.txt` from the real file, covering every case the parsing and consolidation specs enumerate — mid-file BOM, both metadata shapes, single-location note line, roman-numeral page, empty bookmark, empty highlight, DRM sentinel, `U+00A0`, `U+200B`, non-ASCII in a title and in text
- [x] 1.4 Ensure the fixture's book titles cover each identity shape: `Last, First` author, `First Last` author, multi-author string, hyphenated sideload filename longer than four words, underscored filename, ISBN-only title, title shorter than four words, title with non-ASCII letters, and two titles sharing a four-word prefix
- [x] 1.5 Ensure the fixture's highlights cover every collapse outcome: word-aligned prefix extension, mid-word containment, inner substring, identical text with differing timestamps, three-link chain, overlapping with unrelated text, containment across disjoint ranges, containment across two books, two overlapping DRM sentinels, empty highlight overlapping one with text
- [x] 1.6 Ensure the fixture's notes cover every attachment outcome: one candidate, two candidates of differing width, two of equal width resolved by timestamp, a complete tie resolved by identifier, no candidate, a DRM-sentinel candidate, and two notes at one location with identical text
- [x] 1.7 Write `src/fixtures/clippings.expected.json` recording the fixture's record counts per kind, kept and discarded highlight counts, and each note's expected attachment target
- [x] 1.8 Verify by inspection that no real highlight text, note text or book title appears anywhere in the repository
- [x] 1.9 Add `engines.bun` to `package.json` pinning the minimum version that ships `Bun.YAML`, and confirm `bun run verify` still passes
- [x] 1.10 Add a dated `tech.md` entry covering the `git` binary as a runtime requirement, `Bun.YAML` as the store format, and the rejected alternatives
- [x] 1.11 Define `SCHEMA_VERSION = 1` in one place and have both commands refuse a store declaring an unrecognised version

## 2. Parsing (`src/clippings.ts`)

- [x] 2.1 Define the record type: kind, raw title line, page as `string | null`, location `lo`/`hi`, zone-less timestamp, verbatim text, `empty` and `drmLimited` flags
- [x] 2.2 Split the source on `==========\r\n`, reject any segment that is not title / metadata / blank / content, and strip a BOM from every record's title line
- [x] 2.3 Parse the metadata grammar covering both the `on page N | Location` and the `on Location` shapes, with and without a location range end
- [x] 2.4 Parse the `Added on` English long date into a zone-less local date-time with no timezone conversion
- [x] 2.5 Classify empty-content records and clipping-limit sentinels with flags rather than dropping them
- [x] 2.6 Report any unparseable record through `failure()` naming its position; never skip one silently
- [x] 2.7 Handle an empty source file as zero records and no failure
- [x] 2.8 Write `src/clippings.test.ts` covering every scenario in `specs/clippings-parsing/spec.md`, asserting the fixture parses with zero failures and matches the per-kind counts in `clippings.expected.json`; malformed-record cases use inline strings, since the fixture itself must parse cleanly

## 3. Identity (`src/identity.ts`)

- [x] 3.1 Implement author-parenthetical splitting, returning the bare title and the author as one uninterpreted string
- [x] 3.2 Implement `bookId`: `-`/`_` to spaces, ASCII fold, strip non-alphanumerics per word, drop empties, first four words, lowercase, join with `-`
- [x] 3.3 Fail with a clear message when a title line slugs to an empty identifier
- [x] 3.4 Implement `clippingId` as the first 12 hex characters of SHA-256 over book id, kind, `lo`, `hi` and the verbatim local timestamp string, joined by a separator none of them can contain, with text excluded
- [x] 3.5 Detect a collision between two non-identical records sharing an identifier and fail naming both
- [x] 3.6 Write `src/identity.test.ts` covering every scenario in `specs/clipping-identity/spec.md`, asserting that the fixture yields one distinct identifier per record and the expected book slug for each title shape
- [x] 3.7 Add a test proving identity derivation reads no environment variable, timezone or clock

## 4. Consolidation (`src/consolidate.ts`)

- [x] 4.1 Implement comparison normalisation: `U+00A0` to space, drop `U+200B`, collapse whitespace, trim — used only for comparison
- [x] 4.2 Take the union of stored records and parsed records keyed by clipping identifier as the input to consolidation
- [x] 4.3 Implement highlight collapse: intersecting ranges **and** normalised text containment, keeping the longer text, keeping the earlier timestamp on equal text, never crossing a book boundary
- [x] 4.4 Exclude empty-content and DRM-limited highlights from text comparison in both directions
- [x] 4.5 Record collapsed identifiers in the survivor's `supersedes` as a sorted, deduplicated set, inheriting the `supersedes` entries of everything it collapses
- [x] 4.6 Implement note attachment: containing kept highlights, narrowest range, then nearest timestamp, then smallest identifier, leaving `attachedTo` null when there is no candidate
- [x] 4.7 Allow empty and DRM-limited highlights as attachment targets
- [x] 4.8 Leave notes and bookmarks untouched by collapse
- [x] 4.9 Write `src/consolidate.test.ts` covering every scenario in `specs/clipping-consolidation/spec.md`, asserting that the fixture's kept, discarded and attachment results match `clippings.expected.json`
- [x] 4.10 Add a regression test for the overlapping-but-unrelated pair, proving location overlap alone never collapses
- [x] 4.11 Add a test proving consolidation is idempotent over its own output
- [x] 4.12 Add a test for supersede chaining across two runs: A collapses into B, then B into C, and C ends up listing both

## 5. Store (`src/store.ts`)

- [x] 5.1 Define and serialise the clipping record schema: `schemaVersion`, `id`, `kind`, `book`, `timestamp`, `page`, `location`, `text`, `chapter: null`, `empty`, `drmLimited`, plus `supersedes` or `attachedTo`
- [x] 5.2 Define and serialise `book.yaml` with `schemaVersion`, `id`, `title`, `author`, `sources`, where `sources` is the sorted union of existing and newly seen raw title lines
- [x] 5.3 Define and serialise `meta.yaml` with `schemaVersion` and `sourceTimezone` only, written once at store creation and never rewritten; ensure no code path reads `sourceTimezone`
- [x] 5.4 Implement clipping path derivation as `books/<bookId>/clippings/<local YYYY-MM-DD>--<id>.yaml` with no timezone conversion
- [x] 5.5 Implement reading the entire existing store back into records, so consolidation can run over the union
- [x] 5.6 Implement a single `git` wrapper over `Bun.spawn` that treats a non-zero exit as a failure carrying stderr
- [x] 5.7 Implement preconditions, each failing on its own before any write: source readable, `git` executable, store is a git repository, working tree clean, `user.name` and `user.email` resolve, `schemaVersion` recognised
- [x] 5.8 Implement the changeset computation: files to add, files to overwrite, and files to delete for superseded highlights, with additive semantics so absence from the source never deletes
- [x] 5.9 Implement the commit message: subject with totals, body with per-book added and deleted counts
- [x] 5.10 Ensure serialisation is byte-stable — key order, list order, scalar style — so an unchanged record never produces a spurious diff
- [x] 5.11 Write `src/store.test.ts` covering `specs/clipping-store/spec.md` against a temporary git repository created per test

## 6. Sync command (`src/sync.ts`)

- [x] 6.1 Resolve `--source` from flag, then `KINDLE_SYNC_SOURCE`, then `/Volumes/Kindle/documents/My Clippings.txt`; resolve `--store` from flag then `KINDLE_SYNC_STORE` with no default, treating absence as a usage error; validate with `checkFlags`
- [x] 6.2 Wire parse → identity → store read → consolidate over the union → changeset, writing clipping files, `book.yaml` files and `meta.yaml`
- [x] 6.3 Copy the source file byte for byte to `source/My Clippings.txt`
- [x] 6.4 Commit only when the changeset is non-empty; report "nothing changed" and exit `0` otherwise
- [x] 6.5 Implement `--dry-run`: print the changeset, write nothing, leave `HEAD`, working tree and index untouched, exit `0`
- [x] 6.6 Ensure a failure at any point exits `1` and leaves no commit representing a partial write
- [x] 6.7 Write `src/sync.test.ts` proving idempotency, the append case, the supersede-across-syncs case, the wiped-source case (no deletions, no commit), `--dry-run`, and each precondition failure

## 7. Query command (`src/query.ts`)

- [x] 7.1 Parse and validate `--book`, `--since`, `--books` and `--cursor`, rejecting any other flag as a usage error via `checkFlags`
- [x] 7.2 Implement the no-filter and `--book` paths as a read of the store tree, emitting JSON Lines with `schemaVersion` and no `op` field
- [x] 7.3 Fail with exit `1` on an unknown `--book` identifier rather than emitting nothing
- [x] 7.4 Implement `--since` via `git diff --name-status <commit>..HEAD`, mapping statuses to `add` / `modify` / `delete` ops
- [x] 7.5 Verify the cursor exists and is an ancestor of `HEAD`, failing with a distinct message for each case
- [x] 7.6 Emit `delete` objects carrying exactly `schemaVersion`, `op`, `id`, `book`, `kind`
- [x] 7.7 Implement `--books` for book records, combining with `--since` and `--book`
- [x] 7.8 Implement `--cursor` to print the store's `HEAD`, failing on a store with no commits
- [x] 7.9 Order output by book id, then timestamp, then clipping id, so repeated runs are byte-identical
- [x] 7.10 Keep stdout machine-readable — diagnostics to stderr — and guarantee the command never writes to the store
- [x] 7.11 Write `src/query.test.ts` covering every scenario in `specs/clipping-query/spec.md`, including a test asserting the store's `HEAD`, working tree and index are unchanged after a query

## 8. Wiring and documentation

- [x] 8.1 Add `sync` and `query` dispatch cases to `src/cli.ts` and extend `USAGE`; keep `run()` free of `process.exit`
- [x] 8.2 Extend `src/cli.test.ts` for the new dispatch and usage-error paths
- [x] 8.3 Document both commands, all flags and environment variables, and the store layout in `README.md`
- [x] 8.4 Document the store operating contract in `README.md`: history must never be rewritten past a published cursor, sync is additive, removal is manual
- [x] 8.5 Run `bun run verify` and confirm typecheck, Biome and all tests pass

## 9. First real sync

- [x] 9.1 Initialise the store repository outside this repo, confirm it has a commit identity, and record its path
- [x] 9.2 Run `sync --dry-run` against the real file and check the changeset before committing anything
- [x] 9.3 Run `sync`, then confirm the tree holds 20 books, 1017 highlights, 139 notes and 14 bookmarks — the acceptance check that replaces the real corpus as a regression test
- [x] 9.4 Run `sync` a second time and confirm it creates no commit
- [x] 9.5 Run `query --since <first commit>` and confirm the op stream matches what the second sync did

## Notes

The first real sync (section 9) ran against a store at
`/Users/piotrjosiak/flight-control/data/kindle-clippings-store`: 20 books,
1017 highlights, 139 notes and 14 bookmarks, a second run created no commit,
and `query --since <first commit>` emitted nothing.
