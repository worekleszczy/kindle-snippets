## Context

`My Clippings.txt` is the only place a Kindle records highlights locally. It is
append-only, the device can wipe it, and nothing can read it incrementally.

Every decision below was checked against a real 636 KB sample: 1342 records,
20 books, February 2024 to July 2026. The measurements matter because the
format's folklore is wrong in two places that would have cost data. The sample
itself is **not** committed — it holds personal reading material. Only the
aggregate measurements appear here, and the committed test fixture is an
obfuscated extract of it.

Current state of the codebase: `src/cli.ts` dispatches `help` and `version`
only. `src/args.ts` holds hand-rolled flag helpers, `usage()` and `failure()`.
Repo constraints that bind this design — zero runtime dependencies, one module
per command, `noUncheckedIndexedAccess`, no error may be swallowed, and
`bun run verify` is the only gate.

Observed structure of the sample:

| Property | Value |
| --- | --- |
| Records | 1342 — 1189 highlights, 139 notes, 14 bookmarks |
| Record shape | title / metadata / blank / content, separated by `==========\r\n` |
| Metadata grammar coverage | one pattern matches 100% |
| UTF-8 BOM occurrences | 34, **mid-file**, not only at offset 0 |
| Multi-line content | none |
| Non-numeric pages | 11 (roman numerals) |
| Empty content | 16 (14 bookmarks, 2 highlights) |
| DRM clipping-limit sentinels | 36, across 3 books |
| Timestamp inversions between adjacent records | 0 of 1341 |

## Goals / Non-Goals

**Goals:**

- Turn the device file into a durable git-backed store no device reset can erase.
- Let external tooling pull incrementally by commit id.
- Make store paths and identifiers pure functions of the records, so two
  machines producing the same records produce byte-identical trees.
- Lose no user-authored text, including text the consolidation step discards.
- Make a re-sync of unchanged input a genuine no-op — no commit, no churn.

**Non-Goals:**

- Chapter information. It does not exist in the source: zero occurrences of any
  chapter field across all 1342 metadata lines, which carry exactly three
  slots. The only source that has chapters, `read.amazon.com/notebook`,
  excludes sideloads — 55% of this sample's clippings, including the two
  largest books at 742 records. A nullable field is reserved; populating it is
  a separate change.
- Deleting clippings. Sync is additive; removing a record is a manual edit of
  the store. A `prune` command was considered and deferred.
- Pushing the store to a remote. The store is local; `query` is the consumer
  interface. Nothing in the design forecloses adding push later.
- Multiple source devices. One device, one `source/My Clippings.txt`.
- Merging one book that arrives under two different title strings.
- Timestamp-range queries. The date is already in the path, so adding them
  later is cheap.
- Writing back to the device, or any network access.

## Decisions

### Consolidation keys on text containment, not location overlap

A Kindle "location" spans roughly 150 characters, so consecutive unrelated
highlights routinely share a boundary. Classifying all 465 overlapping
highlight pairs in the sample by what their text actually does:

```
 253  distinct text      ← different passages, adjacent ranges
 119  prefix extension   ← genuine re-highlight
  69  substring (inner)  ← genuine re-highlight
  22  identical text
   2  one side empty
```

Collapsing on location overlap — the obvious rule — would have destroyed 253
real highlights. Requiring normalised text containment *within* an overlapping
range reduces 1189 highlights to 1017 while losing no distinct passage.

**Alternative considered:** keep everything and flag `supersededBy`. Rejected
because the store should be clean at rest; the recoverability concern it
addressed is handled by committing the source file instead.

**Alternative considered:** text containment anywhere in the book, ignoring
ranges. Rejected — a short highlight could coincidentally be a substring of a
distant long one. The range intersection is the guard.

### DRM sentinels are excluded from comparison but are valid attachment targets

36 records carry the literal text
`<You have reached the clipping limit for this item>`. The text is identical
across all of them, so letting them into text comparison collapses distinct
highlight events whose text Amazon withheld — it changes the kept count from
1017 to 1010 by merging seven records that are not duplicates.

