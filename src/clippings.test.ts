import { describe, expect, test } from "bun:test";
import { DRM_SENTINEL, parseClippings, parseTimestamp } from "./clippings";

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
      record("﻿Wieczorny_Pociag_Nocny (Jan Kowalski)", HIGHLIGHT_META, "marked");
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
    const text = "a b​c — “quoted”";
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
    expect(parseClippings("﻿\r\n  \r\n")).toEqual({ records: [], failures: [] });
  });

  test("a trailing separator does not produce an empty record", () => {
    const { records, failures } = parseClippings(record("B (A)", HIGHLIGHT_META, "only"));
    expect(records).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});
