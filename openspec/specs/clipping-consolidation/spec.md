# clipping-consolidation Specification

## Purpose
TBD - created by archiving change add-clipping-sync-store. Update Purpose after archive.
## Requirements
### Requirement: Consolidation operates on the union of store and source

Consolidation SHALL run over the union of the records already in the store and
the records parsed from the source file, keyed by clipping identifier. It SHALL
NOT run over the source file alone.

#### Scenario: A stored highlight is superseded by a newly parsed one

- **WHEN** the store holds a highlight at `272-274` and the source contains a
  longer highlight at `272-277` containing its text
- **THEN** consolidation keeps the `272-277` highlight and discards the stored
  one, even though the stored record is not present in the current source file

#### Scenario: A stored record absent from the source survives

- **WHEN** the store holds a clipping whose record no longer appears in the
  source file and which nothing supersedes
- **THEN** consolidation keeps it unchanged

#### Scenario: Consolidation is idempotent

- **WHEN** consolidation runs twice over the same union
- **THEN** the second run produces an identical result set

### Requirement: Comparison normalisation

For the purpose of comparing two highlights, text SHALL be normalised by
replacing `U+00A0` with a space, removing `U+200B`, collapsing runs of
whitespace to a single space, and trimming. This normalisation SHALL be used
only for comparison and SHALL NOT be written to the store.

#### Scenario: Invisible characters do not defeat comparison

- **WHEN** two highlights differ only by a non-breaking space or a zero-width
  space
- **THEN** their normalised forms compare equal, while both stored texts retain
  their original characters

### Requirement: Highlight collapse requires text containment

Two highlights in the same book SHALL be collapsed only when their location
ranges intersect **and** the normalised text of one contains the normalised
text of the other. The highlight with the longer normalised text SHALL be
kept; the shorter SHALL be discarded. When the normalised texts are equal, the
earlier-timestamped highlight SHALL be kept.

#### Scenario: Extended highlight supersedes its prefix

- **WHEN** a book contains a highlight at `272-274` with text
  `A comprehensive account of tidal drift should addre...` and a later
  highlight at `272-277` whose text begins with that same text
- **THEN** only the `272-277` highlight is kept

#### Scenario: Inner highlight is absorbed by a wider one

- **WHEN** a highlight's normalised text is contained inside another
  overlapping highlight's normalised text
- **THEN** only the containing highlight is kept

#### Scenario: Overlapping ranges with unrelated text are both kept

- **WHEN** a book contains a highlight at `1992-2011` reading
  `swojego sąsiada, do wyegzekwowania prawa „ząb za ząb”...` and one at
  `2003-2011` reading `Jeszcze bardziej zawiła kwestia dotyczy...`
- **THEN** both highlights are kept, because neither text contains the other

#### Scenario: Identical text recorded twice

- **WHEN** two highlights in a book have equal normalised text and intersecting
  ranges
- **THEN** only the earlier-timestamped one is kept

#### Scenario: Non-overlapping ranges are never compared

- **WHEN** two highlights in a book have disjoint location ranges
- **THEN** both are kept regardless of their text

#### Scenario: Collapse never crosses a book boundary

- **WHEN** two highlights in different books have intersecting location ranges
  and one text contains the other
- **THEN** both are kept

### Requirement: Empty and DRM-limited highlights are excluded from text comparison

A highlight with empty content or marked DRM-limited SHALL NOT participate in
collapse, in either direction. The clipping-limit sentinel is identical across
every record that carries it, so comparing it would merge distinct highlight
events whose text Amazon withheld.

#### Scenario: Two sentinels in one book

- **WHEN** a book contains two DRM-limited highlights with identical sentinel
  text and intersecting ranges
- **THEN** both are kept

#### Scenario: Empty highlight overlapping a real one

- **WHEN** an empty-content highlight's range intersects a highlight with text
- **THEN** both are kept

#### Scenario: Fixture collapse volume

- **WHEN** the committed fixture's highlights are consolidated
- **THEN** the kept and discarded counts match those recorded in
  `src/fixtures/clippings.expected.json`

### Requirement: The fixture exercises every collapse outcome

The fixture SHALL contain at least one instance of each collapse outcome, so
that no rule in this specification is covered only by an inline test string:
a word-aligned prefix extension; a containment that falls mid-word; an inner
substring; an identical-text pair with differing timestamps; a three-link
collapse chain; an overlapping pair with unrelated text; a containment pair
whose ranges are disjoint; a containment pair split across two books; two
overlapping DRM sentinels; and an empty-content highlight overlapping one with
text.

#### Scenario: Mid-word containment still collapses

- **WHEN** a highlight's normalised text ends mid-word and is a substring of a
  longer overlapping highlight
- **THEN** it is collapsed, because the rule is character containment and not
  word containment

