# Pi usage report

Generate aggregate and per-project tool and skill usage statistics from historical Pi JSONL session files. This is a standalone local script, not a Pi extension.

Inspired by [`@mammothb/pi-stats`](https://github.com/mammothb/pi-extensions/tree/master/packages/pi-stats), but designed to backfill existing sessions and export analysis-friendly files.

## Run

```bash
cd pi-usage-report
bun run report
```

`pnpm report` also works if you prefer pnpm; the package script invokes Bun.

Defaults:

- Pi agent directory: `$PI_CODING_AGENT_DIR`, or `$XDG_CONFIG_HOME/pi/agent`, or `~/.config/pi/agent`
- Output directory: `./output`
- Cache directory: `$XDG_CACHE_HOME/pi-usage-report`, or `~/.cache/pi-usage-report`

Override either path:

```bash
bun run report.js \
  --agent-dir ~/.config/pi/agent \
  --output ./output
```

Control incremental caching with either of these flags:

```bash
bun run report.js --no-cache       # read every session; leave the cache untouched
bun run report.js --rebuild-cache  # read every session; atomically replace the cache
```

The flags are mutually exclusive.

The parser streams JSONL files one at a time. It retains event metadata while building the report, so memory scales with invocation count rather than the source corpus's byte size.

## Incremental cache

The reporter keeps one source-specific cache file under `$XDG_CACHE_HOME/pi-usage-report/`, falling back to `~/.cache/pi-usage-report/` when `XDG_CACHE_HOME` is unset. It caches each session file's header metadata and extracted event records. Global ancestry ordering and fork deduplication still run across all cached and newly parsed records on every invocation.

A cache entry remains valid only while its absolute source path, file size, and nanosecond-resolution modification time match. The cache file also carries explicit schema and parser versions. The reporter reuses matching entries, parses new or changed session files, and drops deleted files. A missing, malformed, partial, or incompatible cache causes a normal cache miss; report generation continues and replaces the cache atomically when possible.

The cache contains local paths, session IDs, timestamps, tool names, skill names, deduplication keys, and success/error metadata. It never contains prompt, assistant response, tool-result, or skill bodies. Newly created cache directories use mode `0700`, and cache files use mode `0600`. Treat the cache as private local metadata.

## Output

| File | Contents |
|---|---|
| `output/report.md` | Aggregate summary and a section for every project |
| `output/aggregate-tools.csv` | Tool totals across all projects |
| `output/aggregate-skills.csv` | Skill totals split by agent reads and user commands |
| `output/project-tools.csv` | Tool totals per project |
| `output/project-skills.csv` | Skill totals per project |
| `output/projects.csv` | Session, tool, skill, and date totals per project |
| `output/daily-usage.csv` | Daily usage by project, event type, name, and source |
| `output/usage-events.csv` | Deduplicated event-level data |

Generated output is ignored by Git because it contains local project paths.
A hidden `.pi-usage-report` marker identifies directories owned by this tool; non-empty unmarked output directories are never replaced.
A hidden source fingerprint records which session snapshot produced the output. When that fingerprint still matches and the complete owned output bundle exists, the reporter leaves every output file untouched and prints `Up to date`.

## Counting rules

- A tool use is an assistant `toolCall` block. Tool-result messages are not counted again.
- An agent-loaded skill is a successful `read` call ending in `skills/<name>/SKILL.md` or a direct root skill such as `skills/<name>.md`. Failed and unfinished skill reads are excluded from skill totals but remain in tool totals.
- A user-invoked skill is a canonical expanded message beginning with `<skill name="…" location="…">` and containing its closing tag. XML examples inside ordinary prompts or skill bodies are ignored.
- Successfully reading a skill file counts once as a `read` tool call and once as a skill use.
- A project is the exact `cwd` in the session header. Worktrees and subdirectories remain separate.
- Entries copied into forks and clones are deduplicated and assigned to their earliest session copy.
- Prompt, response, tool-result, and skill bodies are never exported or cached.
- CSV text that could be interpreted as a spreadsheet formula is prefixed with an apostrophe.
- Each run stages a complete bundle before replacing a previous marker-owned output directory.

## Test

```bash
bun test
```