The reverse holds for note attachment. A sentinel marks a passage that was
genuinely highlighted, so it is the correct anchor for a note on that passage.
Excluding sentinels as attachment targets leaves 5 of 139 notes unattached for
no benefit.

So the rule is deliberately asymmetric: a sentinel never participates in
collapse, and always counts as an attachment candidate. Same for the 2
empty-content highlights.

### Consolidation fixes note attachment as a side effect

Notes are separate records naming a single location, not the highlight they
annotate. Attaching them is a heuristic, and it is materially better after
collapse:

```
                          unique   ambiguous
before collapse              93       46
after collapse              108       31
after collapse, narrowest   138        1   → 1 resolved by nearest timestamp
```

The rule is: candidates are kept highlights whose range contains the note's
location; narrowest range wins; ties break on nearest timestamp; a remaining
tie breaks on the smaller clipping identifier so the result is deterministic.
All 139 notes in the sample resolve to exactly one highlight, 7 of them to a
sentinel.

`attachedTo` must still permit null, for a future note whose passage was never
clipped at all.

### Notes are stored as records, not as fields

The requirement was "a note is a property of a clipping". Storing it literally
as a field means a note the heuristic cannot place has nowhere to live. Storing
notes as first-class records with `attachedTo` gives the same reading
experience through a lookup, while an unplaceable note stays addressable.

### Sync is additive, and consolidation runs over the union

A clipping in the store but absent from the source is retained. The only
deletion is a supersede. This makes a device wipe, a truncated file, or a file
read from the wrong path harmless: the worst case is a sync that changes
nothing.

It has one consequence that is easy to miss. If consolidation ran over the
source file alone, a highlight already in the store could never be superseded
once it left the device file — the store would keep both the short and the long
version forever. So consolidation runs over the **union of stored records and
parsed source records**, keyed by clipping identifier. Sync therefore reads the
entire store on every run, which at ~1000 small YAML files is immaterial.

This also means `supersedes` must be inherited: when B collapses into C, C
takes B's `supersedes` entries as well as B's own id, because A was deleted
from the store when it collapsed into B and is no longer in the union.

**Alternative considered:** mirror the source. Rejected — one sync after a
factory reset would empty the store, and the failure is silent.

**Alternative considered:** a separate `prune` command. Deferred rather than
rejected; nothing in the design blocks adding it.

### The clipping identifier excludes text

`clippingId` = first 12 hex characters of SHA-256 over the book identifier,
kind, `lo`, `hi` and the verbatim local timestamp string. Tested against the
sample:

```
book + timestamp                      2 collisions
book + kind + timestamp               1 collision
book + kind + location range        121 collisions
book + kind + location + timestamp    0 collisions   ← chosen
```

Excluding text is deliberate. Later normalisation or chapter enrichment then
lands as a `modify` op on stable identifiers, instead of re-identifying the
whole tree and emitting 1342 deletes and 1342 adds to every consumer.

12 hex characters is 48 bits, which is ample for a corpus of this size, and a
genuine collision between non-identical records fails the sync loudly rather
than overwriting.

### The book slug is the only book identifier

First four words of the title with the author parenthetical stripped,
`-` and `_` treated as word separators, ASCII-folded, lowercased, joined by `-`.
Produces no collisions across the sample's 20 books.

Hyphen splitting is not optional: without it the sideloaded
`patterns-of-distributed-systems-an-engineering-primer-…-press` is one
80-character word.

ASCII folding is not cosmetic. macOS stores filenames NFD and Linux NFC, so a
directory named `opowiesc-o-zazolconej-gęśli` can appear as two distinct paths in one
git repo cloned across machines. Folding removes the class. The unfolded title
survives in `book.yaml`.

The rule guarantees that re-loading the same title line always lands in the same
book. It cannot merge two *different* title strings for one book — a sideloaded
`evt-sourcing` and a purchased `Event Sourcing: Tackling…` stay separate, and
no automatic rule fixes that. Recording every raw title line in `sources` makes
a wrong merge visible without introducing a second identifier.

The author string is stored as one verbatim field. The sample shows three
incompatible conventions — `Ries, Eric`, `Eric Evans`,
`Ada Lovelace and Grace Hopper` — so parsing it into a list would require
guessing.

