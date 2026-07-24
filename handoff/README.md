# andoff

A local Pi `/handoff` extension based on Pi's official example.

It generates a handoff prompt, opens it in `$VISUAL` or `$EDITOR`, then starts a new session with the edited prompt already placed in Pi's editor.

When the current session has a saved pi-link name, `/handoff` carries that name and the session's connection intent into the replacement session.

pi-link then establishes a fresh connection; sockets, hub/client role, peers, and pending link work are not transferred, and pi-link itself is unchanged.

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
