import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClippings } from "./clippings";
import { makeStore } from "./fixtures/tempstore";
import { deriveClippings } from "./identity";
import { clippingPath, git } from "./store";
import { sync } from "./sync";

const LEDGER = "The Silent Ledger (Quinn, Marta)";
const SHORT_META =
  "- Your Highlight on page 42 | Location 272-274 | Added on Friday, January 2, 2026 7:13:49 PM";
const LONG_META =
  "- Your Highlight on page 42 | Location 272-277 | Added on Friday, January 2, 2026 7:14:20 PM";
const OTHER_META =
  "- Your Highlight on page 90 | Location 980-984 | Added on Saturday, January 3, 2026 9:00:00 AM";
const SHORT_TEXT = "A comprehensive account of tidal drift";
const LONG_TEXT = "A comprehensive account of tidal drift should address the coast";

function record(title: string, metadata: string, text: string): string {
  return `${title}\r\n${metadata}\r\n\r\n${text}\r\n==========\r\n`;
}

async function sourceFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kindle-sync-source-"));
  const path = join(directory, "My Clippings.txt");
  await writeFile(path, contents);
  return path;
}

async function clippingFiles(store: string, book: string): Promise<string[]> {
  try {
    return (await readdir(join(store, "books", book, "clippings"))).sort();
  } catch {
    return [];
  }
}

