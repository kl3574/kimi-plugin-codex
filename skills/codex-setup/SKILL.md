---
name: codex-setup
description: Check that the Codex CLI is installed and authenticated
---

# Codex Setup

Use this skill when the user wants to verify Codex CLI readiness.

## Steps

1. Run the helper script:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
   node "$PLUGIN_ROOT/scripts/codex-review.mjs" setup
   ```
2. Report the result to the user, including any missing CLI or authentication issues.

## Output

The setup command prints a status line for each check (e.g., CLI found, authenticated) or a clear error describing what is missing.
