# andoff

A local Pi `/handoff` extension based on Pi's official example.

It generates a handoff prompt, opens it in `$VISUAL` or `$EDITOR`, then starts a new session with the edited prompt already placed in Pi's editor.

## Usage

```text
/handoff <goal for the new thread>
```

Set an external editor before use:

```bash
export VISUAL="nvim"
# or
export EDITOR="vim"
```
