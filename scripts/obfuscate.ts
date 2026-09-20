#!/usr/bin/env bun
// One-off tool: turns a real `My Clippings.txt` into the committed test
// fixture. It is not part of the binary — `bun build --compile` starts at
// `src/cli.ts` and never reaches `scripts/`.
//
//   bun scripts/obfuscate.ts --in "My Clippings.txt" --out src/fixtures/clippings.txt \
//     --cover --append scripts/fixture-cases.txt
//
// What it preserves, because the parser and the consolidation rules contract on
// it: record boundaries, CRLF line endings, byte-order marks and their
// positions, metadata lines and timestamps, empty content lines, the DRM
// clipping-limit sentinel, and every invisible character inside a text.
//
// What it replaces: book titles (with synthetic titles chosen to cover each
// identity shape) and user-authored words. Substitution is word-level and
// injective, so prefix, substring and equality relationships between two
// highlights survive it — which is what the collapse rules are tested on.

import { DRM_SENTINEL, parseClippings, RECORD_SEPARATOR } from "../src/clippings";
import { consolidate, normalise } from "../src/consolidate";
import type { Clipping } from "../src/identity";
import { deriveClippings } from "../src/identity";

// Titles are assigned to the real books in first-appearance order. The list is
// ordered so that the identity shapes the specs enumerate all land somewhere:
// `Last, First` and `First Last` authors, a multi-author string, a hyphenated
// sideload filename, an underscored filename, an ISBN-only title, a title
// shorter than four words, non-ASCII letters, and two titles that slug to one
// identifier.
const TITLES = [
  "The Silent Ledger (Quinn, Marta)",
  "The Quiet Test (Nora Bell)",
  "patterns-of-distributed-systems-an-engineering-primer-ada-lovelace-grace-hopper-press (Ada Lovelace and Grace Hopper)",
  "Wieczorny_Pociag_Nocny (Jan Kowalski)",
  "9781234567890 (Alan Turing)",
  "noms (Iris Chen)",
  "Opowieść. O zażółconej gęśli jaźni (Zofia Nałkowska)",
  "Distant Shores: A Study of Tidal Drift and Coastal Memory (Hale, Robert)",
  "The Amber Corridor (Osei, Kwame)",
  "Lanterns for the Harbour Watch (Ferrante, Lia)",
  "A Grammar of Small Machines (Devi, Anita)",
  "Salt and Iron (Bo Yang)",
  "The Cartographer's Apology (Lindqvist, Mio)",
  "Fieldnotes_From_The_Interior (Hugo Marek)",
  "measuring-the-tide-a-field-handbook-for-coastal-observers-press (Okonkwo, Ada)",
  "Half a Bridge (Rui Santos)",
  "The Winter Archivist (Abadi, Leila)",
  "Tysiąc żurawi nad rzeką (Emil Wójcik)",
  "Harry Potter and the Philosopher's Stone (Rowling, J.K.)",
  "Harry Potter and the Chamber of Secrets (Rowling, J.K.)",
];

// A syllable alphabet the padding syllable `ne` is deliberately absent from, so
// a synthetic word decodes back to its ordinal: the mapping is injective and
// two different real words can never become the same synthetic word.
const SYLLABLES = [
  "ka", "lo", "mi", "re", "tu", "na", "si", "ve", "do", "pa", "fe", "ru", "zo", "li", "ma",
];
const PAD = "ne";

function syntheticWord(ordinal: number): string {
  let word = "";
  let value = ordinal;
  do {
    const syllable = SYLLABLES[value % SYLLABLES.length];
    word += syllable ?? "ka";
    value = Math.floor(value / SYLLABLES.length);
  } while (value > 0);
  // One trailing pad syllable keeps the shortest words from all looking alike;
  // `ne` is outside the alphabet above, so the word still decodes to its
  // ordinal and the substitution stays injective.
  return word + PAD;
}

function applyCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return replacement.toUpperCase();
  }
  const first = source[0];
  if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement[0]?.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

class Vocabulary {
  private readonly words = new Map<string, string>();

  substitute(text: string): string {
    return text.replace(WORD, (word) => {
      if (/^\p{N}+$/u.test(word)) return this.number(word);
      const key = word.toLowerCase();
      let replacement = this.words.get(key);
      if (replacement === undefined) {
        replacement = syntheticWord(this.words.size);
        this.words.set(key, replacement);
      }
      return applyCase(word, replacement);
    });
  }

  private number(word: string): string {
    // Digits carry no personal text, but they are still user-visible content,
    // so they are shifted deterministically while keeping their width.
    let digits = "";
    for (const digit of word) digits += String((Number(digit) + 7) % 10);
    return digits;
  }
}

