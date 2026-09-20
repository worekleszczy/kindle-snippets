import { describe, expect, test } from "bun:test";
import {
  checkFlags,
  flagValue,
  flagValues,
  hasFlag,
  positionals,
  scanFlag,
  unknownFlags,
} from "./args";

describe("scanFlag", () => {
  test("collects every occurrence in order", () => {
    expect(scanFlag(["--tag", "a", "--tag", "b"], "--tag")).toEqual({
      values: ["a", "b"],
      missing: false,
    });
  });

  test("a trailing flag reports missing, not a value", () => {
    expect(scanFlag(["--tag"], "--tag")).toEqual({ values: [], missing: true });
  });

  test("consumes the value, so a repeated flag cannot self-match", () => {
    expect(scanFlag(["--tag", "--tag"], "--tag")).toEqual({ values: ["--tag"], missing: false });
  });
});

describe("flagValues / flagValue", () => {
  test("flagValues returns all, flagValue the last", () => {
    const args = ["--out", "one", "--out", "two"];
    expect(flagValues(args, "--out")).toEqual(["one", "two"]);
    expect(flagValue(args, "--out")).toBe("two");
  });

  test("flagValue is undefined when absent", () => {
    expect(flagValue([], "--out")).toBeUndefined();
  });
});

test("hasFlag", () => {
  expect(hasFlag(["--dry-run"], "--dry-run")).toBe(true);
  expect(hasFlag([], "--dry-run")).toBe(false);
});

describe("positionals", () => {
  test("skips flags and their values", () => {
    expect(positionals(["sync", "--out", "dir", "book"], ["--out"])).toEqual(["sync", "book"]);
  });

  test("skips a value that itself looks like a flag", () => {
    expect(positionals(["--out", "--weird", "book"], ["--out"])).toEqual(["book"]);
  });
});

describe("unknownFlags", () => {
  test("reports only flags outside the vocabulary", () => {
    expect(unknownFlags(["--out", "dir", "--verbose", "--nope"], ["--out"], ["--verbose"])).toEqual(
      ["--nope"],
    );
  });
});

describe("checkFlags", () => {
  test("clean arguments pass", () => {
    expect(checkFlags(["--out", "dir", "--verbose"], ["--out"], ["--verbose"], "sync")).toBeNull();
  });

  test("unknown flag, missing value and stray positional are usage errors", () => {
    expect(checkFlags(["--nope"], [], [], "sync")).toBe(2);
    expect(checkFlags(["--out"], ["--out"], [], "sync")).toBe(2);
    expect(checkFlags(["stray"], [], [], "sync")).toBe(2);
  });
});
