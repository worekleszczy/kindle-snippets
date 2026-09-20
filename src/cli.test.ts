import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run, VERSION } from "./cli";

describe("run", () => {
  test("help exits 0", async () => {
    expect(await run(["help"])).toBe(0);
    expect(await run(["--help"])).toBe(0);
    expect(await run(["-h"])).toBe(0);
  });

  test("version exits 0", async () => {
    expect(await run(["version"])).toBe(0);
    expect(await run(["--version"])).toBe(0);
  });

  test("no command is a usage error", async () => {
    expect(await run([])).toBe(2);
  });

  test("unknown command is a usage error", async () => {
    expect(await run(["frobnicate"])).toBe(2);
  });
});

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(VERSION).toBe(pkg.version);
});

describe("dispatch", () => {
  test("sync without a store is a usage error, not an unknown command", async () => {
    const previous = process.env.KINDLE_SYNC_STORE;
    delete process.env.KINDLE_SYNC_STORE;
    try {
      expect(await run(["sync"])).toBe(2);
      expect(await run(["query"])).toBe(2);
    } finally {
      if (previous !== undefined) process.env.KINDLE_SYNC_STORE = previous;
    }
  });

  test("an unknown flag reaches each command's own validation", async () => {
    expect(await run(["sync", "--store", "/tmp", "--nope"])).toBe(2);
    expect(await run(["query", "--store", "/tmp", "--nope"])).toBe(2);
  });

  test("a store that is not a git repository is a runtime failure", async () => {
    expect(await run(["query", "--store", "/tmp/definitely-not-a-repository"])).toBe(1);
  });

  test("the usage text names both commands and their flags", async () => {
    const lines: string[] = [];
    const previous = console.log;
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(" "));
    };
    try {
      expect(await run(["help"])).toBe(0);
    } finally {
      console.log = previous;
    }
    const text = lines.join("\n");
    for (const token of [
      "kindle-sync sync",
      "kindle-sync query",
      "--source",
      "--store",
      "--dry-run",
      "--since",
      "--books",
      "--cursor",
      "KINDLE_SYNC_SOURCE",
      "KINDLE_SYNC_STORE",
    ]) {
      expect(text).toContain(token);
    }
  });
});
