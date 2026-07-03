---
name: codex-setup
description: Verify that Codex CLI is installed and authenticated before running Codex reviews from Kimi Code
---

# Codex Setup

Run the setup check and report the result to the user.

```bash
node /home/lkx/.kimi-code/plugins/managed/kimi-plugin-codex/scripts/codex-review.mjs setup
```

If it fails, guide the user to install Codex CLI from https://github.com/openai/codex and run `codex login`.
