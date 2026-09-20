import { describe, expect, test } from "bun:test";
import { DRM_SENTINEL, parseClippings } from "./clippings";
import { consolidate, normalise, unionClippings } from "./consolidate";
import { fixtureExpectations, fixtureSource } from "./fixtures/load";
import type { Clipping } from "./identity";
import { deriveClippingId, deriveClippings } from "./identity";

interface Spec {
  book?: string;
  kind?: Clipping["kind"];
  lo: number;
  hi?: number;
  at?: string;
  text?: string;
  empty?: boolean;
  drmLimited?: boolean;
  supersedes?: string[];
}

function clip(spec: Spec): Clipping {
  const book = spec.book ?? "the-silent-ledger";
  const kind = spec.kind ?? "highlight";
  const location = { lo: spec.lo, hi: spec.hi ?? spec.lo };
  const timestamp = spec.at ?? "2026-01-02T19:13:49";
  const text = spec.text ?? "";
  return {
    id: deriveClippingId(book, kind, location, timestamp),
    kind,
    book,
    timestamp,
    page: null,
    location,
    text,
    chapter: null,
    empty: spec.empty ?? text.trim() === "",
    drmLimited: spec.drmLimited ?? false,
    supersedes: spec.supersedes ?? [],
    attachedTo: null,
  };
}

const ids = (clippings: Clipping[]): string[] => clippings.map((c) => c.id).sort();

describe("normalise", () => {
  test("invisible characters do not defeat comparison", () => {
    const a = "a\u00a0quiet  test";
    const b = "a quiet\u200b test";
    expect(normalise(a)).toBe(normalise(b));
    expect(a).not.toBe(b);
  });
});

