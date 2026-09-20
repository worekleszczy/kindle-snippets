// The `query` command: the read surface external tooling pulls from. It is
// strictly read-only — no file is written, no commit is made, the index and the
// working tree are left alone — and stdout carries nothing but JSON Lines so a
// consumer can pipe it straight into a parser.

import { checkFlags, EXIT_OK, failure, flagValue, hasFlag, SyncError, usage } from "./args";
import type { Clipping } from "./identity";
import type { BookRecord } from "./store";
import {
  bookOfPath,
  checkStore,
  clippingPath,
  isBookPath,
  isClippingPath,
  parseClippingFile,
  readStore,
  SCHEMA_VERSION,
  tryGit,
} from "./store";

export type Op = "add" | "modify" | "delete";

export interface QueryOptions {
  store: string;
  book?: string;
  since?: string;
  books: boolean;
  cursor: boolean;
}

function clippingObject(clipping: Clipping, op?: Op): Record<string, unknown> {
  const out: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION };
  if (op !== undefined) out.op = op;
  out.id = clipping.id;
  out.kind = clipping.kind;
  out.book = clipping.book;
  out.timestamp = clipping.timestamp;
  out.page = clipping.page;
  out.location = clipping.location;
  out.text = clipping.text;
  out.chapter = clipping.chapter;
  out.empty = clipping.empty;
  out.drmLimited = clipping.drmLimited;
  if (clipping.kind === "highlight") out.supersedes = clipping.supersedes;
  if (clipping.kind === "note") out.attachedTo = clipping.attachedTo;
  return out;
}

// A delete carries only what a consumer needs to drop its own copy: the record
// itself is gone from HEAD, so there is no body to send.
function deleteObject(clipping: Clipping): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    op: "delete",
    id: clipping.id,
    book: clipping.book,
    kind: clipping.kind,
  };
}

function bookObject(book: BookRecord, op?: Op): Record<string, unknown> {
  const out: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION };
  if (op !== undefined) out.op = op;
  out.id = book.id;
  out.title = book.title;
  out.author = book.author;
  out.sources = book.sources;
  return out;
}

