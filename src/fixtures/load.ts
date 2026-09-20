// Loaders for the committed fixture. `clippings.txt` is an obfuscated extract
// of a real `My Clippings.txt` — the structure, metadata lines, timestamps and
// byte-level quirks are real, the titles and the words are synthetic — plus the
// deliberately constructed cases in `scripts/fixture-cases.txt`. The expected
// counts live beside it so the specs do not have to encode facts about anyone's
// library.

import { readFileSync } from "node:fs";

export interface ExpectedNote {
  id: string;
  book: string;
  location: number;
  attachedTo: string | null;
}

export interface ExpectedFixture {
  records: number;
  books: string[];
  kinds: { highlight: number; note: number; bookmark: number };
  highlights: { kept: number; discarded: number };
  notes: ExpectedNote[];
}

export function fixtureSource(): string {
  return readFileSync(new URL("./clippings.txt", import.meta.url), "utf8");
}

export function fixtureExpectations(): ExpectedFixture {
  const raw = readFileSync(new URL("./clippings.expected.json", import.meta.url), "utf8");
  return JSON.parse(raw) as ExpectedFixture;
}
