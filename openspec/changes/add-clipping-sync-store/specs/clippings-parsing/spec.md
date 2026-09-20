## ADDED Requirements

### Requirement: Record splitting

The parser SHALL split `My Clippings.txt` on the literal separator
`==========\r\n` and treat each non-empty segment as one record. A record
SHALL consist of a title line, a metadata line, an empty line, and a content
line, in that order.

#### Scenario: Well-formed file splits into records

- **WHEN** a source file containing 1342 separator-delimited segments is parsed
- **THEN** the parser yields 1342 records and no trailing empty record

#### Scenario: Record with an unexpected line count

- **WHEN** a record does not have the title / metadata / blank / content shape
- **THEN** the parser reports that record as a parse failure naming its
  position in the file, and does not emit a record for it

### Requirement: Per-record byte-order-mark removal

A UTF-8 byte-order mark SHALL be stripped from the start of every record's
title line, not only from the start of the file. The stripped mark SHALL NOT
appear in the stored title or affect the derived book identifier.

#### Scenario: BOM appears mid-file

- **WHEN** a record's title line begins with `U+FEFF` at a non-zero file offset
- **THEN** the parsed title equals the title without the mark, and the record's
  book identifier matches that of an otherwise identical record with no mark

### Requirement: Metadata grammar

The parser SHALL read the metadata line as
`- Your <kind> on [page <page> | ]Location <lo>[-<hi>] | Added on <timestamp>`,
where `<kind>` is `Highlight`, `Note` or `Bookmark`. When `<hi>` is absent the
record's location range SHALL be `lo` to `lo`. When the page field is absent
the record SHALL carry no page.

#### Scenario: Highlight with page and location range

- **WHEN** the metadata line is
  `- Your Highlight on page 42 | Location 272-277 | Added on Friday, January 2, 2026 7:13:49 PM`
- **THEN** the record has kind `highlight`, page `"42"`, location `272`–`277`,
  and timestamp `2026-01-02 19:13:49`

#### Scenario: Highlight without a page field

- **WHEN** the metadata line is
  `- Your Highlight on Location 2778-2781 | Added on Friday, February 16, 2024 9:17:49 PM`
- **THEN** the record has no page and location `2778`–`2781`

#### Scenario: Note with a single location

- **WHEN** the metadata line is `- Your Note on page 96 | Location 8538 | Added on ...`
- **THEN** the record has kind `note` and location range `8538`–`8538`

#### Scenario: Unrecognised metadata line

- **WHEN** a metadata line does not match the grammar
- **THEN** the parser reports a parse failure quoting the line, and the command
  exits `1` rather than skipping the record

### Requirement: Page is an opaque string

The page field SHALL be stored as a string and SHALL NOT be coerced to a
number, because the source uses roman numerals for front matter.

#### Scenario: Roman-numeral page

- **WHEN** the metadata line contains `on page xxvii`
- **THEN** the record's page is the string `"xxvii"`

### Requirement: Timestamp is read verbatim as local wall-clock time

The parser SHALL read the `Added on` field using the English long date format
`<Weekday>, <Month> <D>, <YYYY> <h>:<mm>:<ss> <AM|PM>` and SHALL retain it as a
zone-less local date-time. The parser SHALL NOT apply any timezone conversion.

#### Scenario: Timestamp is preserved without a zone

- **WHEN** the metadata line reads `Added on Friday, January 2, 2026 7:13:49 PM`
- **THEN** the record's timestamp is `2026-01-02T19:13:49` with no offset or
  zone attached

#### Scenario: Unparseable date

- **WHEN** the `Added on` field does not match the expected format
- **THEN** the parser reports a parse failure and the command exits `1`

### Requirement: Content is preserved verbatim

Clipping text SHALL be stored exactly as it appears in the source, including
non-breaking spaces, zero-width spaces, typographic quotes and dashes.
Normalisation SHALL be applied only for comparison during consolidation and
SHALL NOT alter stored text.

#### Scenario: Text containing invisible characters

- **WHEN** a record's content contains `U+00A0` or `U+200B`
- **THEN** the stored text contains those characters unchanged

### Requirement: Empty and DRM-limited records are classified, not discarded

A record whose content is empty SHALL be parsed and marked empty. A record
whose content is the Kindle clipping-limit sentinel SHALL be parsed and marked
as DRM-limited, and its content SHALL NOT be treated as user-authored text.

#### Scenario: Bookmark with no content

- **WHEN** a `Bookmark` record has an empty content line
- **THEN** the record is emitted with kind `bookmark` and an empty-content flag

#### Scenario: Clipping-limit sentinel

- **WHEN** a record's content is `<You have reached the clipping limit for this item>`
- **THEN** the record is emitted with a `drmLimited` flag set and is excluded
  from consolidation's text comparisons

### Requirement: Parsing is total and failures are loud

The parser SHALL account for every record in the source. It SHALL NOT silently
skip, truncate or ignore a record. Any record it cannot parse SHALL be reported
through `failure()` with enough detail to locate it.

#### Scenario: Reference file parses completely

- **WHEN** the repository's reference fixture `src/fixtures/my-clippings.txt`
  is parsed
- **THEN** 1342 records are emitted — 1189 highlights, 139 notes, 14 bookmarks
  — and zero parse failures are reported

#### Scenario: Empty source file

- **WHEN** the source file is empty or contains only whitespace
- **THEN** the parser emits zero records and reports no failure
