# brepl-balance

A Pi extension that automatically runs `brepl balance <path>` after successful `write` and `edit` tool calls on Clojure files.

Supported extensions: `.edn`, `.clj`, `.cljc`, `.cljs`, and `.cljd`.

`brepl balance` participates in Pi's per-file mutation queue, so it cannot overwrite a concurrent Pi edit. The command has a 30-second timeout. If it fails or is terminated, the extension appends bounded diagnostics to the tool result and marks it as an error. The agent then sees the failure in its next context and can fix the file.

## Requirements

- [Pi](https://github.com/earendil-works/pi)
- `brepl` available on `PATH`

## Install

```bash
pi install npm:@ramblurr/brepl-balance
```

Then reload Pi:

```text
/reload
```

For local development:

```bash
pi -e /absolute/path/to/pi-extensions/brepl-balance/index.ts
```

## Test

```bash
bun test
```
