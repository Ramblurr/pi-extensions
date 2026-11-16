# pi-cliproxy

A Pi extension that registers the models served by a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance under their own `cliproxy` provider.

The provider sits next to Pi's built-in ones. Pick `cliproxy/<model>` in `/model` to route through the proxy, and pick an `openai-codex/...` or `anthropic/...` model to go back to a direct subscription or API key.

## Configure

Add the endpoint and a proxy client key to Pi's `models.json`:

```json
{
  "providers": {
    "cliproxy": {
      "baseUrl": "http://localhost:8317",
      "apiKey": "$CLIPROXY_API_KEY"
    }
  }
}
```

`baseUrl` is the proxy root, with or without `/v1`. `apiKey` is one of the proxy's `api-keys` and accepts the usual `models.json` forms: a literal, `$ENV_VAR`, or `!command`.

Without this entry the provider registers no models.

## Models

Pi asks the proxy for its model list in the background after an interactive or RPC session starts, and remembers the result for the next start. Print mode and `pi --list-models` use the remembered list, so start Pi interactively once after installing.

The proxy reports model ids only. Context windows, output limits, and thinking levels come from Pi's built-in `anthropic`, `openai` and `meta` catalogs, and ids Pi does not know are left out. Claude models use the Anthropic Messages API and the rest use the OpenAI Responses API.

Costs are reported as zero because requests are billed to the subscriptions behind the proxy.

## Install

```bash
pi install /absolute/path/to/pi-extensions/pi-cliproxy
```

## Local development

```bash
pi -e /absolute/path/to/pi-extensions/pi-cliproxy/index.ts
```
