// Hand-rolled flag scanning: the repo has zero runtime dependencies and
// compiles to a single binary, so flags get helpers rather than a parser
// dependency. Ported from focusmux.

export interface FlagScan {
  values: string[]; // one entry per occurrence, in order
  missing: boolean; // the flag appeared as the last token, with no value
}

export function scanFlag(args: string[], flag: string): FlagScan {
  const values: string[] = [];
  let missing = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value === undefined) {
      missing = true;
      continue;
    }
    values.push(value);
    i++; // the value is consumed, so `--tag --tag` cannot self-match
  }
  return { values, missing };
}

// flagValues returns every occurrence's value (`--tag a --tag b` → [a, b]).
export function flagValues(args: string[], flag: string): string[] {
  return scanFlag(args, flag).values;
}

// flagValue returns the last occurrence's value, or undefined.
export function flagValue(args: string[], flag: string): string | undefined {
  const values = flagValues(args, flag);
  return values.at(-1);
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// positionals returns the non-flag arguments, skipping each value-taking flag
// together with the value that follows it.
export function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      i++; // skip its value, even if the value itself looks like a flag
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

// unknownFlags names any flag-looking token that is not in the command's
// vocabulary, so a typo is a usage error rather than a silent no-op.
export function unknownFlags(
  args: string[],
  valueFlags: string[] = [],
  boolFlags: string[] = [],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      i++;
      continue;
    }
    if (boolFlags.includes(arg)) continue;
    if (arg.startsWith("-")) out.push(arg);
  }
  return out;
}

// checkFlags — the usage checks a command with a fixed vocabulary shares: no
// unknown flag, every value flag has its value, no stray positional. Returns
// EXIT_USAGE having said why, or null when the arguments are clean.
export function checkFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
  what: string,
): number | null {
  const unknown = unknownFlags(args, valueFlags, boolFlags);
  if (unknown.length > 0) return usage(`unknown flag for ${what}: ${unknown[0]}`);
  for (const flag of valueFlags) {
    if (scanFlag(args, flag).missing) return usage(`${flag} requires a value`);
  }
  const stray = positionals(args, valueFlags);
  if (stray.length > 0) return usage(`${what} takes no positional arguments: ${stray[0]}`);
  return null;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

// usage reports a malformed invocation and returns the exit code for one, so
// callers can `return usage(...)`.
export function usage(message: string): number {
  console.error(`kindle-sync: ${message}`);
  return EXIT_USAGE;
}

// failure reports a runtime error (the command was well-formed but could not
// be carried out) and returns its exit code.
export function failure(message: string): number {
  console.error(`kindle-sync: ${message}`);
  return EXIT_FAILURE;
}
