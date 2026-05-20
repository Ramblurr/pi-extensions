# fork-new

Pi extension that adds `/fork-new`.

It behaves like `/fork` but opens the fork in a new Ghostty window instead of replacing the current Pi session:

1. choose the user message to fork from
2. a new session JSONL is created from the branch before that message
3. Ghostty opens a new window and runs a temporary launcher script
4. the new Pi resumes the forked session with the selected prompt restored in the editor

The original session is not switched or modified.

## Usage

```text
/fork-new
```

## Requirements

- `ghostty` on `PATH`
- `pi` on `PATH`
- interactive Pi with persisted sessions enabled

For debugging, override executables with:

```bash
PI_FORK_NEW_GHOSTTY=/path/to/ghostty PI_FORK_NEW_PI=/path/to/pi pi
```
