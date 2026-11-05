# pi-speak

Local Kokoro text-to-speech for Pi. Fork imported from
[S1M0N38/pi-speak](https://github.com/S1M0N38/pi-speak) at commit
`6d2322e` (MIT; original license retained).

## Try the local fork without installing globally

From this directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e ./src/index.ts --name pi-speak-local-test
```

This loads only this extension for that invocation. It does not change Nix or
Pi's installed-package settings. The monorepo's root extension manifest does
not include pi-speak yet.

1. Run `/speak` and approve the Kokoro download (291 MiB).
2. Leave preprocessing off for local-only speech generation.
3. Ask Pi: `Use speak to say: Hello from Kokoro.`
4. Use `/speak` to change voice or speed. Use Ctrl+Alt+X to read the latest
   assistant message.

Settings persist in `<Pi agent directory>/pi-speak.json`. Default voice:
`af_heart`; speed: `1`. Model files are cached locally. The upstream loader
currently loads by Hugging Face repository rather than the pinned onboarding
path, so the first synthesis can download additional files, including another
model copy. Do not assume onboarding alone makes synthesis offline-ready.

Linux playback searches PATH for `pw-play`, `paplay`, then `aplay`, including
NixOS profiles. macOS uses `afplay`. Playback uses the default audio device.

Optional preprocessing summarizes the latest message with a configured Pi LLM
before reading it; this may send text to a remote provider. It does not apply
to explicit `speak` tool calls. ElevenLabs and OpenAI speech are not implemented.

## Development

```sh
pnpm run check
pnpm test
```

Dependency lifecycle scripts remain disabled. `@huggingface/transformers` is
an explicit dependency because the backend imports it directly.

To replay onboarding, start with `PI_SPEAK_DEBUG=1` and run `/speak-onboarding`.
