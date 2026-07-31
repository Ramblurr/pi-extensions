# openai-fast

A pi extension that enables OpenAI Codex Fast mode for ChatGPT-auth GPT-5.4, GPT-5.5, and GPT-5.6 Codex variants (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`).

When active, the extension injects this into eligible OpenAI Codex request payloads:

```json
{
  "service_tier": "priority"
}
```

The user-facing feature is OpenAI Codex **Fast mode**. The wire value is `priority` because current Codex clients map Fast mode to the OpenAI priority service tier.

## Eligibility

Fast mode is only injected when all of these are true:

- The current provider is `openai-codex`.
- The current API is `openai-codex-responses`.
- The current model is `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`.
- The provider is using ChatGPT OAuth/subscription auth, not API-key auth.
- The request payload does not already include `service_tier`.

## Commands

```text
/fast
```

Run `/fast` to toggle Fast mode on or off for the current session/runtime. The command reports the new state in chat, and the footer shows `⚡` while Fast mode is active for an eligible model.

The extension defaults to off so installing the full collection does not accidentally spend Fast-mode credits.

### CLI flag

Pass `--fast` to start with Fast mode enabled:

```bash
pi --no-session --provider openai-codex --model gpt-5.6-luna --thinking high --fast
```

The usual eligibility checks still apply. `/fast` can toggle the mode off again during an interactive run.

## Config

Optional global config:

```text
~/<pi-config-dir>/agent/extensions/openai-fast.json
```

Optional project config:

```text
<project>/<pi-config-dir>/openai-fast.json
```

Here `<pi-config-dir>` is Pi's runtime config directory name (`CONFIG_DIR_NAME`; `.pi` by default). Project config overrides global config after Pi reports that the project is trusted.

```json
{
  "enabled": false,
  "showStatus": true
}
```

- `enabled`: default Fast-mode state when there is no session override.
- `showStatus`: show a compact `⚡` status when Fast mode is active for the current model.

## Install

### Local checkout

```bash
pi install ./pi-openai-fast
```

### npm package

```bash
pi install npm:@ramblurr/pi-openai-fast
```

Then reload pi:

```text
/reload
```

## Notes

- This extension intentionally does not affect API-key OpenAI models.
- Pi may only account Fast-mode cost correctly when the backend reports `service_tier: "priority"` in the streamed response. The extension does not patch usage totals to avoid double-counting.
- If pi adds first-class service-tier support later, this extension skips payloads that already contain `service_tier`.

## Attribution

Ported from [`@diegopetrucci/pi-openai-fast`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast).
