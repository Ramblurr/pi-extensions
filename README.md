# pi extensions

Extensions and tools for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent.

## Extensions

| Package | Description |
|---------|-------------|
| [pi-ghost](pi-ghost) | Ephemeral btw and side conversation overlay — open a temporary ghost session inside the current pi UI |
| [handoff](handoff) | `/handoff` context transfer that opens `$VISUAL`/`$EDITOR` before drafting the new-session prompt |
| [fork-new](fork-new) | `/fork-new` creates a real fork and opens it in a new Ghostty window |
| [brepl-balance](brepl-balance) | Runs `brepl balance` after Pi writes or edits Clojure files and reports failures to the agent |

## Standalone tools

| Tool | Description |
|------|-------------|
| [pi-usage-report](pi-usage-report) | Generates aggregate and per-project tool and skill usage reports from historical Pi sessions |

## Install extensions

```bash
pi install npm:@ramblurr/<package-name>
```

See each package's README for setup and usage.
