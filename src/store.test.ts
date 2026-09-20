import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SyncError } from "./args";
import { makeStore } from "./fixtures/tempstore";
import type { Clipping } from "./identity";
import {
  applyChangeset,
  bookPath,
  checkStore,
  clippingPath,
  commitMessage,
  computeChangeset,
  git,
  isClippingPath,
  isEmptyChangeset,
  parseBookFile,
  parseClippingFile,
  readStore,
  SCHEMA_VERSION,
  serialiseBook,
  serialiseClipping,
  serialiseMeta,
  tryGit,
} from "./store";

function clip(overrides: Partial<Clipping> = {}): Clipping {
  return {
    id: "7c4e2a91b3d0",
    kind: "highlight",
    book: "the-silent-ledger",
    timestamp: "2026-01-02T19:13:49",
    page: "42",
    location: { lo: 272, hi: 277 },
    text: "A comprehensive account of tidal drift",
    chapter: null,
    empty: false,
    drmLimited: false,
    supersedes: [],
    attachedTo: null,
    ...overrides,
  };
}

const plan = (kept: Clipping[], discarded: Clipping[] = []) => ({
  kept,
  discarded,
  books: [
    {
      id: "the-silent-ledger",
      title: "The Silent Ledger",
      author: "Quinn, Marta",
      sources: ["The Silent Ledger (Quinn, Marta)"],
    },
  ],
  source: "source bytes\r\n",
  sourceTimezone: "Europe/Warsaw",
});