### Paths and identifiers take no configuration input

Timestamps in the source are zone-less local wall-clock. Deriving a UTC date for
the filename would require a declared source timezone, making every path depend
on a config value — correcting that value later would rename all files and reach
consumers as a full delete-and-add sweep. Under Europe/Warsaw, 31 records (2.3%)
would also land on a different day than the file states.

So the filename carries the local date verbatim. `sourceTimezone` is written to
`meta.yaml` once at store creation, purely as documentation for a consumer that
needs an absolute instant, and nothing in the tool reads it.

**Alternative considered:** id-only filenames. Rejected — the largest book's
directory would be 383 files with no scannable order.

### `meta.yaml` holds nothing that changes between runs

An earlier draft gave it a `lastSync` timestamp, which would have made every
sync rewrite it and therefore produce a commit — directly defeating the
idempotency requirement. The last sync time is already the `HEAD` commit's
date. `meta.yaml` carries `schemaVersion` and `sourceTimezone` and nothing else.

### The source file is committed verbatim

Consolidation is lossy by choice. `source/My Clippings.txt` in the same commit
makes every discarded highlight recoverable. Because sync is additive and the
store is single-device, one stable path is enough: older versions stay in git
history, which also gives git the best possible delta compression for an
append-only file.

### YAML via `Bun.YAML`, git via `Bun.spawn`

`Bun.YAML.parse`/`stringify` ship with the runtime (confirmed present in Bun
1.3.14), so YAML costs no npm dependency and its block scalars keep a 10 KB
highlight readable in a diff. This pins a minimum Bun version, recorded in
`package.json`.

git is invoked as a subprocess through a single wrapper that treats a non-zero
exit as a failure carrying stderr. It is a new external requirement — not an npm
dependency, but still a technology decision that needs a dated `tech.md` entry.
A JS git implementation would be a large runtime dependency for operations the
binary already does correctly.

### The cursor is a commit id resolved through `git diff`

`query --since <commit>` runs `git diff --name-status <commit>..HEAD` over the
record paths and maps status letters to `add` / `modify` / `delete` ops. This
works only because one clipping is one file.

Two consequences are contract, not implementation. The store's history must
never be rewritten past a published cursor — `query` checks that the cursor is
an ancestor of `HEAD` and fails loudly rather than emitting a misleading
changeset. And an extended highlight reaches a consumer as delete + add, because
collapse discards the superseded identifier; `supersedes` on the survivor lets a
consumer reconnect the two.

The store is local-only for now, but the cursor contract is written as though it
had external consumers, so adding a remote later is an operational change rather
than a redesign.

### Full re-parse on every sync

The file is strictly append-ordered (0 inversions in 1341 adjacent pairs), which
would permit parsing from a watermark. Rejected: a device reset rewrites the
file from empty, so a watermark needs a tail-check to stay correct, and 636 KB
parses in milliseconds. The optimisation buys nothing and adds a failure mode.

### Source and store locations

`--source <path>` and `--store <path>` flags, each falling back to an
environment variable (`KINDLE_SYNC_SOURCE`, `KINDLE_SYNC_STORE`). `--source`
defaults to `/Volumes/Kindle/documents/My Clippings.txt`; a missing file there
is a failure naming the path tried. `--store` has **no** default — guessing a
store path risks committing into the wrong repository, so its absence is a usage
error. No config file; the repo has no config-file concept and one flag per
location is enough.

### The test fixture is an obfuscated extract, not the real file

`src/fixtures/clippings.txt` is a subset of real records whose user-authored
text and book titles are replaced with synthetic substitutes. The record
structure is preserved byte for byte in shape — separators, CRLF line endings,
mid-file byte-order marks, metadata lines, timestamps — because those are what
the parser contracts on.

Obfuscation is word-level and deterministic, which preserves the text
relationships consolidation depends on: in the real sample 184 of 188
containment pairs align on word boundaries, so substituting word for word keeps
prefix and substring relationships intact. The remaining 4 fall mid-word, so the
fixture carries a deliberate mid-word containment case to cover that path.

Expected counts live beside it in `src/fixtures/clippings.expected.json` rather
than being hard-coded in the specs, so the specs do not encode facts about the
author's library.