describe("collapse", () => {
  test("an extended highlight supersedes its prefix", () => {
    const short = clip({ lo: 272, hi: 274, text: "A comprehensive account of tidal drift" });
    const long = clip({
      lo: 272,
      hi: 277,
      at: "2026-01-02T19:20:00",
      text: "A comprehensive account of tidal drift should address the coast",
    });
    const { kept, discarded } = consolidate([short, long]);
    expect(ids(kept)).toEqual([long.id]);
    expect(ids(discarded)).toEqual([short.id]);
    expect(kept[0]?.supersedes).toEqual([short.id]);
  });

  test("an inner substring is absorbed by the wider highlight", () => {
    const inner = clip({ lo: 300, hi: 301, text: "should address the coast" });
    const outer = clip({
      lo: 299,
      hi: 303,
      at: "2026-01-03T09:00:00",
      text: "An account that should address the coast in full",
    });
    const { kept } = consolidate([inner, outer]);
    expect(ids(kept)).toEqual([outer.id]);
  });

  test("a containment that falls mid-word still collapses", () => {
    const partial = clip({ lo: 10, hi: 11, text: "the tide came in slow" });
    const full = clip({
      lo: 10,
      hi: 12,
      at: "2026-01-04T08:00:00",
      text: "the tide came in slowly",
    });
    const { kept } = consolidate([partial, full]);
    expect(ids(kept)).toEqual([full.id]);
  });

  test("overlapping ranges with unrelated text keep both", () => {
    const first = clip({
      lo: 1992,
      hi: 2011,
      text: "swojego sąsiada, do wyegzekwowania prawa „ząb za ząb”",
    });
    const second = clip({
      lo: 2003,
      hi: 2011,
      at: "2026-01-05T10:00:00",
      text: "Jeszcze bardziej zawiła kwestia dotyczy podziału",
    });
    const { kept, discarded } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
    expect(discarded).toEqual([]);
  });

  test("identical text keeps the earlier timestamp", () => {
    const earlier = clip({ lo: 40, hi: 44, at: "2026-01-02T08:00:00", text: "the same passage" });
    const later = clip({ lo: 40, hi: 44, at: "2026-01-02T09:00:00", text: "the same passage" });
    const { kept } = consolidate([later, earlier]);
    expect(ids(kept)).toEqual([earlier.id]);
    expect(kept[0]?.supersedes).toEqual([later.id]);
  });

  test("disjoint ranges are never compared", () => {
    const first = clip({ lo: 10, hi: 12, text: "a passage about tides" });
    const second = clip({
      lo: 90,
      hi: 92,
      at: "2026-02-01T08:00:00",
      text: "a passage about tides and more",
    });
    const { kept } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
  });

  test("collapse never crosses a book boundary", () => {
    const first = clip({
      book: "the-silent-ledger",
      lo: 10,
      hi: 12,
      text: "a passage about tides",
    });
    const second = clip({
      book: "the-quiet-test",
      lo: 10,
      hi: 12,
      text: "a passage about tides and more",
    });
    const { kept } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
  });

  test("a three-link chain leaves one survivor listing both", () => {
    const a = clip({ lo: 10, hi: 11, at: "2026-01-01T08:00:00", text: "one" });
    const b = clip({ lo: 10, hi: 12, at: "2026-01-01T08:01:00", text: "one two" });
    const c = clip({ lo: 10, hi: 13, at: "2026-01-01T08:02:00", text: "one two three" });
    const { kept, discarded } = consolidate([a, b, c]);
    expect(ids(kept)).toEqual([c.id]);
    expect(kept[0]?.supersedes).toEqual([a.id, b.id].sort());
    expect(ids(discarded)).toEqual(ids([a, b]));
  });

  test("supersedes is sorted, deduplicated and free of the survivor's own id", () => {
    const a = clip({ lo: 10, hi: 11, at: "2026-01-01T08:00:00", text: "one" });
    const b = clip({
      lo: 10,
      hi: 12,
      at: "2026-01-01T08:01:00",
      text: "one two",
      supersedes: [a.id, "ffffffffffff"],
    });
    const { kept } = consolidate([a, b]);
    const supersedes = kept[0]?.supersedes ?? [];
    expect(supersedes).toEqual([...new Set(supersedes)].sort());
    expect(supersedes).toEqual([a.id, "ffffffffffff"].sort());
  });

  test("consolidation is idempotent over its own output", () => {
    const records = [
      clip({ lo: 10, hi: 11, at: "2026-01-01T08:00:00", text: "one" }),
      clip({ lo: 10, hi: 12, at: "2026-01-01T08:01:00", text: "one two" }),
      clip({ lo: 50, kind: "note", at: "2026-01-01T09:00:00", text: "a note" }),
      clip({ lo: 45, hi: 55, at: "2026-01-01T08:30:00", text: "a wide passage covering the note" }),
      clip({ lo: 70, kind: "bookmark", at: "2026-01-01T10:00:00" }),
    ];
    const first = consolidate(records);
    const second = consolidate(first.kept);
    expect(second.kept).toEqual(first.kept);
    expect(second.discarded).toEqual([]);
  });

  test("the result does not depend on input order", () => {
    const records = [
      clip({ lo: 10, hi: 11, at: "2026-01-01T08:00:00", text: "one" }),
      clip({ lo: 10, hi: 12, at: "2026-01-01T08:01:00", text: "one two" }),
      clip({ lo: 10, hi: 13, at: "2026-01-01T08:02:00", text: "one two three" }),
    ];
    const forwards = consolidate(records);
    const backwards = consolidate([...records].reverse());
    expect(backwards.kept).toEqual(forwards.kept);
  });
});

