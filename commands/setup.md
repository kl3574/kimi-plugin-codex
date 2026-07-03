---
name: setup
description: Check Codex CLI installation and authentication
---

Run the following Bash command and report the result:

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
node "$PLUGIN_ROOT/scripts/codex-review.mjs" setup
```