function obfuscateSegment(segment: string, titles: Map<string, string>, vocab: Vocabulary): string {
  const lines = segment.split("\r\n");
  const [rawTitle, metadata, blank, text] = lines;
  if (rawTitle === undefined || metadata === undefined || blank === undefined || text === undefined) {
    throw new Error(`segment is not a record: ${JSON.stringify(segment)}`);
  }
  const mark = rawTitle.startsWith("\uFEFF") ? "\uFEFF" : "";
  const title = rawTitle.slice(mark.length);
  const replacement = titles.get(title);
  if (replacement === undefined) throw new Error(`no synthetic title for ${JSON.stringify(title)}`);
  const content = text.trim() === "" || text.trim() === DRM_SENTINEL ? text : vocab.substitute(text);
  return `${mark}${replacement}\r\n${metadata}\r\n\r\n${content}\r\n`;
}

// ---------------------------------------------------------------------------
// Coverage selection: which real records to carry into the fixture.

function intersects(a: Clipping, b: Clipping): boolean {
  return a.location.lo <= b.location.hi && b.location.lo <= a.location.hi;
}

function contains(a: string, b: string): boolean {
  return a !== b && (a.includes(b) || b.includes(a));
}

function selectCovering(clippings: Clipping[]): Set<number> {
  const picked = new Set<number>();
  const index = new Map<string, number>(clippings.map((c, i) => [c.id, i]));
  const take = (...chosen: Clipping[]): void => {
    for (const clipping of chosen) {
      const at = index.get(clipping.id);
      if (at !== undefined) picked.add(at);
    }
  };
  const first = (predicate: (c: Clipping, i: number) => boolean): void => {
    const found = clippings.find((c, i) => predicate(c, i));
    if (found !== undefined) take(found);
  };

  // Structural cases the parser contracts on.
  first((c) => c.page !== null && c.kind === "highlight");
  first((c) => c.page === null && c.kind === "highlight");
  first((c) => c.kind === "note");
  first((c) => c.page !== null && /^[ivxlcdm]+$/i.test(c.page));
  first((c) => c.kind === "bookmark" && c.empty);
  first((c) => c.kind === "highlight" && c.empty);
  first((c) => c.text.includes("\u00a0"));
  first((c) => c.text.includes("\u200b"));

  const normalised = new Map(clippings.map((c) => [c.id, normalise(c.text)]));
  const text = (c: Clipping): string => normalised.get(c.id) ?? "";
  const highlights = clippings.filter((c) => c.kind === "highlight");
  const plain = highlights.filter((c) => !c.empty && !c.drmLimited);

  // Two overlapping DRM sentinels in one book.
  const sentinels = highlights.filter((c) => c.drmLimited);
  for (const a of sentinels) {
    const partner = sentinels.find((b) => b.id !== a.id && b.book === a.book && intersects(a, b));
    if (partner !== undefined) {
      take(a, partner);
      break;
    }
  }

  // An empty-content highlight overlapping one that has text.
  for (const blank of highlights.filter((c) => c.empty)) {
    const partner = plain.find((b) => b.book === blank.book && intersects(blank, b));
    if (partner !== undefined) {
      take(blank, partner);
      break;
    }
  }

  // Collapse outcomes. `chain` needs three links, so it is searched first and
  // its members are excluded from the simpler cases to keep them distinct.
  let prefix = false;
  let inner = false;
  let identical = false;
  let unrelated = false;
  let disjoint = false;
  let crossBook = false;
  let chain = false;
  for (const a of plain) {
    for (const b of plain) {
      if (a.id >= b.id) continue;
      const [ta, tb] = [text(a), text(b)];
      if (a.book === b.book && intersects(a, b)) {
        if (!chain && contains(ta, tb)) {
          const longer = ta.length >= tb.length ? a : b;
          const third = plain.find(
            (c) =>
              c.book === a.book &&
              c.id !== a.id &&
              c.id !== b.id &&
              intersects(c, longer) &&
              text(c).length > text(longer).length &&
              text(c).includes(text(longer)),
          );
          if (third !== undefined) {
            take(a, b, third);
            chain = true;
            continue;
          }
        }
        if (ta === tb && !identical) {
          take(a, b);
          identical = true;
        } else if (!prefix && contains(ta, tb) && (ta.startsWith(tb) || tb.startsWith(ta))) {
          take(a, b);
          prefix = true;
        } else if (!inner && contains(ta, tb) && !ta.startsWith(tb) && !tb.startsWith(ta)) {
          take(a, b);
          inner = true;
        } else if (!unrelated && !contains(ta, tb) && ta !== tb) {
          take(a, b);
          unrelated = true;
        }
      } else if (contains(ta, tb)) {
        if (a.book === b.book && !disjoint) {
          take(a, b);
          disjoint = true;
        } else if (a.book !== b.book && !crossBook) {
          take(a, b);
          crossBook = true;
        }
      }
    }
  }

  // Attachment outcomes, computed against the consolidated highlights so that
  // a note's candidates are the ones it would really have.
  const { kept } = consolidate(clippings);
  const keptHighlights = kept.filter((c) => c.kind === "highlight");
  const candidatesOf = (note: Clipping): Clipping[] =>
    keptHighlights.filter(
      (h) =>
        h.book === note.book &&
        h.location.lo <= note.location.lo &&
        h.location.hi >= note.location.hi,
    );
  const notes = clippings.filter((c) => c.kind === "note");
  const width = (c: Clipping): number => c.location.hi - c.location.lo;

  let single = false;
  let widths = false;
  let equalWidth = false;
  let sentinelTarget = false;
  let duplicateNotes = false;
  for (const note of notes) {
    const candidates = candidatesOf(note);
    if (!single && candidates.length === 1) {
      take(note, ...candidates);
      single = true;
    }
    if (!widths && candidates.length >= 2) {
      const sorted = [...candidates].sort((a, b) => width(a) - width(b));
      const [narrow, wide] = sorted;
      if (narrow !== undefined && wide !== undefined && width(narrow) < width(wide)) {
        take(note, narrow, wide);
        widths = true;
      }
    }
    if (!equalWidth && candidates.length >= 2) {
      for (const a of candidates) {
        const partner = candidates.find((b) => b.id !== a.id && width(b) === width(a));
        if (partner !== undefined) {
          take(note, a, partner);
          equalWidth = true;
          break;
        }
      }
    }
    if (!sentinelTarget) {
      const sentinel = candidates.find((c) => c.drmLimited);
      if (sentinel !== undefined) {
        take(note, sentinel);
        sentinelTarget = true;
      }
    }
    if (!duplicateNotes) {
      const twin = notes.find(
        (other) =>
          other.id !== note.id &&
          other.book === note.book &&
          other.location.lo === note.location.lo &&
          normalise(other.text) === normalise(note.text),
      );
      if (twin !== undefined) {
        take(note, twin);
        duplicateNotes = true;
      }
    }
  }

  return picked;
}