describe("empty and DRM-limited highlights", () => {
  test("two overlapping sentinels are both kept", () => {
    const first = clip({ lo: 100, hi: 104, text: ` ${DRM_SENTINEL}`, drmLimited: true });
    const second = clip({
      lo: 102,
      hi: 106,
      at: "2026-01-06T11:00:00",
      text: ` ${DRM_SENTINEL}`,
      drmLimited: true,
    });
    const { kept } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
  });

  test("an empty highlight overlapping a real one is kept", () => {
    const blank = clip({ lo: 200, hi: 204, text: "" });
    const real = clip({ lo: 202, hi: 206, at: "2026-01-07T11:00:00", text: "a passage with text" });
    const { kept } = consolidate([blank, real]);
    expect(ids(kept)).toEqual(ids([blank, real]));
  });
});

describe("note attachment", () => {
  const note = (lo: number, at: string, text = "a note") => clip({ kind: "note", lo, at, text });

  test("a single containing highlight wins", () => {
    const highlight = clip({ lo: 100, hi: 110, text: "a passage" });
    const { kept } = consolidate([highlight, note(105, "2026-01-02T20:00:00")]);
    const attached = kept.find((c) => c.kind === "note");
    expect(attached?.attachedTo).toBe(highlight.id);
  });

  test("the narrowest containing range wins", () => {
    const wide = clip({ lo: 100, hi: 200, text: "a wide passage about the sea and the shore" });
    const narrow = clip({ lo: 104, hi: 108, at: "2026-01-02T18:00:00", text: "narrow" });
    const { kept } = consolidate([wide, narrow, note(105, "2026-01-02T20:00:00")]);
    expect(kept.find((c) => c.kind === "note")?.attachedTo).toBe(narrow.id);
  });

  test("equal widths break on the nearest timestamp", () => {
    const early = clip({ lo: 100, hi: 110, at: "2026-01-02T08:00:00", text: "early passage" });
    const close = clip({ lo: 101, hi: 111, at: "2026-01-02T19:55:00", text: "close passage" });
    const { kept } = consolidate([early, close, note(105, "2026-01-02T20:00:00")]);
    expect(kept.find((c) => c.kind === "note")?.attachedTo).toBe(close.id);
  });

  test("a complete tie breaks on the smaller identifier, every run", () => {
    const left = clip({ lo: 100, hi: 110, at: "2026-01-02T19:00:00", text: "left passage" });
    const right = clip({ lo: 101, hi: 111, at: "2026-01-02T21:00:00", text: "right passage" });
    const expected = [left.id, right.id].sort()[0];
    for (const order of [
      [left, right],
      [right, left],
    ]) {
      const { kept } = consolidate([...order, note(105, "2026-01-02T20:00:00")]);
      expect(kept.find((c) => c.kind === "note")?.attachedTo).toBe(expected);
    }
  });

  test("no containing highlight leaves the note attached to nothing but kept", () => {
    const far = clip({ lo: 900, hi: 910, text: "elsewhere" });
    const orphan = note(105, "2026-01-02T20:00:00");
    const { kept } = consolidate([far, orphan]);
    expect(kept.find((c) => c.id === orphan.id)?.attachedTo).toBeNull();
  });

  test("a DRM-limited highlight is a valid target", () => {
    const sentinel = clip({ lo: 100, hi: 110, text: ` ${DRM_SENTINEL}`, drmLimited: true });
    const { kept } = consolidate([sentinel, note(105, "2026-01-02T20:00:00")]);
    expect(kept.find((c) => c.kind === "note")?.attachedTo).toBe(sentinel.id);
  });

  test("a note re-attaches when a better candidate appears", () => {
    const wide = clip({ lo: 100, hi: 200, text: "a wide passage about the sea" });
    const subject = note(105, "2026-01-02T20:00:00");
    const before = consolidate([wide, subject]);
    expect(before.kept.find((c) => c.kind === "note")?.attachedTo).toBe(wide.id);
    const narrow = clip({ lo: 104, hi: 108, at: "2026-02-01T18:00:00", text: "narrow" });
    const after = consolidate([wide, narrow, subject]);
    expect(after.kept.find((c) => c.kind === "note")?.attachedTo).toBe(narrow.id);
  });

  test("a note never attaches to a highlight in another book", () => {
    const elsewhere = clip({ book: "the-quiet-test", lo: 100, hi: 110, text: "a passage" });
    const subject = note(105, "2026-01-02T20:00:00");
    const { kept } = consolidate([elsewhere, subject]);
    expect(kept.find((c) => c.id === subject.id)?.attachedTo).toBeNull();
  });

  test("a note never attaches to a discarded highlight", () => {
    const short = clip({ lo: 100, hi: 110, at: "2026-01-01T08:00:00", text: "a passage" });
    const long = clip({ lo: 100, hi: 112, at: "2026-01-01T08:05:00", text: "a passage extended" });
    const { kept } = consolidate([short, long, note(105, "2026-01-02T20:00:00")]);
    expect(kept.find((c) => c.kind === "note")?.attachedTo).toBe(long.id);
  });
});

