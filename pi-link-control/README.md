# pi-link-control

> **This extension has been replaced by our Pi Link patch.** Pi Link now connects and disconnects directly, so this extension no longer needs to send slash commands through the editor.

A Pi extension that gives agents a `link_control` tool for controlling their own [Pi Link](https://github.com/alvivar/pi-link) connection.

The tool supports two actions:

- `connect` requires a `name`, sets that link name, and connects to the hub. Calling it while connected renames the terminal and reconnects when needed.
- `disconnect` disconnects from the hub.

The extension dispatches Pi Link's slash commands through Pi's interactive command path. It does not inject slash commands as user messages.

## Requirements

- Pi
- Pi Link, with `/link-name`, `/link-connect`, and `/link-disconnect` available
- Interactive mode

## Install

Add Pi Link and this local package to Pi, then reload:

```bash
pi install /absolute/path/to/pi-extensions/pi-link-control
```

```text
/reload
```

## Local development

```bash
pi -e /absolute/path/to/pi-extensions/pi-link-control/index.ts
```
