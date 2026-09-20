## ADDED Requirements

### Requirement: Book identifier derivation

The book identifier SHALL be derived from the record's title line alone, by:
stripping a trailing parenthesised author field; replacing `-` and `_` with
spaces; folding the result to ASCII; splitting on whitespace; removing every
non-alphanumeric character from each word; discarding words that become empty;
taking the first four remaining words; lowercasing them; and joining them with
`-`. This SHALL be the only identifier a book has.

#### Scenario: Ordinary title

- **WHEN** the title line is `The Lean Startup (Ries, Eric)`
- **THEN** the book identifier is `the-lean-startup`

#### Scenario: Title longer than four words

- **WHEN** the title line is
  `Mating in Captivity: How to keep desire and passion alive in long-term relationships (Perel, Esther)`
- **THEN** the book identifier is `mating-in-captivity-how`

#### Scenario: Sideloaded filename as title

- **WHEN** the title line is
  `fundamentals-of-software-architecture-an-engineering-approach-mark-richards-neal-ford-helion (Mark Richards and Neal Ford)`
- **THEN** hyphens are treated as word separators and the book identifier is
  `fundamentals-of-software-architecture`

#### Scenario: Underscore-separated filename as title

- **WHEN** the title line is `Nieznosna_lekkosc_bytu (Milan Kundera)`
- **THEN** the book identifier is `nieznosna-lekkosc-bytu`

#### Scenario: Non-ASCII letters are folded

- **WHEN** the title line is `Sapiens. Od zwierząt do bogów (Yuval Noah Harari)`
- **THEN** the book identifier is `sapiens-od-zwierzat-do`, containing only
  ASCII alphanumerics and `-`

#### Scenario: Numeric title

- **WHEN** the title line is `9780132702539 (Jim Arlow)`
- **THEN** the book identifier is `9780132702539`

#### Scenario: Fewer than four words

- **WHEN** the title line is `deds (Ben Stopford)`
- **THEN** the book identifier is `deds`

#### Scenario: Title yields no usable words

- **WHEN** a title line produces an empty identifier after slugging
- **THEN** the command reports a failure naming the offending title line and
  exits `1`, rather than writing a book with an empty identifier

### Requirement: Author field is separated from the title

A trailing `(...)` group on the title line SHALL be treated as the author field
and excluded from identifier derivation. It SHALL be retained on the book
record. Its internal format SHALL NOT be interpreted — `Ries, Eric`,
`Eric Evans` and `Mark Richards and Neal Ford` are all stored as written.

#### Scenario: Author excluded from the identifier

- **WHEN** the title line is `The Mom Test (Rob Fitzpatrick)`
- **THEN** the book identifier is `the-mom-test` and the stored author is
  `Rob Fitzpatrick`

#### Scenario: Title with no parenthesised author

- **WHEN** a title line has no trailing parenthesised group
- **THEN** the whole line is used for identifier derivation and the book has no
  recorded author

### Requirement: Identical title lines resolve to one book

Two loads of the same title line — whether within one file or across separate
sync runs — SHALL resolve to the same book identifier and therefore the same
book directory. A sync SHALL NOT create a second book for a title it has
already seen.

#### Scenario: Re-syncing the same source file

- **WHEN** `sync` runs twice against an unchanged source file
- **THEN** the second run creates no additional book directory and no
  additional clipping files

### Requirement: Distinct title lines mapping to one identifier are recorded

When two different title lines produce the same book identifier, their records
SHALL share one book directory and every distinct title line SHALL be recorded
in the book's `sources` list, so that an incorrect merge is visible on
inspection.

#### Scenario: Two title strings slug identically

- **WHEN** records carry the title lines `Harry Potter and the Philosopher's Stone (Rowling, J.K.)`
  and `Harry Potter and the Chamber of Secrets (Rowling, J.K.)`
- **THEN** both are written under `harry-potter-and-the` and the book's
  `sources` list contains both title lines verbatim

### Requirement: Clipping identifier derivation

The clipping identifier SHALL be the first 12 hexadecimal characters of the
SHA-256 digest of the book identifier, the record kind, the location range
start, the location range end, and the verbatim local timestamp string, joined
by a separator that cannot occur in any of them. Clipping text SHALL NOT
contribute to the digest.

#### Scenario: Identifier shape

- **WHEN** an identifier is derived
- **THEN** it is 12 lowercase hexadecimal characters

#### Scenario: Identifier is stable across runs

- **WHEN** the same record is parsed in two separate sync runs
- **THEN** both runs produce the same clipping identifier

#### Scenario: Records differing only by timestamp

- **WHEN** two records in one book share kind and location range but differ in
  timestamp
- **THEN** they receive different clipping identifiers

#### Scenario: Reference file yields no collisions

- **WHEN** identifiers are derived for all 1342 records of the reference sample
- **THEN** 1342 distinct identifiers are produced

#### Scenario: Text change does not change the identifier

- **WHEN** a record's stored text is later corrected or enriched
- **THEN** its clipping identifier is unchanged

### Requirement: Identifier collisions fail loudly

When two records that are not byte-identical derive the same clipping
identifier, the command SHALL report both records and exit `1`. It SHALL NOT
overwrite one with the other.

#### Scenario: Two distinct records share an identifier

- **WHEN** two records in one book share kind, location range and timestamp but
  differ in text
- **THEN** the sync reports the collision naming both records and exits `1`

### Requirement: Identity derivation takes no configuration input

Both identifier derivations SHALL be pure functions of the source file. No
configuration value, environment variable, timezone, locale or clock reading
SHALL influence an identifier or a store path.

#### Scenario: Identical input on two machines

- **WHEN** the same source file is synced on two machines with different
  system timezones and locales
- **THEN** both produce identical book identifiers, clipping identifiers and
  store file paths
