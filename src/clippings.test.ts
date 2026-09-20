import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DRM_SENTINEL, parseClippings, parseTimestamp } from "./clippings";
import { fixtureExpectations, fixtureSource } from "./fixtures/load";

// Records are built here rather than read from the fixture, because the
// malformed cases must not live in a fixture that is required to parse cleanly.
function record(title: string, metadata: string, content: string): string {
  return `${title}\r\n${metadata}\r\n\r\n${content}\r\n==========\r\n`;
}

const HIGHLIGHT_META =
  "- Your Highlight on page 42 | Location 272-277 | Added on Friday, January 2, 2026 7:13:49 PM";

describe("record splitting", () => {
  test("a well-formed file splits into one record per segment", () => {
    const source =
      record("Book One (Author, A.)", HIGHLIGHT_META, "first") +
      record("Book Two (Author, B.)", HIGHLIGHT_META, "second");
    const { records, failures } = parseClippings(source);
    expect(failures).toEqual([]);
    expect(records.map((r) => r.text)).toEqual(["first", "second"]);
  });

  test("a record with an unexpected line count is a reported failure", () => {
    const source =
      record("Book One (Author, A.)", HIGHLIGHT_META, "first") +
      `Book Two (Author, B.)\r\n${HIGHLIGHT_META}\r\n\r\ntwo\r\nlines\r\n==========\r\n`;
    const { records, failures } = parseClippings(source);
    expect(records).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.record).toBe(2);
    expect(failures[0]?.message).toContain("5 line(s)");
  });

  test("a record whose third line is not blank is a reported failure", () => {
    const source = `Book One (Author, A.)\r\n${HIGHLIGHT_META}\r\nnot blank\r\ntext\r\n==========\r\n`;
    const { records, failures } = parseClippings(source);
    expect(records).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("empty third line");
  });
});

describe("byte-order marks", () => {
  test("a mid-file mark is stripped and does not change the title", () => {
    const source =
      record("Wieczorny_Pociag_Nocny (Jan Kowalski)", HIGHLIGHT_META, "plain") +
      record("\uFEFFWieczorny_Pociag_Nocny (Jan Kowalski)", HIGHLIGHT_META, "marked");
    const { records, failures } = parseClippings(source);
    expect(failures).toEqual([]);
    expect(records[1]?.titleLine).toBe("Wieczorny_Pociag_Nocny (Jan Kowalski)");
    expect(records[0]?.titleLine).toBe(records[1]?.titleLine);
  });
});

describe("metadata grammar", () => {
  test("highlight with a page and a location range", () => {
    const { records, failures } = parseClippings(record("B (A)", HIGHLIGHT_META, "text"));
    expect(failures).toEqual([]);
    expect(records[0]).toMatchObject({
      kind: "highlight",
      page: "42",
      location: { lo: 272, hi: 277 },
      timestamp: "2026-01-02T19:13:49",
    });
  });

  test("highlight without a page field", () => {
    const meta =
      "- Your Highlight on Location 2778-2781 | Added on Friday, February 16, 2024 9:17:49 PM";
    const { records } = parseClippings(record("B (A)", meta, "text"));
    expect(records[0]?.page).toBeNull();
    expect(records[0]?.location).toEqual({ lo: 2778, hi: 2781 });
  });

  test("note with a single location has lo equal to hi", () => {
    const meta =
      "- Your Note on page 96 | Location 8538 | Added on Friday, February 16, 2024 9:17:49 PM";
    const { records } = parseClippings(record("B (A)", meta, "a note"));
    expect(records[0]?.kind).toBe("note");
    expect(records[0]?.location).toEqual({ lo: 8538, hi: 8538 });
  });

  test("bookmark metadata parses", () => {
    const meta =
      "- Your Bookmark on Location 522 | Added on Tuesday, September 10, 2024 1:29:05 PM";
    const { records } = parseClippings(record("B (A)", meta, ""));
    expect(records[0]?.kind).toBe("bookmark");
    expect(records[0]?.timestamp).toBe("2024-09-10T13:29:05");
  });

  test("an unrecognised metadata line is a reported failure quoting the line", () => {
    const meta = "- Your Doodle on Location 522 | Added on Tuesday, September 10, 2024 1:29:05 PM";
    const { records, failures } = parseClippings(record("B (A)", meta, "x"));
    expect(records).toEqual([]);
    expect(failures[0]?.message).toContain("unrecognised metadata line");
    expect(failures[0]?.message).toContain(meta);
  });
});

describe("page", () => {
  test("a roman-numeral page stays a string", () => {
    const meta =
      "- Your Highlight on page xxvii | Location 300-301 | Added on Sunday, May 31, 2026 8:56:38 AM";
    const { records } = parseClippings(record("B (A)", meta, "text"));
    expect(records[0]?.page).toBe("xxvii");
  });
});

