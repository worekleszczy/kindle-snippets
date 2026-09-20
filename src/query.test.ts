import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "./fixtures/tempstore";
import { query } from "./query";
import { git } from "./store";
import { sync } from "./sync";

const LEDGER = "The Silent Ledger (Quinn, Marta)";
const QUIET = "The Quiet Test (Nora Bell)";
const WIDE =
  "- Your Highlight on page 42 | Location 100-200 | Added on Friday, January 2, 2026 7:13:49 PM";
const NARROW =
  "- Your Highlight on page 42 | Location 104-108 | Added on Friday, January 2, 2026 8:00:00 PM";
const NOTE = "- Your Note on page 42 | Location 105 | Added on Friday, January 2, 2026 7:30:00 PM";
const ELSEWHERE =
  "- Your Highlight on page 9 | Location 900-904 | Added on Saturday, January 3, 2026 9:00:00 AM";

function record(title: string, metadata: string, text: string): string {
  return `${title}\r\n${metadata}\r\n\r\n${text}\r\n==========\r\n`;
}

async function sourceFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kindle-sync-source-"));
  const path = join(directory, "My Clippings.txt");
  await writeFile(path, contents);
  return path;
}

interface Captured {
  code: number;
  lines: string[];
  // Lazy: `--cursor` prints a commit identifier, which is not JSON.
  readonly objects: Record<string, unknown>[];
}

// query's contract is that stdout is machine-readable, so the tests read it the
// way a consumer would rather than asserting on internal calls.
async function capture(args: string[]): Promise<Captured> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => String(value)).join(" "));
  };
  try {
    const code = await query(args);
    return {
      code,
      lines,
      get objects() {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      },
    };
  } finally {
    console.log = original;
  }
}

async function populate(): Promise<{ store: Awaited<ReturnType<typeof makeStore>> }> {
  const store = await makeStore();
  const source = await sourceFile(
    record(LEDGER, WIDE, "a wide passage about the sea and the shore") +
      record(LEDGER, NOTE, "a note on the passage") +
      record(QUIET, ELSEWHERE, "another book entirely"),
  );
  const previous = console.log;
  console.log = () => {};
  try {
    expect(await sync(["--source", source, "--store", store.path])).toBe(0);
  } finally {
    console.log = previous;
  }
  return { store };
}

describe("filters", () => {
  test("with no filters every clipping is emitted, one object per line", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path]);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(3);
    for (const object of result.objects) {
      expect(object.schemaVersion).toBe(1);
      expect(object.op).toBeUndefined();
    }
  });

  test("a book filter emits only that book", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path, "--book", "the-quiet-test"]);
    expect(result.objects.map((o) => o.book)).toEqual(["the-quiet-test"]);
  });

  test("an unknown book is a failure, not an empty result", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path, "--book", "the-silent-ledgerr"]);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
  });

  test("an unsupported flag is a usage error", async () => {
    const { store } = await populate();
    expect(await query(["--store", store.path, "--after", "2026-01-01"])).toBe(2);
  });

  test("a missing store is a usage error", async () => {
    const previous = process.env.KINDLE_SYNC_STORE;
    delete process.env.KINDLE_SYNC_STORE;
    try {
      expect(await query([])).toBe(2);
    } finally {
      if (previous !== undefined) process.env.KINDLE_SYNC_STORE = previous;
    }
  });

  test("output is ordered by book, timestamp and identifier, and repeats byte for byte", async () => {
    const { store } = await populate();
    const first = await capture(["--store", store.path]);
    const second = await capture(["--store", store.path]);
    expect(second.lines.join("\n")).toBe(first.lines.join("\n"));
    const books = first.objects.map((o) => o.book);
    expect([...books].sort()).toEqual(books);
  });

  test("a query that matches nothing writes nothing and exits 0", async () => {
    const store = await makeStore();
    const result = await capture(["--store", store.path]);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([]);
  });
});

describe("book records", () => {
  test("--books emits one object per book", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path, "--books"]);
    expect(result.objects.map((o) => o.id)).toEqual(["the-quiet-test", "the-silent-ledger"]);
    for (const object of result.objects) {
      expect(object.schemaVersion).toBe(1);
      expect(object.title).toBeDefined();
      expect(object.sources).toBeDefined();
      expect("author" in object).toBe(true);
    }
  });

  test("--books --since reports a book whose sources changed as a modify", async () => {
    const { store } = await populate();
    const cursor = await store.head();
    const second = await sourceFile(
      record(LEDGER, WIDE, "a wide passage about the sea and the shore") +
        record(LEDGER, NOTE, "a note on the passage") +
        record(QUIET, ELSEWHERE, "another book entirely") +
        record(
          "The Silent Ledger (Quinn, M.)",
          ELSEWHERE,
          "the same book under a second title line",
        ),
    );
    const previous = console.log;
    console.log = () => {};
    try {
      expect(await sync(["--source", second, "--store", store.path])).toBe(0);
    } finally {
      console.log = previous;
    }
    const result = await capture(["--store", store.path, "--books", "--since", cursor]);
    const ledger = result.objects.find((o) => o.id === "the-silent-ledger");
    expect(ledger?.op).toBe("modify");
    expect(ledger?.sources).toHaveLength(2);
  });
});

