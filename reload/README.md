# pi-reload

A Pi extension that gives agents a `reload_runtime` tool. The tool waits for the current turn to finish, executes `/reload` through Pi's interactive command path, and resumes the agent after reload succeeds.

Use it after changing Pi extensions, skills, prompts, themes, keybindings, or context files.

## Install

Add the local package to Pi:

```bash
pi install /absolute/path/to/pi-extensions/reload
```

Then run:

```text
/reload
```

The tool requires Pi's interactive mode because it dispatches the built-in `/reload` command through the editor.

## Local development

```bash
pi -e /absolute/path/to/pi-extensions/reload/index.ts
```