describe("notes and bookmarks are never collapsed", () => {
  test("two notes at one location with identical text are both kept", () => {
    const first = clip({ kind: "note", lo: 8538, at: "2026-01-02T19:00:00", text: "same note" });
    const second = clip({ kind: "note", lo: 8538, at: "2026-01-02T20:00:00", text: "same note" });
    const { kept, discarded } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
    expect(discarded).toEqual([]);
  });

  test("bookmarks at coinciding locations are both kept", () => {
    const first = clip({ kind: "bookmark", lo: 522, at: "2026-01-02T19:00:00" });
    const second = clip({ kind: "bookmark", lo: 522, at: "2026-01-02T20:00:00" });
    const { kept } = consolidate([first, second]);
    expect(ids(kept)).toEqual(ids([first, second]));
  });
});

describe("union of store and source", () => {
  test("a stored highlight is superseded by a newly parsed one", () => {
    const stored = clip({ lo: 272, hi: 274, text: "A comprehensive account of tidal drift" });
    const parsed = clip({
      lo: 272,
      hi: 277,
      at: "2026-01-02T19:20:00",
      text: "A comprehensive account of tidal drift should address the coast",
    });
    const { kept, discarded } = consolidate(unionClippings([stored], [parsed]));
    expect(ids(kept)).toEqual([parsed.id]);
    expect(ids(discarded)).toEqual([stored.id]);
  });

  test("a stored record absent from the source survives unchanged", () => {
    const stored = clip({ lo: 500, hi: 502, text: "only in the store" });
    const { kept } = consolidate(unionClippings([stored], []));
    expect(kept).toEqual([stored]);
  });

  test("the parsed record wins on content and supersedes accumulate", () => {
    const stored = clip({ lo: 10, hi: 12, text: "one two", supersedes: ["aaaaaaaaaaaa"] });
    const parsed = clip({ lo: 10, hi: 12, text: "one two" });
    const [united] = unionClippings([stored], [parsed]);
    expect(united?.supersedes).toEqual(["aaaaaaaaaaaa"]);
  });

  test("chained collapse across sync runs", () => {
    const a = clip({ lo: 10, hi: 11, at: "2026-01-01T08:00:00", text: "one" });
    const b = clip({ lo: 10, hi: 12, at: "2026-01-01T08:01:00", text: "one two" });
    const firstRun = consolidate(unionClippings([], [a, b]));
    expect(ids(firstRun.kept)).toEqual([b.id]);

    // The second run sees the store (B, carrying A) and a source that has since
    // gained the longer C. A is gone from the store, so only B's inherited list
    // can carry A forward.
    const c = clip({ lo: 10, hi: 13, at: "2026-01-01T08:02:00", text: "one two three" });
    const secondRun = consolidate(unionClippings(firstRun.kept, [c]));
    expect(ids(secondRun.kept)).toEqual([c.id]);
    expect(secondRun.kept[0]?.supersedes).toEqual([a.id, b.id].sort());
  });
});

