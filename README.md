# pi extensions

Extensions and tools for [pi](https://github.com/earendil-works/pi), the terminal-based coding agent.

## Extensions

| Package | Description |
|---------|-------------|
| [pi-ghost](pi-ghost) | Ephemeral btw and side conversation overlay — open a temporary ghost session inside the current pi UI |
| [brepl-balance](brepl-balance) | Runs `brepl balance` after Pi writes or edits Clojure files and reports failures to the agent |
| [pi-heartbeat](pi-heartbeat) | Prompts the current agent after a period of continuous idle time |
| [reload](reload) | Gives agents a tool that reloads Pi extensions and other runtime resources |
| [pi-link-control](pi-link-control) | Lets agents connect to, rename on, and disconnect from Pi Link |
| [pi-openai-fast](pi-openai-fast) | Enables OpenAI Codex Fast mode for eligible ChatGPT-auth models |
| [pi-cliproxy](pi-cliproxy) | Registers the models served by a CLIProxyAPI instance as their own provider |
| [pi-subq](pi-subq) | SubQ Snap text and image decisions through codemode |
| [pi-speak](pi-speak) | Local Kokoro and streaming ElevenLabs v4/v4 Turbo speech, with voice browsing, search, filters, and opt-in previews |
| [pi-nono-sandbox](pi-nono-sandbox) | Diagnoses nono sandbox denials and prepares validated profile drafts |
| [pi-setup-tools-and-skills](pi-setup-tools-and-skills) | Manages project-local tool and skill exclusions from interactive lists |

## Standalone tools

| Tool | Description |
|------|-------------|
| [pi-usage-report](pi-usage-report) | Generates aggregate and per-project tool and skill usage reports from historical Pi sessions |

## Install extensions

```bash
pi install git:github.com/ramblurr/pi-extensions
```

Select extensions with `pi config`. See each package's README for setup and usage.
