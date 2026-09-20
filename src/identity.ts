// Deriving the identifiers the store's paths are made of. Every function here
// is a pure function of the parsed records: no environment variable, timezone,
// locale or clock reading may influence an identifier, because an identifier
// that depends on configuration cannot be a stable path.

import { createHash } from "node:crypto";
import { SyncError } from "./args";
import type { ClippingKind, ClippingRecord, LocationRange } from "./clippings";

export interface Clipping {
  id: string;
  kind: ClippingKind;
  book: string;
  timestamp: string;
  page: string | null;
  location: LocationRange;
  text: string;
  // Reserved: `My Clippings.txt` carries no chapter information at all.
  chapter: null;
  empty: boolean;
  drmLimited: boolean;
  // Highlights only: the identifiers this highlight collapsed, sorted.
  supersedes: string[];
  // Notes only: the highlight this note annotates, or null.
  attachedTo: string | null;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
}

// Letters ASCII folding cannot reach by stripping combining marks: they are
// distinct code points, not a base letter plus a diacritic.
const FOLD: Record<string, string> = {
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ß: "ss",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
  ı: "i",
};

export function foldAscii(value: string): string {
  const stripped = value.normalize("NFD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of stripped) out += FOLD[ch] ?? ch;
  return out;
}

export interface TitleParts {
  title: string;
  author: string | null;
}

// splitTitleLine separates a trailing parenthesised author field from the
// title. The author is one opaque string: the device's own conventions are
// mutually incompatible (`Ries, Eric`, `Eric Evans`,
// `Ada Lovelace and Grace Hopper`), so parsing it would be guessing.
export function splitTitleLine(line: string): TitleParts {
  const match = /^(.*)\(([^()]*)\)\s*$/.exec(line.trim());
  if (match === null) return { title: line.trim(), author: null };
  const [, title, author] = match;
  if (title === undefined || author === undefined) return { title: line.trim(), author: null };
  const bare = title.trim();
  if (bare === "") return { title: line.trim(), author: null };
  return { title: bare, author: author.trim() };
}

// deriveBookId slugs the title line. `-` and `_` are word separators because
// sideloaded books carry their filename as the title, which would otherwise be
// a single 80-character word. ASCII folding is not cosmetic: macOS stores
// filenames NFD and Linux NFC, so an unfolded directory name can appear as two
// distinct paths in one repository cloned across machines.
export function deriveBookId(titleLine: string): string {
  const { title } = splitTitleLine(titleLine);
  const words = foldAscii(title.replace(/[-_]/g, " "))
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter((word) => word !== "")
    .slice(0, 4)
    .map((word) => word.toLowerCase());
  if (words.length === 0) {
    throw new SyncError(`title line yields an empty book identifier: ${JSON.stringify(titleLine)}`);
  }
  return words.join("-");
}

export function deriveBook(titleLine: string): Book {
  const { title, author } = splitTitleLine(titleLine);
  return { id: deriveBookId(titleLine), title, author };
}

// NUL cannot occur in a book identifier, a kind, a number or a timestamp, so
// joining the digest inputs with it cannot let two different tuples collide by
// shifting a separator.
const FIELD_SEPARATOR = "\u0000";

// deriveClippingId hashes book, kind, location range and timestamp — and not
// the text. A later correction or enrichment of the text then lands on a
// consumer as one `modify`, instead of re-identifying the whole tree.
export function deriveClippingId(
  book: string,
  kind: ClippingKind,
  location: LocationRange,
  timestamp: string,
): string {
  const key = [book, kind, String(location.lo), String(location.hi), timestamp].join(
    FIELD_SEPARATOR,
  );
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
}

export function toClipping(record: ClippingRecord): Clipping {
  const book = deriveBookId(record.titleLine);
  return {
    id: deriveClippingId(book, record.kind, record.location, record.timestamp),
    kind: record.kind,
    book,
    timestamp: record.timestamp,
    page: record.page,
    location: { ...record.location },
    text: record.text,
    chapter: null,
    empty: record.empty,
    drmLimited: record.drmLimited,
    supersedes: [],
    attachedTo: null,
  };
}

function describe(clipping: Clipping): string {
  return `${clipping.book} ${clipping.kind} ${clipping.location.lo}-${clipping.location.hi} at ${clipping.timestamp}: ${JSON.stringify(clipping.text)}`;
}

// deriveClippings turns parsed records into identified clippings and refuses a
// source in which two records that are not the same record share an identifier,
// rather than letting one overwrite the other in the store.
export function deriveClippings(records: ClippingRecord[]): Clipping[] {
  const byId = new Map<string, Clipping>();
  const out: Clipping[] = [];
  for (const record of records) {
    const clipping = toClipping(record);
    const seen = byId.get(clipping.id);
    if (seen !== undefined) {
      if (seen.text !== clipping.text || seen.page !== clipping.page) {
        throw new SyncError(
          `two different records share the clipping identifier ${clipping.id}:\n  ${describe(seen)}\n  ${describe(clipping)}`,
        );
      }
      continue;
    }
    byId.set(clipping.id, clipping);
    out.push(clipping);
  }
  return out;
}
