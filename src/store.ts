// The git-backed store on disk: its layout, its YAML records, the single git
// wrapper every command goes through, and the additive write semantics that
// make a device wipe harmless.

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { SyncError } from "./args";
import type { ClippingKind } from "./clippings";
import type { Clipping } from "./identity";

// Bumping this requires its own change carrying a migration: both commands
// refuse a store that declares a version they do not recognise.
export const SCHEMA_VERSION = 1;

export const META_PATH = "meta.yaml";
export const SOURCE_PATH = "source/My Clippings.txt";

export interface BookRecord {
  id: string;
  title: string;
  author: string | null;
  // Every distinct raw title line that has ever resolved to this book, sorted.
  // Two different books whose titles share a four-word prefix land in one
  // directory; recording the lines makes that visible on inspection.
  sources: string[];
}

export function bookPath(bookId: string): string {
  return `books/${bookId}/book.yaml`;
}

// The filename date is the record's local date exactly as the source file
// states it. Deriving a UTC date would make every path depend on a declared
// source timezone, and correcting that value later would rename every file.
export function clippingPath(clipping: Clipping): string {
  return `books/${clipping.book}/clippings/${clipping.timestamp.slice(0, 10)}--${clipping.id}.yaml`;
}

export function isClippingPath(path: string): boolean {
  return /^books\/[^/]+\/clippings\/\d{4}-\d{2}-\d{2}--[0-9a-f]{12}\.yaml$/.test(path);
}

export function isBookPath(path: string): boolean {
  return /^books\/[^/]+\/book\.yaml$/.test(path);
}

export function bookOfPath(path: string): string {
  const parts = path.split("/");
  return parts[1] ?? "";
}

// ---------------------------------------------------------------------------
// Serialisation. Bun.YAML.stringify emits flow style on one line, which throws
// away the readable diff that is the whole reason for choosing YAML, so the
// fixed schema is emitted here: one key order, one scalar style per field, so
// an unchanged record can never produce a spurious diff.

function quoted(value: string): string {
  return JSON.stringify(value);
}