**What this costs:** the real corpus is no longer a regression test. A rule
change that is correct on the fixture but wrong on 1342 real records would not
be caught automatically. The mitigation is the first-real-sync acceptance step,
which checks the real numbers once by hand — 20 books, 1017 highlights, 139
notes, 14 bookmarks.

**Alternative considered:** committing the real file, which makes every count
assertable. Rejected — it puts 1342 personal highlights in the repository's
history permanently and irreversibly.

**Alternative considered:** a gitignored real file with an opt-in test that runs
when present. Rejected as a second, silently-skipped code path whose absence in
CI is indistinguishable from passing.

### Module boundaries

`clippings.ts` (parse) → `identity.ts` (ids) → `consolidate.ts` (collapse,
attach) → `store.ts` (layout, YAML, git) → `sync.ts` / `query.ts` (commands).
The first three are pure functions over data structures, so the bulk of the
behaviour is testable without touching a filesystem or a git repository.

## Risks / Trade-offs

- **Consolidation discards 14% of highlights and the rule could still be wrong
  for an unseen book** → `source/My Clippings.txt` is committed verbatim in the
  same commit, so any discarded text is recoverable and the rule can be re-run.

- **Sync reads the whole store on every run** → required by additive union
  semantics; ~1000 small YAML files is immaterial, and it is what makes a stored
  record superseder-able after it leaves the device file.

- **Additive means a clipping can never be removed by the tool** → accepted
  deliberately. Removal is a manual edit plus commit; `prune` remains available
  as a later change.

- **Two different books whose titles share a four-word prefix merge into one
  directory** → every raw title line is recorded in `sources`, so the merge is
  visible on inspection. No second identifier is introduced, per the constraint
  that the slug is the only id.

- **Note attachment is a heuristic and can attach to the wrong highlight** →
  notes stay first-class records carrying their own location and timestamp, so
  a wrong `attachedTo` is a wrong pointer, never lost data.

- **A rewritten store history silently invalidates a consumer's cursor** →
  `query --since` verifies the cursor is an ancestor of `HEAD` and exits `1`
  with a clear message instead of emitting a wrong changeset. The constraint is
  documented for whoever operates the store.

- **`sync` committing over unrelated local edits in the store repo** →
  preconditions check that the store is a git repository with a clean working
  tree and a resolvable commit identity before anything is written.

- **Concurrent syncs against one store** → not supported. The clean-working-tree
  precondition is the only guard; a second concurrent run will fail it or fail
  on git's index lock.

- **The real corpus is not a regression test** → the fixture covers every rule
  by construction, and the first-real-sync step checks the real totals by hand.
  A rule change correct on the fixture but wrong at scale is caught there, not
  automatically.

- **The fixture must be maintained alongside the rules** → a new rule with no
  fixture case is a silent coverage hole. The consolidation and parsing specs
  each carry an explicit requirement enumerating the cases the fixture must
  contain, so the gap is visible in review.

- **Pinning a minimum Bun version through `Bun.YAML`** → recorded in
  `package.json` and `tech.md`; the binary is self-contained, so only the build
  machine is affected.

- **Consumers must handle delete + add for an extended highlight** → stated in
  the query contract and in `supersedes` on the surviving record, so a consumer
  can recognise the relationship rather than infer it.

## Migration Plan

Greenfield. No existing store, no existing consumers, no data to migrate.

1. Commit the reference fixture and land the pure modules (`clippings`,
   `identity`, `consolidate`) against it.
2. Land `store` and `sync` against a temporary git repository in tests.
3. Land `query`.
4. Initialise the real store repository, run `sync`, verify a second run
   creates no commit.

Rollback is deleting the store repository; nothing in this repo's existing
behaviour changes, and `help` and `version` are untouched throughout.

`schemaVersion` is `1`. Both commands refuse a store declaring a version they
do not recognise rather than misreading it. Bumping the version requires its own
change carrying a migration.

## Open Questions

None. The four that were open — deletion semantics, store remoting, multiple
source devices, and the test fixture — are settled above as additive union,
local-only, single device, and the committed real sample.
