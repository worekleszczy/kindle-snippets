# kindle-sync

Kindle snippets sync CLI. Single self-contained binary, no runtime
dependencies.

Technology choices and the reasoning behind them: [tech.md](tech.md).
Repo conventions for contributors and agents: [CLAUDE.md](CLAUDE.md).

## Build & install

```sh
bun install
bun run verify     # typecheck + lint + tests
bun run build      # → ./kindle-sync (self-contained binary)
sudo ./link.sh     # symlink to /usr/local/bin/kindle-sync
```

The binary is architecture-specific and gitignored — each machine builds its
own.

## Usage

```sh
kindle-sync help
kindle-sync version
```

Exit codes: `0` success, `1` runtime failure, `2` usage error.

## Development

| Command | What it does |
| --- | --- |
| `bun test` | Run the colocated `*.test.ts` files |
| `bun run typecheck` | `tsc --noEmit` — Bun does not typecheck on its own |
| `bun run check` | Biome lint + format check |
| `bun run fix` | Biome, applying safe fixes |
| `bun run verify` | All three, in order |