describe("cursors", () => {
  test("--cursor prints HEAD and nothing else", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path, "--cursor"]);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([await store.head()]);
  });

  test("--cursor on a store with no history fails", async () => {
    const store = await makeStore({ commit: false });
    const result = await capture(["--store", store.path, "--cursor"]);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
  });

  test("a cursor equal to HEAD emits nothing", async () => {
    const { store } = await populate();
    const result = await capture(["--store", store.path, "--since", await store.head()]);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([]);
  });

  test("an unknown commit fails", async () => {
    const { store } = await populate();
    const result = await capture([
      "--store",
      store.path,
      "--since",
      "0123456789012345678901234567890123456789",
    ]);
    expect(result.code).toBe(1);
  });

  test("a commit that is not an ancestor of HEAD fails rather than misleading", async () => {
    const { store } = await populate();
    await git(store.path, ["checkout", "--quiet", "-b", "aside"]);
    await git(store.path, ["commit", "--quiet", "--allow-empty", "-m", "off to one side"]);
    const orphan = await store.head();
    await git(store.path, ["checkout", "--quiet", "main"]);
    const result = await capture(["--store", store.path, "--since", orphan]);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
  });
});

describe("operations", () => {
  async function extend(): Promise<{
    store: Awaited<ReturnType<typeof makeStore>>;
    cursor: string;
  }> {
    const { store } = await populate();
    const cursor = await store.head();
    const second = await sourceFile(
      record(LEDGER, WIDE, "a wide passage about the sea and the shore") +
        record(LEDGER, NOTE, "a note on the passage") +
        record(QUIET, ELSEWHERE, "another book entirely") +
        record(LEDGER, NARROW, "a narrower passage"),
    );
    const previous = console.log;
    console.log = () => {};
    try {
      expect(await sync(["--source", second, "--store", store.path])).toBe(0);
    } finally {
      console.log = previous;
    }
    return { store, cursor };
  }

  test("an added clipping carries op add and the full record", async () => {
    const { store, cursor } = await extend();
    const result = await capture(["--store", store.path, "--since", cursor]);
    const added = result.objects.filter((o) => o.op === "add");
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe("a narrower passage");
    expect(added[0]?.location).toEqual({ lo: 104, hi: 108 });
  });

  test("a re-attached note carries op modify and the current record", async () => {
    const { store, cursor } = await extend();
    const result = await capture(["--store", store.path, "--since", cursor]);
    const modified = result.objects.filter((o) => o.op === "modify");
    expect(modified).toHaveLength(1);
    expect(modified[0]?.kind).toBe("note");
    expect(modified[0]?.attachedTo).toBeDefined();
  });

  test("a superseded highlight reaches the consumer as a delete plus an add", async () => {
    const { store } = await populate();
    const cursor = await store.head();
    const second = await sourceFile(
      record(LEDGER, WIDE, "a wide passage about the sea and the shore") +
        record(LEDGER, NOTE, "a note on the passage") +
        record(QUIET, ELSEWHERE, "another book entirely") +
        record(
          LEDGER,
          "- Your Highlight on page 42 | Location 100-204 | Added on Friday, January 2, 2026 9:00:00 PM",
          "a wide passage about the sea and the shore, and the harbour too",
        ),
    );
    const previous = console.log;
    console.log = () => {};
    try {
      expect(await sync(["--source", second, "--store", store.path])).toBe(0);
    } finally {
      console.log = previous;
    }

    const result = await capture(["--store", store.path, "--since", cursor]);
    const deleted = result.objects.find((o) => o.op === "delete");
    const added = result.objects.find((o) => o.op === "add");
    expect(deleted).toBeDefined();
    expect(added).toBeDefined();
    expect(added?.supersedes).toEqual([deleted?.id]);
  });

  test("a delete object carries no body", async () => {
    const { store } = await populate();
    const cursor = await store.head();
    const second = await sourceFile(
      record(LEDGER, WIDE, "a wide passage about the sea and the shore") +
        record(LEDGER, NOTE, "a note on the passage") +
        record(QUIET, ELSEWHERE, "another book entirely") +
        record(
          LEDGER,
          "- Your Highlight on page 42 | Location 100-204 | Added on Friday, January 2, 2026 9:00:00 PM",
          "a wide passage about the sea and the shore, and the harbour too",
        ),
    );
    const previous = console.log;
    console.log = () => {};
    try {
      await sync(["--source", second, "--store", store.path]);
    } finally {
      console.log = previous;
    }
    const result = await capture(["--store", store.path, "--since", cursor]);
    const deleted = result.objects.find((o) => o.op === "delete");
    expect(Object.keys(deleted ?? {}).sort()).toEqual([
      "book",
      "id",
      "kind",
      "op",
      "schemaVersion",
    ]);
  });

  test("a cursor query can be narrowed by book", async () => {
    const { store, cursor } = await extend();
    const result = await capture([
      "--store",
      store.path,
      "--since",
      cursor,
      "--book",
      "the-quiet-test",
    ]);
    expect(result.lines).toEqual([]);
  });
});

describe("read-only", () => {
  test("a store declaring a newer schema version is refused", async () => {
    const { store } = await populate();
    await writeFile(join(store.path, "meta.yaml"), 'schemaVersion: 99\nsourceTimezone: "UTC"\n');
    await git(store.path, ["add", "--", "meta.yaml"]);
    await git(store.path, ["commit", "--quiet", "-m", "newer store"]);
    const result = await capture(["--store", store.path]);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
  });

  test("HEAD, the working tree and the index are unchanged afterwards", async () => {
    const { store } = await populate();
    const head = await store.head();
    const status = await store.status();
    const staged = await store.staged();
    await capture(["--store", store.path]);
    await capture(["--store", store.path, "--books"]);
    await capture(["--store", store.path, "--cursor"]);
    await capture(["--store", store.path, "--since", head]);
    expect(await store.head()).toBe(head);
    expect(await store.status()).toBe(status);
    expect(await store.staged()).toBe(staged);
  });
});
