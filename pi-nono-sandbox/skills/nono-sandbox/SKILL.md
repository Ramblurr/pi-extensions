---
name: nono-sandbox
description: Diagnose and resolve nono sandbox denials. Use when a tool, command, file operation, extension, package, or provider request fails with Operation not permitted, Permission denied, EACCES, EPERM, Landlock, or sandbox-denied errors.
license: Apache-2.0
compatibility: Requires Pi running under nono on Linux or macOS.
---

# Working inside nono

nono enforces filesystem and network capabilities outside Pi. Pi approvals, retries, `chmod`, `chown`, `sudo`, and macOS privacy settings cannot expand the sandbox.

## Diagnose

1. Identify the concrete blocked path or network action from the failed operation.
2. Query the current sandbox:

   ```bash
   nono why --self --path /blocked/path --op read
   ```

3. Use `--op write` for write-only access and `--op readwrite` when both are required.
4. Inspect `$NONO_CAP_FILE` when more context is needed.

Diagnosis is complete when the denied operation and minimum required capability are known.

## Offer exactly two remedies

### A. One-off restart

Use `--read` for read-only access or `--allow` for read/write access:

```bash
nono run --profile pi --read /path/to/needed -- pi
nono run --profile pi --allow /path/to/needed -- pi
```

### B. Validated profile draft

Write a minimal delta under `~/.config/nono/profile-drafts/<name>.json`:

```json
{
  "extends": "pi",
  "meta": { "name": "pi-extra" },
  "filesystem": {
    "read": ["/path/to/needed"]
  }
}
```

Validate it:

```bash
nono profile validate --draft <name>
```

Do not promote the draft. Report:

- the draft path;
- whether validation passed;
- each requested capability and why it is needed.

The declarative source of truth is `~/nixcfg/modules/dev/llms/nono.nix`. Integrate the validated delta there only when the user requests it, then deploy through Nix. Remove the obsolete draft after the deployed profile includes the capability.

## Guardrails

- Ask for the narrowest capability that makes the operation work.
- Keep active profiles under `~/.config/nono/profiles` unchanged; Home Manager owns them.
- Keep registry-managed files under `~/.config/nono/packages` unchanged.
- Do not bypass a denial through another path or suggest Unix permission changes.