function parseRange(spec: string): Set<number> {
  const picked = new Set<number>();
  for (const part of spec.split(",")) {
    const [from, to] = part.split("-");
    if (from === undefined) continue;
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    for (let i = start; i <= end; i++) picked.add(i - 1);
  }
  return picked;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const input = flag("--in");
const output = flag("--out");
if (input === undefined || output === undefined) {
  console.error("usage: bun scripts/obfuscate.ts --in <clippings> --out <fixture> [--cover|--pick 1,4-9] [--append <file>]");
  process.exit(2);
}

const raw = await Bun.file(input).text();
const segments = raw
  .split(RECORD_SEPARATOR)
  .filter((segment) => segment.replace(/^\uFEFF/, "").trim() !== "");
const { records, failures } = parseClippings(raw);
if (failures.length > 0) {
  console.error(`${failures.length} record(s) did not parse; refusing to build a partial fixture`);
  process.exit(1);
}
if (records.length !== segments.length) {
  console.error("record and segment counts disagree; refusing to build a misaligned fixture");
  process.exit(1);
}

const clippings = deriveClippings(records);
const pickSpec = flag("--pick");
const picked =
  pickSpec !== undefined
    ? parseRange(pickSpec)
    : process.argv.includes("--cover")
      ? selectCovering(clippings)
      : new Set(records.map((_, i) => i));

const titles = new Map<string, string>();
for (const record of records) {
  if (titles.has(record.titleLine)) continue;
  const replacement = TITLES[titles.size] ?? `Synthetic Volume ${titles.size} (Anon, A.)`;
  titles.set(record.titleLine, replacement);
}

const vocab = new Vocabulary();
let out = "";
let written = 0;
for (let i = 0; i < segments.length; i++) {
  if (!picked.has(i)) continue;
  const segment = segments[i];
  if (segment === undefined) continue;
  out += obfuscateSegment(segment, titles, vocab) + RECORD_SEPARATOR;
  written++;
}

const appended = flag("--append");
if (appended !== undefined) out += await Bun.file(appended).text();

await Bun.write(output, out);
const summary: Record<string, number> = {};
for (const record of records.filter((_, i) => picked.has(i))) {
  summary[record.kind] = (summary[record.kind] ?? 0) + 1;
}
console.error(
  `wrote ${written} obfuscated record(s) to ${output}: ${JSON.stringify(summary)}${appended === undefined ? "" : ` plus the constructed cases in ${appended}`}`,
);