function byBookThenTimeThenId(a: Clipping, b: Clipping): number {
  if (a.book !== b.book) return a.book < b.book ? -1 : 1;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface Change {
  status: string;
  path: string;
}

// A cursor is only meaningful while the history it names is still reachable:
// a rewritten store would otherwise hand a consumer a changeset computed
// against a commit that no longer describes what it published.
async function resolveCursor(store: string, cursor: string): Promise<void> {
  const exists = await tryGit(store, ["rev-parse", "--verify", "--quiet", `${cursor}^{commit}`]);
  if (exists.code !== 0) {
    throw new SyncError(`unknown commit in ${store}: ${cursor}`);
  }
  const ancestor = await tryGit(store, ["merge-base", "--is-ancestor", cursor, "HEAD"]);
  if (ancestor.code !== 0) {
    throw new SyncError(
      `cursor ${cursor} is not reachable from HEAD; the store's history has been rewritten past it`,
    );
  }
}

async function changesSince(store: string, cursor: string): Promise<Change[]> {
  // Rename detection is off deliberately: a superseded highlight keeps its text
  // but changes identifier, and the published contract is that a consumer sees
  // that as a delete followed by an add.
  const diff = await tryGit(store, ["diff", "--name-status", "--no-renames", `${cursor}..HEAD`]);
  if (diff.code !== 0) {
    throw new SyncError(`git diff ${cursor}..HEAD failed in ${store}: ${diff.stderr.trim()}`);
  }
  const changes: Change[] = [];
  for (const line of diff.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [status, path] = line.split("\t");
    if (status === undefined || path === undefined) continue;
    changes.push({ status, path });
  }
  return changes;
}

function opOf(status: string): Op | null {
  if (status.startsWith("A")) return "add";
  if (status.startsWith("D")) return "delete";
  if (status.startsWith("M")) return "modify";
  return null;
}

async function showFile(store: string, commit: string, path: string): Promise<string> {
  const result = await tryGit(store, ["show", `${commit}:${path}`]);
  if (result.code !== 0) {
    throw new SyncError(`cannot read ${path} at ${commit} in ${store}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function runQuery(options: QueryOptions): Promise<number> {
  await checkStore(options.store, { requireCleanTree: false, requireIdentity: false });

  if (options.cursor) {
    const head = await tryGit(options.store, ["rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() === "") {
      throw new SyncError(`the store has no history: ${options.store}`);
    }
    console.log(head.stdout.trim());
    return EXIT_OK;
  }

  const contents = await readStore(options.store);
  if (options.book !== undefined && !contents.books.has(options.book)) {
    throw new SyncError(`unknown book in ${options.store}: ${options.book}`);
  }

  const matchesBook = (book: string): boolean =>
    options.book === undefined || book === options.book;

  if (options.since === undefined) {
    if (options.books) {
      const books = [...contents.books.values()]
        .filter((book) => matchesBook(book.id))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const book of books) console.log(JSON.stringify(bookObject(book)));
      return EXIT_OK;
    }
    const clippings = contents.clippings
      .filter((clipping) => matchesBook(clipping.book))
      .sort(byBookThenTimeThenId);
    for (const clipping of clippings) console.log(JSON.stringify(clippingObject(clipping)));
    return EXIT_OK;
  }

  await resolveCursor(options.store, options.since);
  const changes = await changesSince(options.store, options.since);

  if (options.books) {
    const rows: { id: string; line: string }[] = [];
    for (const change of changes) {
      if (!isBookPath(change.path)) continue;
      const op = opOf(change.status);
      if (op === null) continue;
      const id = bookOfPath(change.path);
      if (!matchesBook(id)) continue;
      if (op === "delete") {
        rows.push({ id, line: JSON.stringify({ schemaVersion: SCHEMA_VERSION, op, id }) });
        continue;
      }
      const book = contents.books.get(id);
      if (book === undefined) {
        throw new SyncError(`${change.path} changed since ${options.since} but is not readable`);
      }
      rows.push({ id, line: JSON.stringify(bookObject(book, op)) });
    }
    for (const row of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) console.log(row.line);
    return EXIT_OK;
  }

  const byPath = new Map(contents.clippings.map((c) => [clippingPath(c), c]));
  const rows: { clipping: Clipping; line: string }[] = [];
  for (const change of changes) {
    if (!isClippingPath(change.path)) continue;
    const op = opOf(change.status);
    if (op === null) continue;
    if (!matchesBook(bookOfPath(change.path))) continue;
    if (op === "delete") {
      const gone = parseClippingFile(
        await showFile(options.store, options.since, change.path),
        change.path,
      );
      rows.push({ clipping: gone, line: JSON.stringify(deleteObject(gone)) });
      continue;
    }
    const current = byPath.get(change.path);
    if (current === undefined) {
      throw new SyncError(`${change.path} changed since ${options.since} but is not readable`);
    }
    rows.push({ clipping: current, line: JSON.stringify(clippingObject(current, op)) });
  }
  for (const row of rows.sort((a, b) => byBookThenTimeThenId(a.clipping, b.clipping))) {
    console.log(row.line);
  }
  return EXIT_OK;
}

export async function query(args: string[]): Promise<number> {
  const invalid = checkFlags(
    args,
    ["--store", "--book", "--since"],
    ["--books", "--cursor"],
    "query",
  );
  if (invalid !== null) return invalid;

  const store = flagValue(args, "--store") ?? process.env.KINDLE_SYNC_STORE;
  if (store === undefined || store === "") {
    return usage("query requires --store <path> or KINDLE_SYNC_STORE");
  }

  try {
    return await runQuery({
      store,
      book: flagValue(args, "--book"),
      since: flagValue(args, "--since"),
      books: hasFlag(args, "--books"),
      // --cursor answers a different question from the record filters, so it
      // takes precedence and prints only the commit identifier.
      cursor: hasFlag(args, "--cursor"),
    });
  } catch (error) {
    if (error instanceof SyncError) return failure(error.message);
    return failure(error instanceof Error ? error.message : String(error));
  }
}
