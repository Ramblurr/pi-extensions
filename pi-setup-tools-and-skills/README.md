# Setup Tools and Skills for Pi

Choose which Pi tools and skills a project excludes from two interactive lists.

## Commands

```text
/tools
/skills
```

Controls:

- `↑` / `↓`: navigate
- `Enter` / `Space`: toggle inclusion
- Type to search
- `Ctrl+S`: save
- `Esc` or `q`: cancel

Both commands write only to `<project>/.pi/settings.json`:

```json
{
  "resourceExclusions": {
    "skills": ["sub-agents"],
    "tools": ["bash"]
  }
}
```

Tool exclusions take effect immediately, remain enforced when extensions refresh their tools, and block stale calls defensively. Skill exclusions remove matching skills from the agent's available-skills prompt and block explicit `/skill:<name>` expansion. Names that are not currently installed are preserved when either list is saved.

Pi must trust the project before this extension reads or writes project settings.

## Install

From this checkout:

```bash
pi install ./pi-setup-tools-and-skills
```

Then reload Pi:

```text
/reload
```

## Development

```bash
pi -e /absolute/path/to/pi-extensions/pi-setup-tools-and-skills/index.ts
bun test pi-setup-tools-and-skills/test/index.test.ts
```

## Acknowledgements

The interactive selector is adapted from Firstpick's MIT-licensed [`pi-extension-setup-skills`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-setup-skills).
