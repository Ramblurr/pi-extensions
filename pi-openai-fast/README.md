# openai-fast

A pi extension that enables OpenAI Codex Fast mode for supported ChatGPT-auth GPT models (listed below).

When active, the extension injects this into eligible OpenAI Codex request payloads:

```json
{
  "service_tier": "priority"
}
```

The user-facing feature is OpenAI Codex **Fast mode**. The extension retains the wire value `priority`; OpenAI's [Fast mode guide](https://developers.openai.com/api/docs/guides/priority-processing) documents `priority` and `fast` as equivalent for supported models.

OpenAI's [Codex speed guide](https://developers.openai.com/codex/speed) confirms GPT-6 Astra Fast mode with ChatGPT sign-in where available, at 2.5× Standard credit consumption.

## Eligibility

Fast mode is only injected when all of these are true:

- The current provider is `openai-codex`.
- The current API is `openai-codex-responses`.
- The current model is `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, or `gpt-6.1-terra`.
- The provider is using ChatGPT OAuth/subscription auth, not API-key auth.
- The request payload does not already include `service_tier`.

The GPT-6 Sol/Luna and GPT-6.1 Sol/Terra additions are verified against OpenAI's [Codex model catalog](https://github.com/openai/codex/blob/f752c97f7d0be0cbef5cece327f52a16ad6fb1c6/codex-rs/models-manager/models.json), which advertises `priority` as their Fast tier. Daybreak Blue/Red advertise no Fast tier and remain excluded.

## Commands

```text
/fast
```

Run `/fast` to toggle Fast mode on or off for the current session/runtime. The command reports the new state in chat, and the footer shows `⚡` while Fast mode is active for an eligible model.

The extension defaults to off for new sessions; set `"enabled": true` in the config file or run `/fast` to turn it on.

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
  "enabled": true,
  "showStatus": true
}
```

- `enabled`: default Fast-mode state when there is no session override (defaults to `false`).
- `showStatus`: show a compact `⚡` status when Fast mode is active for the current model.

## Install

### Local checkout

```bash
pi install ./pi-openai-fast
```

### Git

[Install from Git](../README.md#install-extensions).

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
