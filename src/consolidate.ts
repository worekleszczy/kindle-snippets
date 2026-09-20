// The two derivations that reduce a record set: collapsing a highlight into a
// later one that contains its text, and attaching each note to exactly one
// highlight. Both run over the union of what the store already holds and what
// the source file currently says, so a stored record stays supersedable after
// it has left the device file.

import type { Clipping } from "./identity";

export interface Consolidation {
  kept: Clipping[];
  // Highlights collapsed into a survivor. Every one of them is named in some
  // kept highlight's `supersedes`.
  discarded: Clipping[];
}

// normalise is for comparison only. The store always holds the text exactly as
// the device wrote it, invisible characters included.
export function normalise(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
}

function sortedUnion(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

// instant converts a zone-less local timestamp to a comparable number by
// reading its fields directly. Nothing here consults a timezone: the value is
// only ever compared with another value from the same device.
function instant(timestamp: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(timestamp);
  if (match === null) return Number.NaN;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function byBookThenTimeThenId(a: Clipping, b: Clipping): number {
  if (a.book !== b.book) return a.book < b.book ? -1 : 1;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// unionClippings keys stored and newly parsed records by identifier. The
// parsed record wins on content — the source file is what the device says —
// while `supersedes` accumulates, so an identifier collapsed by an earlier run
// is never forgotten.
export function unionClippings(stored: Clipping[], parsed: Clipping[]): Clipping[] {
  const byId = new Map<string, Clipping>();
  for (const clipping of stored) byId.set(clipping.id, clipping);
  for (const clipping of parsed) {
    const prior = byId.get(clipping.id);
    if (prior === undefined) {
      byId.set(clipping.id, clipping);
      continue;
    }
    byId.set(clipping.id, {
      ...clipping,
      supersedes: sortedUnion(prior.supersedes, clipping.supersedes),
    });
  }
  return [...byId.values()].sort(byBookThenTimeThenId);
}

function intersects(a: Clipping, b: Clipping): boolean {
  return a.location.lo <= b.location.hi && b.location.lo <= a.location.hi;
}

// comparable excludes empty and DRM-limited highlights from collapse in both
// directions. The clipping-limit sentinel is identical in every record that
// carries it, so comparing it would merge distinct highlight events whose text
// Amazon withheld.
function comparable(clipping: Clipping): boolean {
  return clipping.kind === "highlight" && !clipping.empty && !clipping.drmLimited;
}

// winnerOf decides which of a containing pair survives: the longer text, then
// the earlier timestamp, then the smaller identifier. Returns null when the
// pair does not collapse at all.
function winnerOf(a: Clipping, b: Clipping, na: string, nb: string): [Clipping, Clipping] | null {
  if (!na.includes(nb) && !nb.includes(na)) return null;
  if (na.length !== nb.length) return na.length > nb.length ? [a, b] : [b, a];
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

function collapseBook(highlights: Clipping[]): { kept: Clipping[]; discarded: Clipping[] } {
  // Sorting by range makes the outcome independent of the order the records
  // arrived in, and lets the inner scan stop as soon as ranges cannot intersect.
  const ordered = [...highlights].sort((a, b) => {
    if (a.location.lo !== b.location.lo) return a.location.lo - b.location.lo;
    if (a.location.hi !== b.location.hi) return a.location.hi - b.location.hi;
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const alive = new Map<string, Clipping>(ordered.map((h) => [h.id, h]));
  const discarded = new Map<string, Clipping>();
  const normalised = new Map<string, string>(ordered.map((h) => [h.id, normalise(h.text)]));

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ordered.length; i++) {
      const left = ordered[i];
      if (left === undefined || !alive.has(left.id) || !comparable(left)) continue;
      for (let j = i + 1; j < ordered.length; j++) {
        const right = ordered[j];
        if (right === undefined) continue;
        if (right.location.lo > left.location.hi) break;
        if (!alive.has(right.id) || !comparable(right)) continue;
        const current = alive.get(left.id);
        const other = alive.get(right.id);
        if (current === undefined || other === undefined) continue;
        if (!intersects(current, other)) continue;
        const na = normalised.get(current.id);
        const nb = normalised.get(other.id);
        if (na === undefined || nb === undefined) continue;
        const outcome = winnerOf(current, other, na, nb);
        if (outcome === null) continue;
        const [winner, loser] = outcome;
        alive.set(winner.id, {
          ...winner,
          supersedes: sortedUnion(winner.supersedes, loser.supersedes, [loser.id]),
        });
        alive.delete(loser.id);
        discarded.set(loser.id, { ...loser, supersedes: [...loser.supersedes] });
        changed = true;
        if (loser.id === left.id) break;
      }
    }
  }
  return { kept: [...alive.values()], discarded: [...discarded.values()] };
}

// attach picks the highlight a note annotates: containing range first, then the
// narrowest of them, then the nearest timestamp, then the smaller identifier so
// that a complete tie still resolves the same way on every machine. An empty or
// DRM-limited highlight is a valid target — it marks a passage that was
// genuinely highlighted and whose text was withheld.
function attach(note: Clipping, highlights: Clipping[]): string | null {
  let best: Clipping | undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const highlight of highlights) {
    if (highlight.location.lo > note.location.lo) continue;
    if (highlight.location.hi < note.location.hi) continue;
    const width = highlight.location.hi - highlight.location.lo;
    const distance = Math.abs(instant(highlight.timestamp) - instant(note.timestamp));
    if (best === undefined || width < bestWidth) {
      best = highlight;
      bestWidth = width;
      bestDistance = distance;
      continue;
    }
    if (width > bestWidth) continue;
    if (distance < bestDistance) {
      best = highlight;
      bestDistance = distance;
      continue;
    }
    if (distance === bestDistance && highlight.id < best.id) best = highlight;
  }
  return best?.id ?? null;
}

// consolidate collapses highlights book by book and then attaches every note to
// one of the survivors. Notes and bookmarks are never collapsed, discarded or
// merged, whatever their locations say.
export function consolidate(clippings: Clipping[]): Consolidation {
  const books = new Map<string, Clipping[]>();
  for (const clipping of clippings) {
    const bucket = books.get(clipping.book);
    if (bucket === undefined) books.set(clipping.book, [clipping]);
    else bucket.push(clipping);
  }

  const kept: Clipping[] = [];
  const discarded: Clipping[] = [];
  for (const bucket of books.values()) {
    const highlights = bucket.filter((c) => c.kind === "highlight");
    const collapsed = collapseBook(highlights);
    discarded.push(...collapsed.discarded);
    kept.push(...collapsed.kept);
    for (const clipping of bucket) {
      if (clipping.kind === "highlight") continue;
      if (clipping.kind === "bookmark") {
        kept.push({ ...clipping, attachedTo: null, supersedes: [] });
        continue;
      }
      kept.push({ ...clipping, attachedTo: attach(clipping, collapsed.kept), supersedes: [] });
    }
  }

  kept.sort(byBookThenTimeThenId);
  discarded.sort(byBookThenTimeThenId);
  return { kept, discarded };
}