describe("timestamps", () => {
  test("read verbatim as zone-less local wall-clock time", () => {
    expect(parseTimestamp("Friday, January 2, 2026 7:13:49 PM")).toBe("2026-01-02T19:13:49");
  });

  test("midnight and noon cross the meridiem correctly", () => {
    expect(parseTimestamp("Friday, January 2, 2026 12:00:00 AM")).toBe("2026-01-02T00:00:00");
    expect(parseTimestamp("Friday, January 2, 2026 12:00:00 PM")).toBe("2026-01-02T12:00:00");
  });

  test("an unparseable date is a reported failure", () => {
    const meta = "- Your Highlight on Location 1-2 | Added on 2026-01-02T19:13:49Z";
    const { records, failures } = parseClippings(record("B (A)", meta, "text"));
    expect(records).toEqual([]);
    expect(failures[0]?.message).toContain("unrecognised date");
  });

  test("no timezone conversion is applied", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const first = parseTimestamp("Friday, January 2, 2026 7:13:49 PM");
      process.env.TZ = "Pacific/Niue";
      expect(parseTimestamp("Friday, January 2, 2026 7:13:49 PM")).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("content", () => {
  test("invisible characters are preserved verbatim", () => {
    const text = "a\u00a0b\u200bc — “quoted”";
    const { records } = parseClippings(record("B (A)", HIGHLIGHT_META, text));
    expect(records[0]?.text).toBe(text);
  });

  test("an empty content line is flagged, not dropped", () => {
    const meta =
      "- Your Bookmark on page 554 | Location 6784 | Added on Sunday, July 28, 2024 7:32:27 PM";
    const { records } = parseClippings(record("B (A)", meta, ""));
    expect(records[0]).toMatchObject({ kind: "bookmark", empty: true, drmLimited: false });
  });

  test("the clipping-limit sentinel is flagged", () => {
    const { records } = parseClippings(record("B (A)", HIGHLIGHT_META, ` ${DRM_SENTINEL}`));
    expect(records[0]).toMatchObject({ drmLimited: true, empty: false });
    expect(records[0]?.text).toBe(` ${DRM_SENTINEL}`);
  });
});

describe("totality", () => {
  test("an empty source yields no records and no failures", () => {
    expect(parseClippings("")).toEqual({ records: [], failures: [] });
    expect(parseClippings("\uFEFF\r\n  \r\n")).toEqual({ records: [], failures: [] });
  });

  test("a trailing separator does not produce an empty record", () => {
    const { records, failures } = parseClippings(record("B (A)", HIGHLIGHT_META, "only"));
    expect(records).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

describe("the committed fixture", () => {
  const source = fixtureSource();
  const expected = fixtureExpectations();
  const { records, failures } = parseClippings(source);

  test("parses completely, with the recorded per-kind counts", () => {
    expect(failures).toEqual([]);
    expect(records).toHaveLength(expected.records);
    const kinds = { highlight: 0, note: 0, bookmark: 0 };
    for (const record of records) kinds[record.kind]++;
    expect(kinds).toEqual(expected.kinds);
  });

  test("carries a byte-order mark on a title line at a non-zero offset", () => {
    const at = source.indexOf("\uFEFF", 1);
    expect(at).toBeGreaterThan(0);
    expect(records.some((r) => r.titleLine.startsWith("\uFEFF"))).toBe(false);
  });

  test("carries both metadata shapes and a single-location note line", () => {
    expect(records.some((r) => r.kind === "highlight" && r.page !== null)).toBe(true);
    expect(records.some((r) => r.kind === "highlight" && r.page === null)).toBe(true);
    expect(records.some((r) => r.kind === "note" && r.location.lo === r.location.hi)).toBe(true);
  });

  test("carries a roman-numeral page", () => {
    expect(records.some((r) => r.page !== null && /^[ivxlcdm]+$/i.test(r.page))).toBe(true);
  });

  test("carries an empty bookmark, an empty highlight and a DRM sentinel", () => {
    expect(records.some((r) => r.kind === "bookmark" && r.empty)).toBe(true);
    expect(records.some((r) => r.kind === "highlight" && r.empty)).toBe(true);
    expect(records.some((r) => r.drmLimited)).toBe(true);
  });

  test("carries invisible characters and non-ASCII letters in a title and a text", () => {
    expect(records.some((r) => r.text.includes("\u00a0"))).toBe(true);
    expect(records.some((r) => r.text.includes("\u200b"))).toBe(true);
    expect(records.some((r) => /[\u0080-\uffff]/.test(r.titleLine))).toBe(true);
    expect(records.some((r) => /[\u0080-\uffff]/.test(r.text))).toBe(true);
  });

  test("preserves the record shape of a real file byte for byte", () => {
    expect(source).toContain("\r\n==========\r\n");
    expect(source.endsWith("==========\r\n")).toBe(true);
    expect(source.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });
});

// The privacy requirement is about the repository, not the parser, so these
// read the committed fixture and the working tree rather than a constructed
// string. The comparison against a real clippings file only runs on a machine
// that has one; the gitignore check runs everywhere.
describe("the committed fixture carries no personal data", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const realPath = fileURLToPath(new URL("../My Clippings.txt", import.meta.url));
  const realSource = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;

  test("a real clippings file is ignored and untracked", () => {
    const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", "My Clippings.txt"], {
      cwd: repository,
    });
    expect(ignored.exitCode).toBe(0);
    const tracked = Bun.spawnSync(["git", "ls-files", "--", "My Clippings.txt"], {
      cwd: repository,
    });
    expect(new TextDecoder().decode(tracked.stdout).trim()).toBe("");
  });

  test.skipIf(realSource === null)("no fixture text or title appears in the real file", () => {
    if (realSource === null) return;
    const { records } = parseClippings(fixtureSource());
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      if (record.text.trim() !== "" && !record.drmLimited) {
        expect(realSource.includes(record.text)).toBe(false);
      }
    }
    for (const titleLine of new Set(records.map((r) => r.titleLine))) {
      expect(realSource.includes(titleLine)).toBe(false);
    }
  });
});
