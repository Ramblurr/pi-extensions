# pi-speak

Local text-to-speech for Pi.

## Install

```bash
pi install ssh://git@github.com/s1m0n38/pi-speak
```

## Usage

The extension registers:

- `speak` tool that the agent can use to synthesize speech locally via Kokoro;
- `/speak` for voice, speed, and model settings;
- `Ctrl+Alt+X` to speak the last agent message.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-speak
```

While iterating on setup, enable the debug-only onboarding command when starting Pi:

```bash
PI_SPEAK_DEBUG=1 pi -e /absolute/path/to/pi-speak
```

Then run `/speak-onboarding` to replay the complete onboarding flow. The command is not registered unless `PI_SPEAK_DEBUG=1`.

## Development

```bash
npm run check   # tsc --noEmit
npm test        # check + node scripts/run-tests.mjs
```
