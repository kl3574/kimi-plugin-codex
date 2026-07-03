---
name: codex-doctor
description: Diagnose Codex CLI readiness, network, and runtime
---

# Codex Doctor

Use this skill when the user wants to diagnose why the Codex plugin is not working.

## Steps

1. Run the helper script with any provided arguments:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
   node "$PLUGIN_ROOT/scripts/codex-review.mjs" doctor "$ARGUMENTS"
   ```
2. Show the full output. Do not modify any files.
3. Explain any `[FAIL]` lines and suggest the next fix (install CLI, log in, fix proxy, etc.).

## Output

The doctor command prints `[OK]` / `[FAIL]` lines for plugin-local checks, external CLI checks, network/proxy checks, and optional runtime probes.
