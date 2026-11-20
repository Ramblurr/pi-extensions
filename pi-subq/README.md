# pi-subq

SubQ Snap text and image decisions through Pi's codemode `models.classify()`.
Registers `subq/subq-snap-1.2` as a classifier, not a chat model. Tested with Pi 1.4.0.
It does not register the early-access `subq-preview` chat model.

## Load and authenticate

Add this directory to Pi's `packages` setting, or try it for one invocation:

```sh
pi -e /path/to/pi-extensions/pi-subq/index.ts
```

Run `/login` and select **SubQ**, set `SUBQ_API_KEY`, or merge a command-based
credential into your agent directory's `models.json`:

```json
{
  "providers": {
    "subq": {
      "apiKey": "!op read 'op://VAULT/ITEM/FIELD'"
    }
  }
}
```

Use your actual secret reference. A saved `/login` credential takes precedence
over `models.json`; `/logout` removes it. Command credentials resolve at request
time. Never put an actual key in the extension or a tracked configuration file.

Enable codemode in Pi settings if it is not already enabled:

```json
{ "defaultTools": ["+codemode"] }
```

## Classify with codemode

```js
const snap = await models.getModelOfType("classifier", "subq", "subq-snap-1.2");
const result = await models.classify(snap, {
  state: { message: "Thanks, that fixed it!" },
  questions: {
    resolved: {
      type: "bool",
      instructions: "Is the user's problem resolved?",
      criteria: { true: "Resolved", false: "Still needs help" }
    }
  }
});
if (result.stopReason !== "stop") throw new Error(result.errorMessage);
return result.answers;
```

For images, add `images: [await tools.read({ path: "photo.png" })]` to the
classification context. PNG, JPEG, and WebP are supported: at most four images,
4 MiB decoded per image, 8 MiB combined. The context window is 393,216 tokens.
The configured price is $0.04 per million input tokens; output is free.
SubQ is in preview; check its [current documentation](https://docs.subq.ai/using-the-api/models/).

The adapter reuses Pi's System One transport for question/answer conversion,
usage accounting, retries, hooks, and cancellation. It changes only the image
payload to SubQ's `{ mediaType, base64 }` format. It uses supported provider
exports rather than locating JavaScript files inside Pi's installation.

## Development

```sh
pnpm install --ignore-scripts
pnpm test
pnpm typecheck
```

Tests exercise Pi's real transport and credential resolution with an intercepted
HTTP boundary. They do not use live credentials or spend API credits.

References: [SubQ Decisions API](https://docs.subq.ai/markdown/endpoints/decisions-api.md),
[pi-fabric auth example](https://github.com/fabric-runtime/pi-fabric/blob/40abebd3d5b0a641b20a07be61c13659ea7cda3b/src/jev/auth.ts),
[joelazar classifier example](https://github.com/joelazar/pi-extensions/blob/4445ceeb44d197442cbd30ec2ab0c2f6f699658d/extensions/subq/index.ts).