// A block scalar is used only where it round-trips exactly: leading or trailing
// whitespace and control characters need an indentation indicator or escapes,
// so those fall back to a double-quoted scalar.
function hasControlCharacter(line: string): boolean {
  for (const character of line) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

function blockSafe(text: string): boolean {
  if (text === "") return false;
  return text
    .split("\n")
    .every(
      (line) =>
        line === line.trimEnd() &&
        !line.startsWith(" ") &&
        !line.startsWith("\t") &&
        !hasControlCharacter(line),
    );
}

function textField(text: string): string {
  if (!blockSafe(text)) return `text: ${quoted(text)}\n`;
  const body = text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `text: |-\n${body}\n`;
}

function listField(name: string, values: string[]): string {
  if (values.length === 0) return `${name}: []\n`;
  return `${name}:\n${values.map((value) => `  - ${quoted(value)}`).join("\n")}\n`;
}

export function serialiseClipping(clipping: Clipping): string {
  let out = "";
  out += `schemaVersion: ${SCHEMA_VERSION}\n`;
  out += `id: ${quoted(clipping.id)}\n`;
  out += `kind: ${quoted(clipping.kind)}\n`;
  out += `book: ${quoted(clipping.book)}\n`;
  out += `timestamp: ${quoted(clipping.timestamp)}\n`;
  out += `page: ${clipping.page === null ? "null" : quoted(clipping.page)}\n`;
  out += `location:\n  lo: ${clipping.location.lo}\n  hi: ${clipping.location.hi}\n`;
  out += textField(clipping.text);
  out += "chapter: null\n";
  out += `empty: ${clipping.empty}\n`;
  out += `drmLimited: ${clipping.drmLimited}\n`;
  if (clipping.kind === "highlight") out += listField("supersedes", clipping.supersedes);
  if (clipping.kind === "note") {
    out += `attachedTo: ${clipping.attachedTo === null ? "null" : quoted(clipping.attachedTo)}\n`;
  }
  return out;
}

export function serialiseBook(book: BookRecord): string {
  let out = "";
  out += `schemaVersion: ${SCHEMA_VERSION}\n`;
  out += `id: ${quoted(book.id)}\n`;
  out += `title: ${quoted(book.title)}\n`;
  out += `author: ${book.author === null ? "null" : quoted(book.author)}\n`;
  out += listField("sources", book.sources);
  return out;
}

// meta.yaml carries nothing that changes between runs: a `lastSync` field would
// make every sync rewrite it and therefore produce a commit, defeating
// idempotency. The last sync time is already the HEAD commit's date.
export function serialiseMeta(sourceTimezone: string): string {
  return `schemaVersion: ${SCHEMA_VERSION}\nsourceTimezone: ${quoted(sourceTimezone)}\n`;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncError(`${path} is not a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(fields: Record<string, unknown>, key: string, path: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new SyncError(`${path}: ${key} is missing or not a string`);
  return value;
}

function optionalString(fields: Record<string, unknown>, key: string, path: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SyncError(`${path}: ${key} is not a string or null`);
  return value;
}

function requireNumber(fields: Record<string, unknown>, key: string, path: string): number {
  const value = fields[key];
  if (typeof value !== "number") throw new SyncError(`${path}: ${key} is missing or not a number`);
  return value;
}

function requireBoolean(fields: Record<string, unknown>, key: string, path: string): boolean {
  const value = fields[key];
  if (typeof value !== "boolean")
    throw new SyncError(`${path}: ${key} is missing or not a boolean`);
  return value;
}

function requireStrings(fields: Record<string, unknown>, key: string, path: string): string[] {
  const value = fields[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SyncError(`${path}: ${key} is not a list of strings`);
  }
  return value as string[];
}

function checkVersion(fields: Record<string, unknown>, path: string): void {
  const declared = requireNumber(fields, "schemaVersion", path);
  if (declared !== SCHEMA_VERSION) {
    throw new SyncError(
      `${path} declares schemaVersion ${declared}, but this build understands ${SCHEMA_VERSION}`,
    );
  }
}

export function parseClippingFile(contents: string, path: string): Clipping {
  const fields = asRecord(Bun.YAML.parse(contents), path);
  checkVersion(fields, path);
  const kind = requireString(fields, "kind", path);
  if (kind !== "highlight" && kind !== "note" && kind !== "bookmark") {
    throw new SyncError(`${path}: unknown kind ${JSON.stringify(kind)}`);
  }
  const location = asRecord(fields.location, `${path}: location`);
  return {
    id: requireString(fields, "id", path),
    kind: kind as ClippingKind,
    book: requireString(fields, "book", path),
    timestamp: requireString(fields, "timestamp", path),
    page: optionalString(fields, "page", path),
    location: {
      lo: requireNumber(location, "lo", `${path}: location`),
      hi: requireNumber(location, "hi", `${path}: location`),
    },
    text: requireString(fields, "text", path),
    chapter: null,
    empty: requireBoolean(fields, "empty", path),
    drmLimited: requireBoolean(fields, "drmLimited", path),
    supersedes: requireStrings(fields, "supersedes", path),
    attachedTo: optionalString(fields, "attachedTo", path),
  };
}

export function parseBookFile(contents: string, path: string): BookRecord {
  const fields = asRecord(Bun.YAML.parse(contents), path);
  checkVersion(fields, path);
  return {
    id: requireString(fields, "id", path),
    title: requireString(fields, "title", path),
    author: optionalString(fields, "author", path),
    sources: requireStrings(fields, "sources", path),
  };
}

// ---------------------------------------------------------------------------
// git

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// runGit is the one place a git subprocess is started. A non-zero exit is a
// failure carrying the binary's own stderr; callers that treat a non-zero exit
// as information (`config`, `merge-base --is-ancestor`) use tryGit instead.
// The environment is passed explicitly: Bun snapshots the parent environment
// at start-up, so a child would otherwise not see a variable the process set
// after launch.
function spawnGit(command: string[]) {
  try {
    return Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    });
  } catch (error) {
    throw new SyncError(`git could not be executed: ${(error as Error).message}`);
  }
}

export async function tryGit(store: string, args: string[]): Promise<GitResult> {
  const proc = spawnGit(["git", "-C", store, ...args]);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export async function git(store: string, args: string[]): Promise<string> {
  const result = await tryGit(store, args);
  if (result.code !== 0) {
    throw new SyncError(
      `git ${args.join(" ")} failed in ${store} (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// Resolved against the current PATH on every call rather than once at start,
// so the check reports the environment the command is actually running in.
function gitIsExecutable(): boolean {
  return Bun.which("git", { PATH: process.env.PATH ?? "" }) !== null;
}

// ---------------------------------------------------------------------------
// Preconditions

export interface Preconditions {
  // A source file is only required by `sync`; `query` never reads one.
  source?: string;
  requireCleanTree: boolean;
  requireIdentity: boolean;
}

export async function checkStore(store: string, options: Preconditions): Promise<void> {
  if (options.source !== undefined) {
    const file = Bun.file(options.source);
    if (!(await file.exists())) {
      throw new SyncError(`source file not found: ${options.source}`);
    }
  }
  if (!gitIsExecutable()) {
    throw new SyncError("git is not executable; kindle-sync needs the git binary on PATH");
  }
  const repository = await tryGit(store, ["rev-parse", "--git-dir"]);
  if (repository.code !== 0) {
    throw new SyncError(`store path is not a git repository: ${store}`);
  }
  if (options.requireCleanTree) {
    const status = await git(store, ["status", "--porcelain"]);
    if (status.trim() !== "") {
      throw new SyncError(
        `store has uncommitted changes; commit or discard them first: ${store}\n${status.trim()}`,
      );
    }
  }
  if (options.requireIdentity) {
    for (const key of ["user.name", "user.email"]) {
      const value = await tryGit(store, ["config", "--get", key]);
      if (value.code !== 0 || value.stdout.trim() === "") {
        throw new SyncError(`no commit identity in ${store}: git config ${key} does not resolve`);
      }
    }
  }
  await readMeta(store);
}

// readMeta exists to verify the declared schema version. Nothing reads
// `sourceTimezone`: it is documentation for a consumer that needs an absolute
// instant, and no identifier, path or derivation may depend on it.
export async function readMeta(store: string): Promise<{ schemaVersion: number } | null> {
  const file = Bun.file(join(store, META_PATH));
  if (!(await file.exists())) return null;
  const fields = asRecord(Bun.YAML.parse(await file.text()), META_PATH);
  checkVersion(fields, META_PATH);
  return { schemaVersion: SCHEMA_VERSION };
}

// ---------------------------------------------------------------------------
// Reading the store

export interface StoreContents {
  clippings: Clipping[];
  books: Map<string, BookRecord>;
}

// readStore reads every record back. Sync needs the whole store because
// consolidation runs over the union of stored and parsed records; at a few
// thousand small YAML files that is immaterial.
export async function readStore(store: string): Promise<StoreContents> {
  const clippings: Clipping[] = [];
  const books = new Map<string, BookRecord>();
  const clippingFiles = new Bun.Glob("books/*/clippings/*.yaml");
  for await (const path of clippingFiles.scan({ cwd: store })) {
    const contents = await Bun.file(join(store, path)).text();
    clippings.push(parseClippingFile(contents, path));
  }
  const bookFiles = new Bun.Glob("books/*/book.yaml");
  for await (const path of bookFiles.scan({ cwd: store })) {
    const contents = await Bun.file(join(store, path)).text();
    const book = parseBookFile(contents, path);
    books.set(book.id, book);
  }
  clippings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { clippings, books };
}

// ---------------------------------------------------------------------------
// Changesets

export interface BookCounts {
  added: number;
  deleted: number;
}

export interface Changeset {
  added: string[];
  modified: string[];
  deleted: string[];
  // Contents for every added or modified path.
  files: Map<string, string>;
  clippings: BookCounts;
  books: Map<string, BookCounts>;
}

export function isEmptyChangeset(changeset: Changeset): boolean {
  return (
    changeset.added.length === 0 &&
    changeset.modified.length === 0 &&
    changeset.deleted.length === 0
  );
}

export interface StorePlan {
  kept: Clipping[];
  // Highlights consolidation superseded. They are the only files a sync
  // deletes: a clipping merely absent from the source is retained.
  discarded: Clipping[];
  books: BookRecord[];
  source: string;
  sourceTimezone: string;
}

function countFor(counts: Map<string, BookCounts>, book: string): BookCounts {
  const existing = counts.get(book);
  if (existing !== undefined) return existing;
  const fresh = { added: 0, deleted: 0 };
  counts.set(book, fresh);
  return fresh;
}

export async function computeChangeset(store: string, plan: StorePlan): Promise<Changeset> {
  const changeset: Changeset = {
    added: [],
    modified: [],
    deleted: [],
    files: new Map(),
    clippings: { added: 0, deleted: 0 },
    books: new Map(),
  };

  const desired = new Map<string, string>();
  for (const clipping of plan.kept)
    desired.set(clippingPath(clipping), serialiseClipping(clipping));
  for (const book of plan.books) desired.set(bookPath(book.id), serialiseBook(book));
  desired.set(SOURCE_PATH, plan.source);
  if ((await Bun.file(join(store, META_PATH)).exists()) === false) {
    desired.set(META_PATH, serialiseMeta(plan.sourceTimezone));
  }

  const keptPaths = new Set(plan.kept.map((clipping) => clippingPath(clipping)));
  for (const [path, contents] of [...desired].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = Bun.file(join(store, path));
    const exists = await file.exists();
    if (exists && (await file.text()) === contents) continue;
    changeset.files.set(path, contents);
    if (exists) {
      changeset.modified.push(path);
      continue;
    }
    changeset.added.push(path);
    if (isClippingPath(path)) {
      changeset.clippings.added++;
      countFor(changeset.books, bookOfPath(path)).added++;
    }
  }

  for (const clipping of plan.discarded) {
    const path = clippingPath(clipping);
    if (keptPaths.has(path)) continue;
    if (!(await Bun.file(join(store, path)).exists())) continue;
    changeset.deleted.push(path);
    changeset.clippings.deleted++;
    countFor(changeset.books, bookOfPath(path)).deleted++;
  }
  changeset.deleted.sort();

  return changeset;
}

export function commitMessage(changeset: Changeset): string {
  const books = [...changeset.books.keys()].sort();
  const subject = `sync: ${changeset.clippings.added} clipping(s) added, ${changeset.clippings.deleted} superseded across ${books.length} book(s)`;
  const body = books
    .map((book) => {
      const counts = countFor(changeset.books, book);
      return `${book}: ${counts.added} added, ${counts.deleted} deleted`;
    })
    .join("\n");
  return body === "" ? subject : `${subject}\n\n${body}`;
}

// applyChangeset writes, stages and commits in one step. It is never called
// with an empty changeset: a sync that changes nothing must leave the store's
// history untouched, rather than record an empty commit.
export async function applyChangeset(store: string, changeset: Changeset): Promise<void> {
  for (const [path, contents] of changeset.files) {
    await Bun.write(join(store, path), contents, { createPath: true });
  }
  for (const path of changeset.deleted) {
    await unlink(join(store, path));
  }
  const paths = [...changeset.files.keys(), ...changeset.deleted];
  await git(store, ["add", "--", ...paths]);
  await git(store, ["commit", "--quiet", "-m", commitMessage(changeset)]);
}