describe("sync", () => {
  test("a second run against an unchanged source creates no commit", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    expect(await sync(["--source", source, "--store", store.path])).toBe(0);
    const afterFirst = await store.log();
    expect(afterFirst).toHaveLength(2);

    expect(await sync(["--source", source, "--store", store.path])).toBe(0);
    expect(await store.log()).toEqual(afterFirst);
    expect(await store.status()).toBe("");
    expect(await clippingFiles(store.path, "the-silent-ledger")).toHaveLength(1);
  });

  test("records appended to the source add files in one commit", async () => {
    const store = await makeStore();
    const first = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await sync(["--source", first, "--store", store.path]);
    const before = await store.log();

    const second = await sourceFile(
      record(LEDGER, SHORT_META, SHORT_TEXT) + record(LEDGER, OTHER_META, "A separate passage"),
    );
    expect(await sync(["--source", second, "--store", store.path])).toBe(0);
    expect(await store.log()).toHaveLength(before.length + 1);
    expect(await clippingFiles(store.path, "the-silent-ledger")).toHaveLength(2);
  });

  test("a highlight extended after an earlier sync is deleted, re-added and named in supersedes", async () => {
    const store = await makeStore();
    const first = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await sync(["--source", first, "--store", store.path]);
    const firstCommit = await store.head();
    const [oldFile] = await clippingFiles(store.path, "the-silent-ledger");
    expect(oldFile).toBeDefined();
    const oldId = oldFile?.replace(/^.*--/, "").replace(/\.yaml$/, "");

    const second = await sourceFile(
      record(LEDGER, SHORT_META, SHORT_TEXT) + record(LEDGER, LONG_META, LONG_TEXT),
    );
    expect(await sync(["--source", second, "--store", store.path])).toBe(0);

    const files = await clippingFiles(store.path, "the-silent-ledger");
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(oldFile);
    const survivor = await Bun.file(
      join(store.path, "books/the-silent-ledger/clippings", files[0] ?? ""),
    ).text();
    expect(survivor).toContain(LONG_TEXT);
    expect(oldId).toBeDefined();
    expect(survivor).toContain(`- "${oldId}"`);

    const changed = (
      await git(store.path, ["diff", "--name-status", `${firstCommit}..HEAD`])
    ).trim();
    expect(changed).toContain(`D\tbooks/the-silent-ledger/clippings/${oldFile}`);
    expect(changed).toContain(`A\tbooks/the-silent-ledger/clippings/${files[0]}`);
  });

  test("the superseded record is still recoverable from the committed source", async () => {
    const store = await makeStore();
    const first = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await sync(["--source", first, "--store", store.path]);
    const firstCommit = await store.head();
    const second = await sourceFile(
      record(LEDGER, SHORT_META, SHORT_TEXT) + record(LEDGER, LONG_META, LONG_TEXT),
    );
    await sync(["--source", second, "--store", store.path]);

    const committed = await Bun.file(join(store.path, "source/My Clippings.txt")).text();
    expect(committed).toBe(
      record(LEDGER, SHORT_META, SHORT_TEXT) + record(LEDGER, LONG_META, LONG_TEXT),
    );
    const earlier = await git(store.path, ["show", `${firstCommit}:source/My Clippings.txt`]);
    expect(earlier).toBe(record(LEDGER, SHORT_META, SHORT_TEXT));
  });

  test("an emptied source deletes nothing and creates no commit", async () => {
    const store = await makeStore();
    const first = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await sync(["--source", first, "--store", store.path]);
    const before = await store.log();

    const wiped = await sourceFile("");
    expect(await sync(["--source", wiped, "--store", store.path])).toBe(0);
    expect(await store.log()).toEqual(before);
    expect(await clippingFiles(store.path, "the-silent-ledger")).toHaveLength(1);
  });

  test("a book missing from the source keeps its directory", async () => {
    const store = await makeStore();
    const both = await sourceFile(
      record(LEDGER, SHORT_META, SHORT_TEXT) +
        record("The Quiet Test (Nora Bell)", OTHER_META, "Another book entirely"),
    );
    await sync(["--source", both, "--store", store.path]);

    const one = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    expect(await sync(["--source", one, "--store", store.path])).toBe(0);
    expect(await clippingFiles(store.path, "the-quiet-test")).toHaveLength(1);
  });

  test("a dry run prints the changeset and writes nothing", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    const head = await store.head();
    expect(await sync(["--source", source, "--store", store.path, "--dry-run"])).toBe(0);
    expect(await store.head()).toBe(head);
    expect(await store.status()).toBe("");
    expect(await store.staged()).toBe("");
    expect(await clippingFiles(store.path, "the-silent-ledger")).toEqual([]);
    expect(await Bun.file(join(store.path, "meta.yaml")).exists()).toBe(false);
  });

  test("an edited sourceTimezone renames nothing and is left as written", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await sync(["--source", source, "--store", store.path, "--timezone", "Europe/Warsaw"]);
    const before = await clippingFiles(store.path, "the-silent-ledger");

    await writeFile(
      join(store.path, "meta.yaml"),
      'schemaVersion: 1\nsourceTimezone: "Pacific/Kiritimati"\n',
    );
    await git(store.path, ["add", "--", "meta.yaml"]);
    await git(store.path, ["commit", "--quiet", "-m", "declare a different zone"]);
    const head = await store.head();

    expect(await sync(["--source", source, "--store", store.path])).toBe(0);
    expect(await store.head()).toBe(head);
    expect(await clippingFiles(store.path, "the-silent-ledger")).toEqual(before);
    expect(await Bun.file(join(store.path, "meta.yaml")).text()).toContain("Pacific/Kiritimati");
  });

  test("two title lines that slug alike share a book, and sources accumulate", async () => {
    const store = await makeStore();
    const stone = "Harry Potter and the Philosopher's Stone (Rowling, J.K.)";
    const chamber = "Harry Potter and the Chamber of Secrets (Rowling, J.K.)";
    const first = await sourceFile(record(stone, SHORT_META, SHORT_TEXT));
    expect(await sync(["--source", first, "--store", store.path])).toBe(0);
    expect(await readdir(join(store.path, "books"))).toEqual(["harry-potter-and-the"]);

    const second = await sourceFile(
      record(stone, SHORT_META, SHORT_TEXT) + record(chamber, OTHER_META, "A separate passage"),
    );
    expect(await sync(["--source", second, "--store", store.path])).toBe(0);
    expect(await readdir(join(store.path, "books"))).toEqual(["harry-potter-and-the"]);
    const book = await Bun.file(join(store.path, "books/harry-potter-and-the/book.yaml")).text();
    expect(book).toContain(`- "${chamber}"`);
    expect(book).toContain(`- "${stone}"`);
    expect(await clippingFiles(store.path, "harry-potter-and-the")).toHaveLength(2);
  });

  test("a note is a record of its own, not a field of the highlight", async () => {
    const store = await makeStore();
    const noteMeta =
      "- Your Note on page 42 | Location 273 | Added on Friday, January 2, 2026 7:20:00 PM";
    const source = await sourceFile(
      record(LEDGER, SHORT_META, SHORT_TEXT) + record(LEDGER, noteMeta, "a note of my own"),
    );
    expect(await sync(["--source", source, "--store", store.path])).toBe(0);

    const directory = join(store.path, "books/the-silent-ledger/clippings");
    const files = await clippingFiles(store.path, "the-silent-ledger");
    expect(files).toHaveLength(2);
    const contents = await Promise.all(
      files.map(async (file) => await Bun.file(join(directory, file)).text()),
    );
    const note = contents.find((text) => text.includes('kind: "note"'));
    const highlight = contents.find((text) => text.includes('kind: "highlight"'));
    expect(note).toContain("a note of my own");
    expect(highlight).toBeDefined();
    expect(highlight).not.toContain("a note of my own");
    const noteId = note?.match(/id: "([0-9a-f]{12})"/)?.[1];
    expect(noteId).toMatch(/^[0-9a-f]{12}$/);
    expect(note).toContain(`attachedTo: "${highlight?.match(/id: "([0-9a-f]{12})"/)?.[1]}"`);
  });

  test("the whole fixture syncs, then re-syncs to nothing", async () => {
    const store = await makeStore();
    const fixture = new URL("./fixtures/clippings.txt", import.meta.url).pathname;
    expect(await sync(["--source", fixture, "--store", store.path])).toBe(0);
    const log = await store.log();
    expect(await sync(["--source", fixture, "--store", store.path])).toBe(0);
    expect(await store.log()).toEqual(log);
    const books = (await readdir(join(store.path, "books"))).sort();
    expect(books).toContain("harry-potter-and-the");
    expect(books).toContain("opowiesc-o-zazolconej-gesli");
  });
});

