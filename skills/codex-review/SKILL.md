---
name: codex-review
description: Run a read-only Codex CLI code review on the current git changes from inside Kimi Code
---

# Codex Review

Use this skill when the user wants an independent Codex CLI review of their current work.

## Steps

1. Determine whether the user wants to review:
   - Uncommitted changes (default)
   - A branch compared to a base ref (e.g., `main`)
2. Run the helper script:
   ```bash
   node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-codex/scripts/codex-review.mjs review
   ```
   or with a base ref:
   ```bash
   node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-codex/scripts/codex-review.mjs review --base main
   ```
3. Present Codex's findings to the user.
4. Do not apply any fixes unless the user explicitly asks in a separate step.