describe("layout", () => {
  test("a clipping is written under its book, dated by its local timestamp", () => {
    expect(clippingPath(clip())).toBe(
      "books/the-silent-ledger/clippings/2026-01-02--7c4e2a91b3d0.yaml",
    );
    expect(isClippingPath(clippingPath(clip()))).toBe(true);
    expect(bookPath("the-silent-ledger")).toBe("books/the-silent-ledger/book.yaml");
  });

  test("the path derives only from the record, whatever the machine's timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      const first = clippingPath(clip());
      process.env.TZ = "America/Adak";
      expect(clippingPath(clip())).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("record schema", () => {
  test("a highlight carries every field and its supersedes list", () => {
    const yaml = serialiseClipping(clip({ supersedes: ["aaaaaaaaaaaa"] }));
    expect(yaml).toContain(`schemaVersion: ${SCHEMA_VERSION}`);
    expect(yaml).toContain('id: "7c4e2a91b3d0"');
    expect(yaml).toContain('kind: "highlight"');
    expect(yaml).toContain('book: "the-silent-ledger"');
    expect(yaml).toContain('timestamp: "2026-01-02T19:13:49"');
    expect(yaml).toContain('page: "42"');
    expect(yaml).toContain("location:\n  lo: 272\n  hi: 277");
    expect(yaml).toContain("chapter: null");
    expect(yaml).toContain("empty: false");
    expect(yaml).toContain("drmLimited: false");
    expect(yaml).toContain('supersedes:\n  - "aaaaaaaaaaaa"');
    expect(yaml).not.toContain("attachedTo");
  });

  test("a note carries attachedTo and no supersedes", () => {
    const attached = serialiseClipping(
      clip({ kind: "note", text: "a note", attachedTo: "aaaaaaaaaaaa" }),
    );
    expect(attached).toContain('kind: "note"');
    expect(attached).toContain('attachedTo: "aaaaaaaaaaaa"');
    expect(attached).not.toContain("supersedes");
    const loose = serialiseClipping(clip({ kind: "note", text: "a note" }));
    expect(loose).toContain("attachedTo: null");
  });

  test("a bookmark carries an empty text and the empty flag", () => {
    const yaml = serialiseClipping(clip({ kind: "bookmark", text: "", empty: true }));
    expect(yaml).toContain('kind: "bookmark"');
    expect(yaml).toContain('text: ""');
    expect(yaml).toContain("empty: true");
  });

  test("a missing page is null and a roman-numeral page stays a string", () => {
    expect(serialiseClipping(clip({ page: null }))).toContain("page: null");
    expect(serialiseClipping(clip({ page: "xxvii" }))).toContain('page: "xxvii"');
  });

  test("round-trips through the YAML reader, invisible characters included", () => {
    for (const text of [
      "plain text",
      "with a   and a ​ inside",
      " a leading space and a trailing one ",
      "",
      'quotes " and a colon: and a dash — and “typography”',
      "two\nlines",
    ]) {
      const original = clip({ text });
      const yaml = serialiseClipping(original);
      expect(parseClippingFile(yaml, "test.yaml")).toEqual(original);
    }
  });

  test("serialisation is byte-stable for an unchanged record", () => {
    expect(serialiseClipping(clip())).toBe(serialiseClipping(clip()));
    expect(serialiseClipping(clip({ supersedes: ["b", "a"] }))).toContain(
      'supersedes:\n  - "b"\n  - "a"',
    );
  });

  test("a record declaring an unknown schema version is refused", () => {
    const yaml = serialiseClipping(clip()).replace("schemaVersion: 1", "schemaVersion: 99");
    expect(() => parseClippingFile(yaml, "test.yaml")).toThrow(SyncError);
    expect(() => parseClippingFile(yaml, "test.yaml")).toThrow("schemaVersion 99");
  });
});

describe("book and store metadata", () => {
  test("book.yaml carries the verbatim title, author and sources", () => {
    const yaml = serialiseBook({
      id: "opowiesc-o-zazolconej-gesli",
      title: "Opowieść. O zażółconej gęśli jaźni",
      author: "Zofia Nałkowska",
      sources: ["Opowieść. O zażółconej gęśli jaźni (Zofia Nałkowska)"],
    });
    const parsed = parseBookFile(yaml, "book.yaml");
    expect(parsed.title).toBe("Opowieść. O zażółconej gęśli jaźni");
    expect(parsed.author).toBe("Zofia Nałkowska");
    expect(parsed.sources).toEqual(["Opowieść. O zażółconej gęśli jaźni (Zofia Nałkowska)"]);
  });

  test("a multi-author string is stored as one string, not a list", () => {
    const yaml = serialiseBook({
      id: "a-primer",
      title: "A Primer",
      author: "Ada Lovelace and Grace Hopper",
      sources: ["A Primer (Ada Lovelace and Grace Hopper)"],
    });
    expect(parseBookFile(yaml, "book.yaml").author).toBe("Ada Lovelace and Grace Hopper");
  });

  test("meta.yaml carries the version and the declared timezone and nothing else", () => {
    const yaml = serialiseMeta("Europe/Warsaw");
    expect(yaml).toBe('schemaVersion: 1\nsourceTimezone: "Europe/Warsaw"\n');
  });
});

describe("the git wrapper", () => {
  test("a non-zero exit is a failure carrying git's stderr", async () => {
    const store = await makeStore();
    await expect(git(store.path, ["rev-parse", "--verify", "nope"])).rejects.toThrow(SyncError);
    const result = await tryGit(store.path, ["rev-parse", "--verify", "nope"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });
});

describe("preconditions", () => {
  const source = "src/fixtures/clippings.txt";

  test("a store path that is not a git repository is refused", async () => {
    await expect(
      checkStore("/tmp", { source, requireCleanTree: true, requireIdentity: true }),
    ).rejects.toThrow(/not a git repository/);
  });

  test("a dirty working tree is refused", async () => {
    const store = await makeStore();
    await writeFile(join(store.path, "stray.txt"), "uncommitted");
    await expect(
      checkStore(store.path, { source, requireCleanTree: true, requireIdentity: true }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  test("a missing commit identity names the setting that does not resolve", async () => {
    const store = await makeStore();
    await git(store.path, ["config", "--unset", "user.email"]);
    // The repository is only half the answer: git also reads the global and
    // system files, so both are pointed at nothing for the length of the test.
    const previous = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    };
    try {
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";
      await expect(
        checkStore(store.path, { source, requireCleanTree: true, requireIdentity: true }),
      ).rejects.toThrow(/user\.email/);
    } finally {
      if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous.global;
      if (previous.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previous.system;
    }
  });

  test("a missing source file is refused, naming the path tried", async () => {
    const store = await makeStore();
    await expect(
      checkStore(store.path, {
        source: "/nowhere/My Clippings.txt",
        requireCleanTree: true,
        requireIdentity: true,
      }),
    ).rejects.toThrow("/nowhere/My Clippings.txt");
  });

  test("a store declaring an unknown schema version is refused", async () => {
    const store = await makeStore();
    await writeFile(join(store.path, "meta.yaml"), 'schemaVersion: 99\nsourceTimezone: "UTC"\n');
    await git(store.path, ["add", "--", "meta.yaml"]);
    await git(store.path, ["commit", "--quiet", "-m", "meta"]);
    await expect(
      checkStore(store.path, { source, requireCleanTree: true, requireIdentity: true }),
    ).rejects.toThrow(/schemaVersion 99/);
  });

  test("git missing from PATH is refused", async () => {
    const store = await makeStore();
    const previous = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      await expect(
        checkStore(store.path, { source, requireCleanTree: false, requireIdentity: false }),
      ).rejects.toThrow(/git is not executable/);
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("changesets", () => {
  test("a first write adds every file and counts clippings per book", async () => {
    const store = await makeStore();
    const changeset = await computeChangeset(store.path, plan([clip()]));
    expect(changeset.added).toContain(clippingPath(clip()));
    expect(changeset.added).toContain("meta.yaml");
    expect(changeset.added).toContain("source/My Clippings.txt");
    expect(changeset.clippings.added).toBe(1);
    expect(changeset.books.get("the-silent-ledger")).toEqual({ added: 1, deleted: 0 });
    expect(isEmptyChangeset(changeset)).toBe(false);
  });

  test("an unchanged store produces an empty changeset", async () => {
    const store = await makeStore();
    const first = await computeChangeset(store.path, plan([clip()]));
    await applyChangeset(store.path, first);
    const second = await computeChangeset(store.path, plan([clip()]));
    expect(isEmptyChangeset(second)).toBe(true);
    expect(second.added).toEqual([]);
    expect(second.modified).toEqual([]);
    expect(second.deleted).toEqual([]);
  });

  test("meta.yaml is not rewritten once it exists", async () => {
    const store = await makeStore();
    await applyChangeset(store.path, await computeChangeset(store.path, plan([clip()])));
    const edited = { ...plan([clip()]), sourceTimezone: "America/Adak" };
    const changeset = await computeChangeset(store.path, edited);
    expect(changeset.files.has("meta.yaml")).toBe(false);
  });

  test("a clipping absent from the plan is never deleted", async () => {
    const store = await makeStore();
    await applyChangeset(store.path, await computeChangeset(store.path, plan([clip()])));
    const other = clip({ id: "aaaaaaaaaaaa", text: "another passage" });
    const changeset = await computeChangeset(store.path, plan([other]));
    expect(changeset.deleted).toEqual([]);
    expect(changeset.added).toEqual([clippingPath(other)]);
  });

  test("only a superseded highlight is deleted", async () => {
    const store = await makeStore();
    const original = clip();
    await applyChangeset(store.path, await computeChangeset(store.path, plan([original])));
    const survivor = clip({
      id: "aaaaaaaaaaaa",
      text: "A comprehensive account of tidal drift, extended",
      supersedes: [original.id],
    });
    const changeset = await computeChangeset(store.path, plan([survivor], [original]));
    expect(changeset.deleted).toEqual([clippingPath(original)]);
    expect(changeset.clippings.deleted).toBe(1);
    expect(changeset.books.get("the-silent-ledger")?.deleted).toBe(1);
  });

  test("the commit message names totals in the subject and books in the body", async () => {
    const store = await makeStore();
    const original = clip();
    await applyChangeset(store.path, await computeChangeset(store.path, plan([original])));
    const survivor = clip({ id: "aaaaaaaaaaaa", text: "longer text", supersedes: [original.id] });
    const changeset = await computeChangeset(store.path, plan([survivor], [original]));
    const message = commitMessage(changeset);
    const [subject, blank, ...body] = message.split("\n");
    expect(subject).toContain("1 clipping(s) added");
    expect(subject).toContain("1 superseded");
    expect(blank).toBe("");
    expect(body).toContain("the-silent-ledger: 1 added, 1 deleted");
  });
});

describe("reading the store back", () => {
  test("every record and book returns as it was written", async () => {
    const store = await makeStore();
    const note = clip({
      kind: "note",
      id: "bbbbbbbbbbbb",
      text: "a note",
      attachedTo: "7c4e2a91b3d0",
    });
    await applyChangeset(store.path, await computeChangeset(store.path, plan([clip(), note])));
    const contents = await readStore(store.path);
    expect(contents.clippings).toHaveLength(2);
    expect(contents.clippings.find((c) => c.id === note.id)).toEqual(note);
    expect(contents.books.get("the-silent-ledger")?.sources).toEqual([
      "The Silent Ledger (Quinn, Marta)",
    ]);
  });

  test("an empty store reads as no records", async () => {
    const store = await makeStore();
    const contents = await readStore(store.path);
    expect(contents.clippings).toEqual([]);
    expect(contents.books.size).toBe(0);
  });

  test("a corrupt record names its file rather than being skipped", async () => {
    const store = await makeStore();
    await mkdir(join(store.path, "books/the-silent-ledger/clippings"), { recursive: true });
    await writeFile(
      join(store.path, "books/the-silent-ledger/clippings/2026-01-02--7c4e2a91b3d0.yaml"),
      "schemaVersion: 1\nid: 7c4e2a91b3d0\n",
    );
    await expect(readStore(store.path)).rejects.toThrow(/2026-01-02--7c4e2a91b3d0\.yaml/);
  });
});
