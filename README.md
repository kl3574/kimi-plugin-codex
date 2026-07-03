# Kimi Plugin Codex

A Kimi Code plugin that delegates read-only code review to the local OpenAI Codex CLI.

## Install

From GitHub (recommended):

```text
/plugins install https://github.com/kl3574/kimi-plugin-codex
/reload
```

Or clone manually into your Kimi Code plugins directory:

```bash
git clone https://github.com/kl3574/kimi-plugin-codex.git ~/.kimi-code/plugins/managed/kimi-plugin-codex
```

Then restart Kimi Code or run `/reload`.

## Usage

```text
/kimi-plugin-codex:setup
/kimi-plugin-codex:doctor
/kimi-plugin-codex:doctor --probe-runtime
/kimi-plugin-codex:review
/kimi-plugin-codex:review --base main
/kimi-plugin-codex:review --path src/utils.js
/kimi-plugin-codex:review --path src --focus "error handling"
/kimi-plugin-codex:adversarial-review --base main challenge the error handling
```

Or use skills directly:

```text
Use the skill codex-review
Use the skill codex-adversarial-review with base main
```

## How It Works

The plugin builds a git diff and passes it to `codex exec -s read-only --ignore-user-config --ephemeral` with a review prompt. Codex returns its findings directly.

- Default (no `--base`): staged + unstaged + untracked files, rendered as a single review input. Untracked files are included only in the default working-tree review.
- `--base <ref>`: computes `git merge-base <ref> HEAD` and reviews only the committed branch changes since that merge-base (`<merge-base>..HEAD`); untracked files are excluded.
- `--path <file-or-dir>`: restricts the diff to the given file or directory.
- A `--focus` string is appended to the prompt in both normal and adversarial modes.

## Diagnostics

Run `/kimi-plugin-codex:doctor` to check:

- Plugin-local environment (Node.js version, git repo, writable directories).
- Whether `codex` is on PATH, its version, and authentication status.
- Proxy environment variables and proxy socket reachability.
- Direct connectivity to `api.openai.com:443`.

Add `--probe-runtime` to send a minimal prompt to Codex and confirm the API path works end-to-end. If the external CLI fails, the plugin prints the real CLI exit code/signal and stderr and exits without fabricating a review.

## Verification

- Plugin manifest: valid JSON, `skills` and `commands` paths present.
- Helper script: tested with `setup`, `review`, `adversarial-review`, and `--base <ref>`.
- Normal and adversarial reviews both use `codex exec` with the pre-computed diff and a read-only sandbox.
- Adversarial review pipes the diff into `codex exec -s read-only --ignore-user-config --ephemeral` with an adversarial prompt.
- Review is read-only; sandbox is set to `read-only` for `exec` paths.
- Boundary tests passed:
  - Non-git directory → clear error, exit 1.
  - Empty diff → "No changes to review.", exit 0.
  - Staged-only, unstaged-only, and untracked changes → detected and reviewed.
  - Invalid base ref → clear git error, exit 1.
  - Large diff (~6 MB / 100 k lines) → handled without `maxBuffer` errors.

## Limitations

- Requires a local git repository.
- Requires `codex` on PATH and authenticated.
- Untracked files that have not been staged are included as synthetic new-file diffs, up to 500 KB per file and 1 MB total across all untracked files.
- `--focus` is supported in both normal and adversarial review modes by appending it to the review prompt.
- Unlike `codex-plugin-cc`, this v0.1 prototype does **not** implement:
  - `--background` / `--wait` execution modes
  - `--scope auto|working-tree|branch` target selection
  - `rescue`, `transfer`, `status`, `result`, or `cancel` commands
  - Stop-time review gate hook
- Skills and commands resolve the helper script via `PLUGIN_ROOT` using `KIMI_PLUGIN_ROOT`, `KIMI_CODE_HOME`, or the default `~/.kimi-code/plugins/managed/kimi-plugin-codex` path.
- This is a v0.1 local prototype.
