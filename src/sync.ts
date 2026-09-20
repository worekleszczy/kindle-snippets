// The `sync` command: read the device file, consolidate it against everything
// the store already holds, write the result and commit. Sync is additive — the
// only clipping it deletes is one that consolidation supersedes — so a device
// wipe or a wrong source path can do no worse than change nothing.

import { checkFlags, EXIT_OK, failure, flagValue, hasFlag, SyncError, usage } from "./args";
import { parseClippings } from "./clippings";
import { consolidate, unionClippings } from "./consolidate";
import { deriveBook, deriveClippings } from "./identity";
import type { BookRecord, Changeset } from "./store";
import { applyChangeset, checkStore, computeChangeset, isEmptyChangeset, readStore } from "./store";

export const DEFAULT_SOURCE = "/Volumes/Kindle/documents/My Clippings.txt";

export interface SyncOptions {
  source: string;
  store: string;
  dryRun: boolean;
  sourceTimezone: string;
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function describeChangeset(changeset: Changeset): string {
  const lines: string[] = [];
  for (const path of changeset.added) lines.push(`+ ${path}`);
  for (const path of changeset.modified) lines.push(`~ ${path}`);
  for (const path of changeset.deleted) lines.push(`- ${path}`);
  return lines.join("\n");
}

// mergeBooks keeps every book the store already has and folds in the title
// lines this source carries. `sources` is the sorted union, and the title and
// author are read from its first entry, so the record does not depend on the
// order the records happened to arrive in.
function mergeBooks(stored: Map<string, BookRecord>, titleLines: string[]): BookRecord[] {
  const sources = new Map<string, Set<string>>();
  for (const [id, book] of stored) sources.set(id, new Set(book.sources));
  for (const line of titleLines) {
    const { id } = deriveBook(line);
    const existing = sources.get(id);
    if (existing === undefined) sources.set(id, new Set([line]));
    else existing.add(line);
  }
  const books: BookRecord[] = [];
  for (const [id, lines] of sources) {
    const sorted = [...lines].sort();
    const first = sorted[0];
    if (first === undefined) {
      const kept = stored.get(id);
      if (kept !== undefined) books.push(kept);
      continue;
    }
    const { title, author } = deriveBook(first);
    books.push({ id, title, author, sources: sorted });
  }
  return books.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function runSync(options: SyncOptions): Promise<number> {
  await checkStore(options.store, {
    source: options.source,
    requireCleanTree: true,
    requireIdentity: true,
  });

  const source = await Bun.file(options.source).text();
  const { records, failures } = parseClippings(source);
  if (failures.length > 0) {
    for (const problem of failures) {
      failure(`${options.source}: record ${problem.record}: ${problem.message}`);
    }
    return failure(`${failures.length} record(s) did not parse; nothing was written`);
  }

  const parsed = deriveClippings(records);
  const stored = await readStore(options.store);
  const { kept, discarded } = consolidate(unionClippings(stored.clippings, parsed));
  const books = mergeBooks(
    stored.books,
    records.map((record) => record.titleLine),
  );

  const changeset = await computeChangeset(options.store, {
    kept,
    discarded,
    books,
    source,
    sourceTimezone: options.sourceTimezone,
  });

  if (isEmptyChangeset(changeset)) {
    console.log("nothing changed");
    return EXIT_OK;
  }

  console.log(describeChangeset(changeset));
  if (options.dryRun) {
    console.log(
      `dry run: ${changeset.clippings.added} clipping(s) would be added, ${changeset.clippings.deleted} deleted; nothing was written`,
    );
    return EXIT_OK;
  }

  await applyChangeset(options.store, changeset);
  console.log(
    `committed ${changeset.clippings.added} clipping(s) added, ${changeset.clippings.deleted} superseded`,
  );
  return EXIT_OK;
}

export async function sync(args: string[]): Promise<number> {
  const invalid = checkFlags(args, ["--source", "--store", "--timezone"], ["--dry-run"], "sync");
  if (invalid !== null) return invalid;

  const source = flagValue(args, "--source") ?? process.env.KINDLE_SYNC_SOURCE ?? DEFAULT_SOURCE;
  // The store has no default on purpose: guessing one risks committing a
  // personal library into whatever repository happens to be there.
  const store = flagValue(args, "--store") ?? process.env.KINDLE_SYNC_STORE;
  if (store === undefined || store === "") {
    return usage("sync requires --store <path> or KINDLE_SYNC_STORE");
  }

  try {
    return await runSync({
      source,
      store,
      dryRun: hasFlag(args, "--dry-run"),
      sourceTimezone: flagValue(args, "--timezone") ?? systemTimezone(),
    });
  } catch (error) {
    if (error instanceof SyncError) return failure(error.message);
    return failure(error instanceof Error ? error.message : String(error));
  }
}
