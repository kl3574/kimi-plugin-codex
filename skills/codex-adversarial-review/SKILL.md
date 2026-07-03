---
name: codex-adversarial-review
description: Run a skeptical adversarial Codex CLI code review from inside Kimi Code
---

# Codex Adversarial Review

Use this skill when the user wants a challenging, skeptical Codex review of their current work.

## Steps

1. Determine what the user wants to review:
   - Uncommitted changes (default)
   - A branch compared to a base ref (e.g., `main`)
   - Optionally, a focus area such as `security` or `error handling`
2. Build the helper command with the appropriate flags:
   ```bash
   PLUGIN_ROOT="${KIMI_PLUGIN_ROOT:-${KIMI_CODE_HOME:-$HOME/.kimi-code}/plugins/managed/kimi-plugin-codex}"
   node "$PLUGIN_ROOT/scripts/codex-review.mjs" adversarial-review <FLAGS>
   ```
   Examples:
   - `node "$PLUGIN_ROOT/scripts/codex-review.mjs" adversarial-review`
   - `node "$PLUGIN_ROOT/scripts/codex-review.mjs" adversarial-review --base main`
   - `node "$PLUGIN_ROOT/scripts/codex-review.mjs" adversarial-review --focus "challenge error handling"`
3. Run the command and show the full output. Do not modify any files.
4. Present the findings to the user, preserving severity headings.
5. Do not apply any fixes unless the user explicitly asks in a separate step.

## Output

Codex returns a markdown report with Critical / Important / Minor findings and an overall verdict.