describe("the committed fixture", () => {
  const { records } = parseClippings(fixtureSource());
  const expected = fixtureExpectations();
  const all = deriveClippings(records);
  const { kept, discarded } = consolidate(all);
  const keptHighlights = kept.filter((c) => c.kind === "highlight");
  const text = new Map(all.map((c) => [c.id, normalise(c.text)]));
  const normalised = (c: Clipping): string => text.get(c.id) ?? "";
  const overlaps = (a: Clipping, b: Clipping): boolean =>
    a.location.lo <= b.location.hi && b.location.lo <= a.location.hi;
  const contains = (a: string, b: string): boolean => a !== b && (a.includes(b) || b.includes(a));
  const comparable = all.filter((c) => c.kind === "highlight" && !c.empty && !c.drmLimited);
  const width = (c: Clipping): number => c.location.hi - c.location.lo;
  const candidatesOf = (note: Clipping): Clipping[] =>
    keptHighlights.filter(
      (h) =>
        h.book === note.book &&
        h.location.lo <= note.location.lo &&
        h.location.hi >= note.location.hi,
    );

  // pairs() walks the comparable highlights once so each collapse-outcome test
  // can state its own predicate over the same set.
  function pairs(): [Clipping, Clipping][] {
    const out: [Clipping, Clipping][] = [];
    for (const a of comparable) for (const b of comparable) if (a.id < b.id) out.push([a, b]);
    return out;
  }

  test("kept and discarded counts match the recorded expectations", () => {
    expect(keptHighlights).toHaveLength(expected.highlights.kept);
    expect(discarded).toHaveLength(expected.highlights.discarded);
    expect(keptHighlights.length + discarded.length).toBe(expected.kinds.highlight);
  });

  test("every discarded highlight is named in some survivor's supersedes", () => {
    const superseded = new Set(kept.flatMap((c) => c.supersedes));
    for (const gone of discarded) expect(superseded.has(gone.id)).toBe(true);
  });

  test("each note resolves to the recorded target and none is dropped", () => {
    const notes = kept.filter((c) => c.kind === "note");
    expect(notes).toHaveLength(expected.kinds.note);
    expect(
      notes.map((n) => ({
        id: n.id,
        book: n.book,
        location: n.location.lo,
        attachedTo: n.attachedTo,
      })),
    ).toEqual(expected.notes);
  });

  test("a word-aligned prefix extension occurs and collapses", () => {
    const found = pairs().some(([a, b]) => {
      const [x, y] = [normalised(a), normalised(b)];
      const [long, short] = x.length >= y.length ? [x, y] : [y, x];
      return overlaps(a, b) && a.book === b.book && long !== short && long.startsWith(`${short} `);
    });
    expect(found).toBe(true);
  });

  test("a containment that falls mid-word occurs", () => {
    const found = pairs().some(([a, b]) => {
      const [x, y] = [normalised(a), normalised(b)];
      const [long, short] = x.length >= y.length ? [x, y] : [y, x];
      if (!overlaps(a, b) || a.book !== b.book || short === "" || !long.includes(short))
        return false;
      const at = long.indexOf(short) + short.length;
      return /\S/.test(long.slice(at, at + 1)) && /\S/.test(short.slice(-1));
    });
    expect(found).toBe(true);
  });

  test("an inner substring, an identical pair and a three-link chain occur", () => {
    const inner = pairs().some(([a, b]) => {
      const [x, y] = [normalised(a), normalised(b)];
      const [long, short] = x.length >= y.length ? [x, y] : [y, x];
      return overlaps(a, b) && a.book === b.book && contains(x, y) && long.indexOf(short) > 0;
    });
    const identical = pairs().some(
      ([a, b]) => overlaps(a, b) && a.book === b.book && normalised(a) === normalised(b),
    );
    expect(inner).toBe(true);
    expect(identical).toBe(true);
    expect(kept.some((c) => c.supersedes.length >= 2)).toBe(true);
  });

  test("an overlapping pair with unrelated text is kept whole", () => {
    const found = pairs().some(
      ([a, b]) =>
        a.book === b.book &&
        overlaps(a, b) &&
        !contains(normalised(a), normalised(b)) &&
        normalised(a) !== normalised(b) &&
        keptHighlights.some((k) => k.id === a.id) &&
        keptHighlights.some((k) => k.id === b.id),
    );
    expect(found).toBe(true);
  });

  test("a containment across disjoint ranges and one across two books are both kept", () => {
    const survives = (c: Clipping): boolean => keptHighlights.some((k) => k.id === c.id);
    const disjoint = pairs().some(
      ([a, b]) =>
        a.book === b.book &&
        !overlaps(a, b) &&
        contains(normalised(a), normalised(b)) &&
        survives(a) &&
        survives(b),
    );
    const crossBook = pairs().some(
      ([a, b]) =>
        a.book !== b.book && contains(normalised(a), normalised(b)) && survives(a) && survives(b),
    );
    expect(disjoint).toBe(true);
    expect(crossBook).toBe(true);
  });

  test("two overlapping sentinels and an empty highlight overlapping a real one survive", () => {
    const sentinels = keptHighlights.filter((c) => c.drmLimited);
    expect(
      sentinels.some((a) =>
        sentinels.some((b) => b.id !== a.id && b.book === a.book && overlaps(a, b)),
      ),
    ).toBe(true);
    const blanks = keptHighlights.filter((c) => c.empty);
    expect(blanks.some((a) => comparable.some((b) => b.book === a.book && overlaps(a, b)))).toBe(
      true,
    );
  });

  test("every attachment outcome occurs", () => {
    const notes = kept.filter((c) => c.kind === "note");
    const shapes = { single: 0, widths: 0, equalWidth: 0, tie: 0, none: 0, sentinel: 0 };
    for (const note of notes) {
      const candidates = candidatesOf(note);
      if (candidates.length === 0) shapes.none++;
      if (candidates.length === 1) shapes.single++;
      if (candidates.length >= 2) {
        const narrowest = Math.min(...candidates.map(width));
        const tied = candidates.filter((c) => width(c) === narrowest);
        if (tied.length === 1) shapes.widths++;
        else shapes.equalWidth++;
      }
      const target = candidates.find((c) => c.id === note.attachedTo);
      if (target?.drmLimited === true) shapes.sentinel++;
    }
    // The complete tie is the constructed `half-a-bridge` note: equal widths,
    // one hour either side, resolved by the smaller identifier.
    const tie = notes.find((n) => n.book === "half-a-bridge");
    const tieCandidates = tie === undefined ? [] : candidatesOf(tie);
    if (tie !== undefined && tieCandidates.length === 2) shapes.tie++;
    expect(shapes.single).toBeGreaterThan(0);
    expect(shapes.widths).toBeGreaterThan(0);
    expect(shapes.equalWidth).toBeGreaterThan(0);
    expect(shapes.tie).toBe(1);
    expect(shapes.none).toBeGreaterThan(0);
    expect(shapes.sentinel).toBeGreaterThan(0);
    expect(tie?.attachedTo).toBe([...tieCandidates].map((c) => c.id).sort()[0] ?? null);
  });

  test("two notes at one location with identical text are both kept", () => {
    const notes = kept.filter((c) => c.kind === "note");
    const twins = notes.filter((a) =>
      notes.some(
        (b) =>
          b.id !== a.id &&
          b.book === a.book &&
          b.location.lo === a.location.lo &&
          normalise(b.text) === normalise(a.text),
      ),
    );
    expect(twins.length).toBeGreaterThanOrEqual(2);
  });

  test("consolidating the fixture twice changes nothing", () => {
    const second = consolidate(kept);
    expect(second.kept).toEqual(kept);
    expect(second.discarded).toEqual([]);
  });
});
