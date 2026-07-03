---
name: adversarial-review
description: Run a steerable adversarial Codex CLI code review
---

Run a Codex adversarial review. Pass `$ARGUMENTS` for optional flags and focus text.

Run the following Bash command and show the full output. Do not modify any files.

```bash
PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
node "$PLUGIN_ROOT/scripts/codex-review.mjs" adversarial-review "$ARGUMENTS"
```
