// Test support: a throwaway git repository to act as a store. Every store test
// gets its own, because the commands' preconditions are about repository state
// and sharing one would couple the tests to each other's commits.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../store";

export interface TempStore {
  path: string;
  head: () => Promise<string>;
  log: () => Promise<string[]>;
  status: () => Promise<string>;
  staged: () => Promise<string>;
}

export async function makeStore(options: { commit?: boolean } = {}): Promise<TempStore> {
  const path = await mkdtemp(join(tmpdir(), "kindle-sync-store-"));
  await git(path, ["init", "--quiet", "--initial-branch", "main"]);
  await git(path, ["config", "user.name", "Fixture Author"]);
  await git(path, ["config", "user.email", "fixture@example.invalid"]);
  if (options.commit !== false) {
    await git(path, ["commit", "--quiet", "--allow-empty", "-m", "initialise store"]);
  }
  return {
    path,
    head: async () => (await git(path, ["rev-parse", "HEAD"])).trim(),
    log: async () =>
      (await git(path, ["log", "--format=%H"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    status: async () => (await git(path, ["status", "--porcelain"])).trim(),
    staged: async () => (await git(path, ["diff", "--cached", "--name-only"])).trim(),
  };
}
