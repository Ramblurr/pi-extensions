# pi-speak

Speech for Pi with local Kokoro and ElevenLabs v4/v4 Turbo.
Fork imported from [S1M0N38/pi-speak](https://github.com/S1M0N38/pi-speak)
at `6d2322e` (MIT; original license retained).

## Try without installing globally

From this directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e ./src/index.ts --name pi-speak-test
```

This loads the extension for that invocation without changing Nix or Pi's
installed-package settings. The monorepo root manifest does not enable it.

Run `/speak`, choose a provider, and configure its voice. Then ask Pi:
`Use speak to say: Hello.`

- **Ctrl+Alt+X:** read the latest assistant message.
- **`/speak-stop`:** stop current speech and clear queued utterances.
- **`speech_options` tool:** inspect controls/defaults; search voices with
  `query` (empty string lists voices), then continue with `nextPage`.

Speech plays in order. The `speak` tool completes when playback finishes and
reports errors rather than silently dropping failed audio.

## Configure a provider

### Kokoro

Choose **Kokoro (local)** in `/speak` and approve the model download (291 MiB).
Default voice is `af_heart`; speed is `1` (range 0.5–3). Use the settings menu
or per-call `voice` and `speed` overrides.

Kokoro generates a complete WAV before playback. Model files are cached
locally. The inherited loader still loads by Hugging Face repository rather
than the pinned onboarding path, so first synthesis can download additional
files, including another model copy. Onboarding alone does not guarantee
offline readiness.

### ElevenLabs

Choose **ElevenLabs (cloud)** in `/speak`, accept the transmission/quota notice,
and configure an API key source and voice. Choose `eleven_v4` for quality or
`eleven_v4_turbo` for lower latency. Stability and similarity range from 0 to 1.

The key source uses Pi's config-value syntax:

- `$ELEVENLABS_API_KEY` (default), or another environment reference.
- `!op read 'op://vault/item/field'` for a 1Password reference.
- `!cat /path/to/key` for a file-backed credential.

Only the reference is stored, not the resolved key. Literal keys are not
accepted in this extension's settings. Commands are trusted personal
configuration, never agent-supplied tool parameters. The resolver is copied
from Pi: environment templates and escapes work the same way, and command
successes/failures are cached for the process lifetime. Commands have Pi's
10-second synchronous timeout; cancellation takes effect after lookup returns.
Start a fresh Pi session or reload after fixing a cached command failure.

The API key needs text-to-speech access. Account voice search additionally
needs Voices read access. Manual voice-ID entry works without voice search.

Example tool input:

```json
{
  "text": "[confident] Here is the result. [chuckles] That was quick.",
  "stability": 0.5,
  "similarity": 0.75
}
```

Audio tags use single square brackets; adherence varies by voice/model.
ElevenLabs audio streams directly to the player as 24 kHz mono PCM. No full
utterance download or temporary WAV is required before playback begins.
Requests are not automatically retried because generation can consume quota.

### Settings and privacy

Settings live in `<Pi agent directory>/pi-speak.json`. Existing version-1
Kokoro settings are read as version 2 and saved in that form on the next
settings change. Each provider keeps its own defaults when switching.

Only the selected provider's parameters and short guidance reach the agent.
The agent can override supported delivery controls, not select a different
provider. Tool output excludes the API key source and resolved credentials.

Optional **Preprocessing LLM** summarizes the latest assistant message before
the keyboard shortcut reads it. It is off by default and does not apply to
explicit `speak` calls. A cloud preprocessing LLM sends the message to that
provider even when synthesis uses local Kokoro.

## Audio players

Linux searches PATH for `pw-play`, `paplay`, then `aplay`, including NixOS
profiles. Playback uses the default audio device. On macOS, buffered audio
uses `afplay`; streaming PCM requires `ffplay` on PATH. Missing players and
playback failures are reported. Windows playback is not supported.

## Development

```sh
pnpm run check
pnpm test
```

Tests use Node's test runner and include provider requests, streaming,
playback, cancellation, credentials, configuration and tool registration.
Dependency lifecycle scripts stay disabled. ElevenLabs uses native `fetch`,
not an SDK. Local inference dependencies load only when Kokoro synthesizes.

`src/speech-provider.ts` defines buffered/streaming audio and the provider
interface. `src/provider-descriptions.ts` owns active tool schemas/guidance.
`src/elevenlabs.ts` handles HTTP speech and voice discovery. `src/playback.ts`
and `src/speech-queue.ts` own output and complete-job ordering/cancellation.

The vendored Pi config resolver has provenance and its MIT license under
`src/vendor/`. OpenAI, automatic speak-as-text-arrives, and incremental text
input are not implemented.