#### Scenario: Every collapse outcome has fixture coverage

- **WHEN** the fixture is consolidated
- **THEN** each listed outcome occurs at least once

### Requirement: Collapsed identifiers are recorded on the survivor

A kept highlight SHALL record in `supersedes` the identifiers of every
highlight collapsed into it, together with every identifier those highlights
already listed in their own `supersedes`. A consumer can then recognise a
previously published identifier as superseded rather than lost, across any
number of sync runs.

#### Scenario: Survivor lists what it replaced

- **WHEN** two highlights collapse into one
- **THEN** the kept highlight's `supersedes` contains the discarded
  highlight's identifier

#### Scenario: Chained collapse within one run

- **WHEN** highlight A is contained in B and B is contained in C, all
  overlapping
- **THEN** only C is kept and its `supersedes` contains the identifiers of both
  A and B

#### Scenario: Chained collapse across sync runs

- **WHEN** an earlier sync collapsed A into B, and a later sync collapses B
  into C
- **THEN** C's `supersedes` contains both A and B, because C inherits B's
  `supersedes` list

#### Scenario: Supersedes is a stable sorted set

- **WHEN** a highlight's `supersedes` list is written
- **THEN** it contains no duplicates and is sorted, so an unchanged result
  never produces a spurious file modification

### Requirement: Notes and bookmarks are never collapsed

Collapse SHALL apply to highlights only. Notes and bookmarks SHALL never be
collapsed, discarded or merged, regardless of location overlap or text
equality.

#### Scenario: Two notes at the same location

- **WHEN** a book contains two notes with the same location and identical text
  but different timestamps
- **THEN** both notes are kept

#### Scenario: Bookmarks at overlapping locations

- **WHEN** a book contains two bookmarks whose locations coincide
- **THEN** both are kept

### Requirement: Note attachment

Each note SHALL be attached to at most one highlight, chosen from the kept
highlights of the same book whose location range contains the note's location.
Among those candidates the narrowest range SHALL win; if several share the
narrowest range, the one whose timestamp is closest to the note's SHALL win;
if a tie remains, the one with the lexicographically smallest clipping
identifier SHALL win, so the result is deterministic.

#### Scenario: Single containing highlight

- **WHEN** exactly one kept highlight contains the note's location
- **THEN** the note's `attachedTo` is that highlight's identifier

#### Scenario: Several containing highlights of different widths

- **WHEN** two kept highlights contain the note's location and one has a
  narrower range
- **THEN** the note attaches to the narrower one

#### Scenario: Several containing highlights of equal width

- **WHEN** two kept highlights contain the note's location and share the same
  range width
- **THEN** the note attaches to the one whose timestamp is nearest the note's

#### Scenario: Complete tie

- **WHEN** two candidates share the narrowest range and are equidistant in time
- **THEN** the note attaches to the one with the smaller clipping identifier,
  and the choice is identical on every run

#### Scenario: No containing highlight

- **WHEN** no kept highlight contains the note's location
- **THEN** the note is kept with `attachedTo` set to null and remains
  queryable on its own

#### Scenario: Re-attachment when a better candidate appears

- **WHEN** a later sync introduces a highlight narrower than the note's current
  target and still containing the note's location
- **THEN** the note's `attachedTo` is updated to the new target

### Requirement: DRM-limited and empty highlights are valid attachment targets

A note SHALL be permitted to attach to a DRM-limited or empty-content
highlight. Such a highlight marks a passage that was genuinely highlighted and
whose text was withheld, so it is the correct anchor for a note on that
passage.

#### Scenario: Note whose only candidate is a sentinel

- **WHEN** the only kept highlight containing a note's location is DRM-limited
- **THEN** the note attaches to it rather than being left unattached

#### Scenario: Fixture attachment completeness

- **WHEN** the committed fixture's notes are attached after consolidation
- **THEN** each note's resolved target matches the one recorded in
  `src/fixtures/clippings.expected.json`, and no note is dropped

### Requirement: The fixture exercises every attachment outcome

The fixture SHALL contain at least one note for each attachment outcome: a
single containing highlight; two candidates of differing range width; two
candidates of equal width resolved by timestamp; a complete tie resolved by
identifier; no containing candidate at all; a candidate that is a DRM-limited
highlight; and two notes at one location with identical text and differing
timestamps.

#### Scenario: Every attachment outcome has fixture coverage

- **WHEN** the fixture's notes are attached
- **THEN** each listed outcome occurs at least once

### Requirement: Notes remain first-class records

A note SHALL be stored as its own record with its own identifier, location,
timestamp and text. It SHALL NOT be stored only as a field of a highlight.

#### Scenario: Note is independently addressable

- **WHEN** a note is attached to a highlight
- **THEN** the note still has its own file and identifier in the store, and the
  highlight's file does not contain the note's text

