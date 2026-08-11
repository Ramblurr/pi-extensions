# pi-nono-sandbox

A Pi extension and skill for diagnosing nono sandbox denials. It adds `/nono-status`, recognizes likely sandbox errors, and guides agents toward one-off grants or validated profile drafts.

Profile drafts are proposals only. Do not promote them: integrate accepted changes into `~/nixcfg/modules/dev/llms/nono.nix` and deploy through Nix.

## Install

Add the local package to Pi:

```bash
pi install /home/ramblurr/src/github.com/ramblurr/pi-extensions/pi-nono-sandbox
```

Then restart Pi or run `/reload`.

Adapted from the Apache-2.0-licensed `always-further/nono-packs` Pi pack at commit `0817a30923eb633da9f3ac87bdfb085e0ead7724`.
