---
name: doctor
description: Diagnose Codex CLI readiness, network, and runtime
---

Run a diagnostic check for the Codex plugin. Pass `--probe-runtime` to also send a minimal prompt to the external CLI and verify it can reach the API.

Run the following Bash command and show the full output. Do not modify any files.

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
SCRIPT="$PLUGIN_ROOT/scripts/codex-review.mjs"
if [ ! -f "$SCRIPT" ]; then
  echo "❌ Plugin script not found at $SCRIPT. Is kimi-plugin-codex installed?" >&2
  exit 1
fi
node "$SCRIPT" doctor "$ARGUMENTS"
```
