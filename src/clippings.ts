// Decoding `My Clippings.txt` into typed records. Parsing is total: every
// segment of the source either becomes a record or becomes a reported failure,
// never a silent skip.

export const RECORD_SEPARATOR = "==========\r\n";

// Amazon writes this literal text in place of a highlight once a book's DRM
// clipping quota is spent. It is identical across every record that carries it,
// so it is never treated as user-authored text.
export const DRM_SENTINEL = "<You have reached the clipping limit for this item>";

export type ClippingKind = "highlight" | "note" | "bookmark";

export interface LocationRange {
  lo: number;
  hi: number;
}

export interface ClippingRecord {
  // The title line as written by the device, byte-order mark removed. The
  // author parenthetical is still attached; splitting it is identity's job.
  titleLine: string;
  kind: ClippingKind;
  page: string | null;
  location: LocationRange;
  // Zone-less local wall-clock time, `YYYY-MM-DDTHH:MM:SS`. No conversion is
  // applied: the device writes local time with no zone, and inventing one
  // would make every store path depend on a configured value.
  timestamp: string;
  // Verbatim, including non-breaking spaces, zero-width spaces and typographic
  // punctuation. Normalisation happens only when comparing.
  text: string;
  empty: boolean;
  drmLimited: boolean;
}

export interface ParseFailure {
  // 1-based position of the record in the source file.
  record: number;
  message: string;
}

export interface ParseResult {
  records: ClippingRecord[];
  failures: ParseFailure[];
}

const KINDS: Record<string, ClippingKind> = {
  Highlight: "highlight",
  Note: "note",
  Bookmark: "bookmark",
};

const METADATA =
  /^- Your (Highlight|Note|Bookmark) on (?:page (.+?) \| )?Location (\d+)(?:-(\d+))? \| Added on (.+)$/;

const TIMESTAMP = /^[A-Za-z]+, ([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// parseTimestamp reads the device's English long date into a zone-less local
// date-time string. It returns null rather than throwing so the caller can
// report the record's position alongside the offending line.
export function parseTimestamp(value: string): string | null {
  const match = TIMESTAMP.exec(value);
  if (match === null) return null;
  const [, monthName, day, year, hour, minute, second, meridiem] = match;
  if (
    monthName === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    meridiem === undefined
  ) {
    return null;
  }
  const month = MONTHS.indexOf(monthName);
  if (month < 0) return null;
  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > 31) return null;
  let hours = Number(hour);
  if (hours < 1 || hours > 12) return null;
  if (meridiem === "AM" && hours === 12) hours = 0;
  if (meridiem === "PM" && hours !== 12) hours += 12;
  return `${year}-${pad(month + 1, 2)}-${pad(dayNumber, 2)}T${pad(hours, 2)}:${minute}:${second}`;
}

function parseRecord(segment: string): ClippingRecord | string {
  const lines = segment.split("\r\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 4) {
    return `expected a title, metadata, blank and content line, found ${lines.length} line(s)`;
  }
  const [rawTitle, metadata, blank, text] = lines;
  if (
    rawTitle === undefined ||
    metadata === undefined ||
    blank === undefined ||
    text === undefined
  ) {
    return "expected a title, metadata, blank and content line";
  }
  if (blank !== "") return `expected an empty third line, found ${JSON.stringify(blank)}`;

  const titleLine = rawTitle.replace(/^\uFEFF/, "");
  const meta = METADATA.exec(metadata);
  if (meta === null) return `unrecognised metadata line: ${JSON.stringify(metadata)}`;
  const [, kindWord, page, lo, hi, added] = meta;
  if (kindWord === undefined || lo === undefined || added === undefined) {
    return `unrecognised metadata line: ${JSON.stringify(metadata)}`;
  }
  const kind = KINDS[kindWord];
  if (kind === undefined) return `unrecognised clipping kind: ${kindWord}`;

  const timestamp = parseTimestamp(added);
  if (timestamp === null) return `unrecognised date: ${JSON.stringify(added)}`;

  const trimmed = text.trim();
  return {
    titleLine,
    kind,
    page: page ?? null,
    location: { lo: Number(lo), hi: hi === undefined ? Number(lo) : Number(hi) },
    timestamp,
    text,
    empty: trimmed === "",
    drmLimited: trimmed === DRM_SENTINEL,
  };
}

// parseClippings splits the source on the device's record separator and reads
// every segment. A segment that does not parse is reported with its position
// instead of being dropped, so a caller can refuse to sync a file it only
// partly understood.
export function parseClippings(source: string): ParseResult {
  const records: ClippingRecord[] = [];
  const failures: ParseFailure[] = [];
  const segments = source.split(RECORD_SEPARATOR);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (segment.replace(/^\uFEFF/, "").trim() === "") continue;
    const parsed = parseRecord(segment);
    if (typeof parsed === "string") failures.push({ record: i + 1, message: parsed });
    else records.push(parsed);
  }
  return { records, failures };
}
