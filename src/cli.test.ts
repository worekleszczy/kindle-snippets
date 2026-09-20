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
