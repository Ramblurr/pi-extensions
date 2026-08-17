# pi-heartbeat

A Pi extension that prompts the current agent after a configured period of continuous idle time. Agent activity resets the interval, so a heartbeat never interrupts an active turn or queues missed ticks.

## Commands

```text
/heartbeat <SECONDS> <PROMPT>
/heartbeat
/heartbeat stop
```

Starting a heartbeat replaces the existing one. `SECONDS` must be a positive whole number that fits Pi's safe timer range (up to 2,147,483 seconds), and the prompt must not be empty. The prompt is submitted as a native user message after one complete idle interval.

`/heartbeat` reports whether the heartbeat is active and prints usage without showing the prompt. While active, the footer shows only `♥ <SECONDS>s`. `/heartbeat stop` is safe to repeat.

Heartbeat state is stored in the current Pi session, so reload and resume restore the active or stopped state. A new session starts stopped. A restored active heartbeat always begins a fresh interval.

## Install

### Local checkout

```bash
pi install ./pi-heartbeat
```

### npm package

```bash
pi install npm:@ramblurr/pi-heartbeat
```

Then reload Pi:

```text
/reload
```

## Local development

```bash
pi -e /absolute/path/to/pi-extensions/pi-heartbeat/index.ts
```

## Test

```bash
bun test test/index.test.ts
```