describe("sync arguments", () => {
  test("a missing store is a usage error", async () => {
    const previous = process.env.KINDLE_SYNC_STORE;
    delete process.env.KINDLE_SYNC_STORE;
    try {
      expect(await sync(["--source", "src/fixtures/clippings.txt"])).toBe(2);
    } finally {
      if (previous !== undefined) process.env.KINDLE_SYNC_STORE = previous;
    }
  });

  test("an unknown flag and a stray positional are usage errors", async () => {
    expect(await sync(["--store", "/tmp", "--after", "2026-01-01"])).toBe(2);
    expect(await sync(["--store", "/tmp", "stray"])).toBe(2);
  });

  test("the source and store fall back to the environment", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    const previous = {
      source: process.env.KINDLE_SYNC_SOURCE,
      store: process.env.KINDLE_SYNC_STORE,
    };
    try {
      process.env.KINDLE_SYNC_SOURCE = source;
      process.env.KINDLE_SYNC_STORE = store.path;
      expect(await sync([])).toBe(0);
      expect(await clippingFiles(store.path, "the-silent-ledger")).toHaveLength(1);
    } finally {
      if (previous.source === undefined) delete process.env.KINDLE_SYNC_SOURCE;
      else process.env.KINDLE_SYNC_SOURCE = previous.source;
      if (previous.store === undefined) delete process.env.KINDLE_SYNC_STORE;
      else process.env.KINDLE_SYNC_STORE = previous.store;
    }
  });
});

describe("sync failures", () => {
  test("a missing source file exits 1 naming the path", async () => {
    const store = await makeStore();
    expect(await sync(["--source", "/nowhere/My Clippings.txt", "--store", store.path])).toBe(1);
  });

  test("a store that is not a git repository exits 1", async () => {
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    const directory = await mkdtemp(join(tmpdir(), "kindle-sync-plain-"));
    expect(await sync(["--source", source, "--store", directory])).toBe(1);
    expect(await Bun.file(join(directory, "meta.yaml")).exists()).toBe(false);
  });

  test("a dirty store exits 1 without writing", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await writeFile(join(store.path, "stray.txt"), "uncommitted");
    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await Bun.file(join(store.path, "meta.yaml")).exists()).toBe(false);
  });

  test("a store declaring a newer schema version exits 1 without writing", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    await writeFile(join(store.path, "meta.yaml"), 'schemaVersion: 99\nsourceTimezone: "UTC"\n');
    await git(store.path, ["add", "--", "meta.yaml"]);
    await git(store.path, ["commit", "--quiet", "-m", "newer store"]);
    const head = await store.head();
    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await store.head()).toBe(head);
    expect(await clippingFiles(store.path, "the-silent-ledger")).toEqual([]);
  });

  test("an unparseable record exits 1 and writes nothing", async () => {
    const store = await makeStore();
    const source = await sourceFile(
      `${LEDGER}\r\n- Your Doodle on Location 1 | Added on Friday, January 2, 2026 7:13:49 PM\r\n\r\ntext\r\n==========\r\n`,
    );
    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await store.log()).toHaveLength(1);
    expect(await Bun.file(join(store.path, "meta.yaml")).exists()).toBe(false);
  });

  test("a title that slugs to nothing exits 1 naming the line", async () => {
    const store = await makeStore();
    const source = await sourceFile(record("…… (Anon)", SHORT_META, SHORT_TEXT));
    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await store.log()).toHaveLength(1);
    expect(await Bun.file(join(store.path, "meta.yaml")).exists()).toBe(false);
  });

  test("two records sharing an identifier exit 1 naming both", async () => {
    const store = await makeStore();
    const source = await sourceFile(
      record(LEDGER, SHORT_META, "one passage") + record(LEDGER, SHORT_META, "another passage"),
    );
    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await store.log()).toHaveLength(1);
  });

  test("a failed write leaves no commit", async () => {
    const store = await makeStore();
    const source = await sourceFile(record(LEDGER, SHORT_META, SHORT_TEXT));
    // A directory where a clipping file belongs makes the write fail partway.
    // Empty directories are invisible to git, so the working tree stays clean
    // and the precondition check still passes.
    const [clipping] = deriveClippings(parseClippings(await Bun.file(source).text()).records);
    expect(clipping).toBeDefined();
    if (clipping === undefined) throw new Error("the source should hold one record");
    await mkdir(join(store.path, clippingPath(clipping)), { recursive: true });
    const head = await store.head();

    expect(await sync(["--source", source, "--store", store.path])).toBe(1);
    expect(await store.head()).toBe(head);
    expect(await store.log()).toHaveLength(1);
  });
});
