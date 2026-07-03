# Kimi Plugin Codex

A Kimi Code plugin that delegates read-only code review to the local OpenAI Codex CLI.

## Install

From a local path:

```text
/plugins install /home/lkx/kimi-plugin-codex
/reload
```

From GitHub:

```text
/plugins install https://github.com/kl3574/kimi-plugin-codex
/reload
```

## Usage

```text
/kimi-plugin-codex:setup
/kimi-plugin-codex:review
/kimi-plugin-codex:review --base main
/kimi-plugin-codex:adversarial-review --base main challenge the error handling
```

Or use skills directly:

```text
Use the skill codex-review
Use the skill codex-adversarial-review with base main
```

## How It Works

The plugin wraps `codex review --uncommitted` / `codex review --base <branch>` and passes an optional adversarial focus as the review prompt. Codex returns its findings directly.

## Verification

- Plugin manifest: valid JSON, `skills` and `commands` paths present.
- Helper script: tested with `setup`, `review`, `adversarial-review`, and `--base <ref>`.
- Normal review uses `codex review --uncommitted` / `--base <ref>`.
- Adversarial review pipes the diff into `codex exec -s read-only --ignore-user-config --ephemeral` with an adversarial prompt.
- Review is read-only; sandbox is set to `read-only` for `exec` paths.
- Smoke test in `/tmp/review-test` caught the intentional `add` → `a-b` bug.
- Boundary tests passed:
  - Non-git directory → clear error, exit 1.
  - Empty diff → "No changes to review.", exit 0.
  - Invalid base ref → clear git error, exit 1.

## Limitations

- Requires a local git repository.
- Requires `codex` on PATH and authenticated.
- `codex review` does not accept a custom prompt in this Codex CLI version, so adversarial mode uses `codex exec` instead.
- Skills and commands reference the helper script by absolute path `/home/lkx/.kimi-code/plugins/managed/kimi-plugin-codex/scripts/codex-review.mjs`.
- This is a v0.1 local prototype.
