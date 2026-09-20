import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SyncError } from "./args";
import type { ClippingRecord } from "./clippings";
import {
  deriveBook,
  deriveBookId,
  deriveClippingId,
  deriveClippings,
  splitTitleLine,
} from "./identity";

function record(overrides: Partial<ClippingRecord> = {}): ClippingRecord {
  return {
    titleLine: "The Silent Ledger (Quinn, Marta)",
    kind: "highlight",
    page: "42",
    location: { lo: 272, hi: 277 },
    timestamp: "2026-01-02T19:13:49",
    text: "some text",
    empty: false,
    drmLimited: false,
    ...overrides,
  };
}

describe("deriveBookId", () => {
  test("ordinary title", () => {
    expect(deriveBookId("The Silent Ledger (Quinn, Marta)")).toBe("the-silent-ledger");
  });

  test("title longer than four words keeps the first four", () => {
    expect(
      deriveBookId("Distant Shores: A Study of Tidal Drift and Coastal Memory (Hale, Robert)"),
    ).toBe("distant-shores-a-study");
  });

  test("hyphens in a sideloaded filename are word separators", () => {
    expect(
      deriveBookId(
        "patterns-of-distributed-systems-an-engineering-primer-ada-lovelace-grace-hopper-press (Ada Lovelace and Grace Hopper)",
      ),
    ).toBe("patterns-of-distributed-systems");
  });

  test("underscores are word separators", () => {
    expect(deriveBookId("Wieczorny_Pociag_Nocny (Jan Kowalski)")).toBe("wieczorny-pociag-nocny");
  });

  test("non-ASCII letters are folded", () => {
    const id = deriveBookId("Opowieść. O zażółconej gęśli jaźni (Zofia Nałkowska)");
    expect(id).toBe("opowiesc-o-zazolconej-gesli");
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("numeric title", () => {
    expect(deriveBookId("9781234567890 (Alan Turing)")).toBe("9781234567890");
  });

  test("fewer than four words", () => {
    expect(deriveBookId("noms (Iris Chen)")).toBe("noms");
  });

  test("a title that slugs to nothing is a failure naming the line", () => {
    expect(() => deriveBookId("…… (Anon)")).toThrow(SyncError);
    expect(() => deriveBookId("…… (Anon)")).toThrow("…… (Anon)");
  });

  test("two title lines sharing a four-word prefix share an identifier", () => {
    expect(deriveBookId("Harry Potter and the Philosopher's Stone (Rowling, J.K.)")).toBe(
      "harry-potter-and-the",
    );
    expect(deriveBookId("Harry Potter and the Chamber of Secrets (Rowling, J.K.)")).toBe(
      "harry-potter-and-the",
    );
  });
});

describe("splitTitleLine", () => {
  test("the author parenthetical is separated and kept verbatim", () => {
    expect(splitTitleLine("The Quiet Test (Nora Bell)")).toEqual({
      title: "The Quiet Test",
      author: "Nora Bell",
    });
    expect(deriveBook("The Quiet Test (Nora Bell)")).toEqual({
      id: "the-quiet-test",
      title: "The Quiet Test",
      author: "Nora Bell",
    });
  });

  test("a multi-author string is not split", () => {
    expect(splitTitleLine("A Primer (Ada Lovelace and Grace Hopper)").author).toBe(
      "Ada Lovelace and Grace Hopper",
    );
    expect(splitTitleLine("A Primer (Ries, Eric)").author).toBe("Ries, Eric");
  });

  test("a title with no parenthetical has no author", () => {
    expect(splitTitleLine("The Silent Ledger")).toEqual({
      title: "The Silent Ledger",
      author: null,
    });
    expect(deriveBookId("The Silent Ledger")).toBe("the-silent-ledger");
  });
});

describe("deriveClippingId", () => {
  const location = { lo: 272, hi: 277 };

  test("is twelve lowercase hexadecimal characters", () => {
    expect(
      deriveClippingId("the-silent-ledger", "highlight", location, "2026-01-02T19:13:49"),
    ).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is stable across calls", () => {
    const first = deriveClippingId(
      "the-silent-ledger",
      "highlight",
      location,
      "2026-01-02T19:13:49",
    );
    const second = deriveClippingId(
      "the-silent-ledger",
      "highlight",
      { ...location },
      "2026-01-02T19:13:49",
    );
    expect(second).toBe(first);
  });

  test("records differing only by timestamp get different identifiers", () => {
    const first = deriveClippingId("b", "highlight", location, "2026-01-02T19:13:49");
    const second = deriveClippingId("b", "highlight", location, "2026-01-02T19:13:50");
    expect(second).not.toBe(first);
  });

  test("kind, book and both range ends all contribute", () => {
    const base = deriveClippingId("b", "highlight", location, "2026-01-02T19:13:49");
    expect(deriveClippingId("b", "note", location, "2026-01-02T19:13:49")).not.toBe(base);
    expect(deriveClippingId("c", "highlight", location, "2026-01-02T19:13:49")).not.toBe(base);
    expect(
      deriveClippingId("b", "highlight", { lo: 272, hi: 278 }, "2026-01-02T19:13:49"),
    ).not.toBe(base);
    expect(
      deriveClippingId("b", "highlight", { lo: 273, hi: 277 }, "2026-01-02T19:13:49"),
    ).not.toBe(base);
  });

  test("text does not contribute", () => {
    const [before] = deriveClippings([record({ text: "original" })]);
    const [after] = deriveClippings([record({ text: "corrected and enriched" })]);
    expect(after?.id).toBe(before?.id);
  });
});

describe("deriveClippings", () => {
  test("a repeated identical record is kept once", () => {
    expect(deriveClippings([record(), record()])).toHaveLength(1);
  });

  test("two different records sharing an identifier fail naming both", () => {
    expect(() => deriveClippings([record({ text: "one" }), record({ text: "two" })])).toThrow(
      SyncError,
    );
    expect(() => deriveClippings([record({ text: "one" }), record({ text: "two" })])).toThrow(
      /"one"[\s\S]*"two"/,
    );
  });
});

describe("identity takes no configuration input", () => {
  test("environment, timezone and locale do not change an identifier", () => {
    const line = "Opowieść. O zażółconej gęśli jaźni (Zofia Nałkowska)";
    const previous = { tz: process.env.TZ, lang: process.env.LANG };
    try {
      process.env.TZ = "Pacific/Kiritimati";
      process.env.LANG = "tr_TR.UTF-8";
      const first = deriveClippings([record({ titleLine: line })]);
      process.env.TZ = "America/Adak";
      process.env.LANG = "C";
      expect(deriveClippings([record({ titleLine: line })])).toEqual(first);
    } finally {
      if (previous.tz === undefined) delete process.env.TZ;
      else process.env.TZ = previous.tz;
      if (previous.lang === undefined) delete process.env.LANG;
      else process.env.LANG = previous.lang;
    }
  });

  test("the module reads no clock, environment or locale API", () => {
    const source = readFileSync(new URL("./identity.ts", import.meta.url), "utf8");
    for (const forbidden of ["process.env", "Date", "Intl", "toLocale", "Math.random"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
