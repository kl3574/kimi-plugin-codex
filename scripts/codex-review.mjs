#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = `Usage: codex-review.mjs <setup|review|adversarial-review> [--base <ref>] [--focus <text>]`;
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;

function runSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
    ...opts,
  });
}

function runWithStdin(cmd, args, stdin, opts = {}) {
  return new Promise((resolve) => {
    const { timeout = 5 * 60 * 1000, maxBuffer = DIFF_MAX_BUFFER, ...spawnOpts } = opts;
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOpts,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeout)
      : null;
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (Buffer.byteLength(stdout, 'utf8') > maxBuffer && !killed && !timedOut) {
        killed = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (Buffer.byteLength(stderr, 'utf8') > maxBuffer && !killed && !timedOut) {
        killed = true;
        child.kill('SIGTERM');
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `❌ Failed to start ${cmd}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 1, stdout, stderr: stderr + '\n❌ Review timed out after 5 minutes.' });
        return;
      }
      if (signal === 'SIGTERM' && killed) {
        resolve({ code: 1, stdout, stderr: stderr + '\n❌ Output exceeded maxBuffer limit.' });
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function findGitRoot(cwd = process.cwd()) {
  const result = runSync('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function gitStatusPorcelain(cwd) {
  const result = runSync('git', ['status', '--porcelain'], { cwd });
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }
  return result.stdout;
}

function hasChanges(base, cwd) {
  if (base) {
    const result = runSync('git', ['diff', '--quiet', base, '--'], { cwd });
    if (result.status === 0) {
      // No tracked changes since base; still consider untracked files as changes.
      return getUntrackedFiles(cwd).length > 0;
    }
    if (result.status === 1) return true;
    throw new Error(`git diff failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  return gitStatusPorcelain(cwd).trim().length > 0;
}

function checkGitDiff(result, label) {
  if (result.status !== 0) {
    throw new Error(`git diff (${label}) failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
}

function sanitizePromptInput(s) {
  return String(s || '').replace(/[\n\r]/g, ' ').replace(/```/g, "'''").trim();
}

function validateBaseRef(base) {
  if (base === undefined || base === null) return;
  if (base.trim() === '') {
    throw new Error('--base requires a non-empty ref');
  }
  if (base.startsWith('-')) {
    throw new Error('--base value cannot start with "-"');
  }
}

function getDiff(base, cwd) {
  if (base) {
    // Compare the base ref directly to the working tree so the review covers
    // both committed branch changes and local edits, without duplication.
    const result = runSync('git', ['diff', '--no-color', base, '--'], { cwd, maxBuffer: DIFF_MAX_BUFFER });
    checkGitDiff(result, 'base');
    return result.stdout;
  }
  // Combine staged and unstaged diffs separately so that working-tree changes
  // that cancel out staged changes do not hide the staged patch.
  const unstaged = runSync('git', ['diff', '--no-color'], { cwd, maxBuffer: DIFF_MAX_BUFFER });
  checkGitDiff(unstaged, 'unstaged');
  const staged = runSync('git', ['diff', '--cached', '--no-color'], { cwd, maxBuffer: DIFF_MAX_BUFFER });
  checkGitDiff(staged, 'staged');
  return [staged.stdout, unstaged.stdout].filter(Boolean).join('\n');
}

const MAX_UNTRACKED_BYTES = 1024 * 1024; // 1 MB per untracked file

function getUntrackedFiles(cwd) {
  const result = runSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function readRepoFile(cwd, file) {
  const fullPath = path.join(cwd, file);
  try {
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile()) {
      return { skipped: true, reason: 'not a regular file' };
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return { skipped: true, reason: 'file too large' };
    }
    return { content: fs.readFileSync(fullPath, 'utf8') };
  } catch {
    return { skipped: true, reason: 'read error' };
  }
}

function formatUntrackedDiff(cwd) {
  const files = getUntrackedFiles(cwd);
  if (files.length === 0) return '';
  const parts = [];
  const skipped = [];
  for (const file of files) {
    const result = readRepoFile(cwd, file);
    if (result.skipped) {
      skipped.push(`${file} (${result.reason})`);
      continue;
    }
    const content = result.content;
    const lines = content.split('\n');
    parts.push(`diff --git a/${file} b/${file}`);
    parts.push('new file mode 100644');
    parts.push('index 0000000..0000000');
    parts.push('--- /dev/null');
    parts.push(`+++ b/${file}`);
    parts.push(`@@ -0,0 +1,${lines.length} @@`);
    for (const line of lines) {
      parts.push(`+${line}`);
    }
  }
  if (skipped.length) {
    parts.push(`\n# Skipped untracked files: ${skipped.join(', ')}`);
  }
  return parts.join('\n');
}

function buildReviewDiff(base, cwd) {
  const trackedDiff = getDiff(base, cwd);
  const untrackedDiff = formatUntrackedDiff(cwd);
  if (!untrackedDiff) {
    return trackedDiff;
  }
  return [trackedDiff, untrackedDiff].filter(Boolean).join('\n');
}

function splitArgsString(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let token = '';
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) token += s[++i];
        else token += s[i];
        i++;
      }
      if (i < s.length) i++;
    } else {
      while (i < s.length && !/\s/.test(s[i])) token += s[i++];
    }
    tokens.push(token);
  }
  return tokens;
}

function normalizeArgv(argv) {
  // When invoked from the Kimi Code command wrapper, arguments arrive as a
  // single quoted string in REVIEW_ARGS (avoids shell interpolation of user
  // input). The subcommand (review/adversarial-review/setup) is still passed
  // as argv[2], so we prepend it to any env-var flags.
  const envArgs = process.env.REVIEW_ARGS;
  const args = argv.slice(2).filter((a) => a.length > 0);
  let tokens = [];
  if (envArgs !== undefined) {
    tokens = envArgs.length > 0 ? splitArgsString(envArgs) : [];
  } else if (args.length === 1 && /\s/.test(args[0])) {
    tokens = splitArgsString(args[0]);
  } else {
    tokens = args;
  }
  if (args.length > 0 && args[0] !== tokens[0]) {
    tokens = [args[0], ...tokens];
  }
  return tokens;
}

function parseArgs(argv) {
  const args = normalizeArgv(argv);
  const command = args[0];
  const options = { base: null, focus: '', unknown: [], positional: [] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--base') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--base requires a value');
      }
      options.base = args[++i];
    } else if (args[i] === '--focus') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--focus requires a value');
      }
      options.focus = args[++i];
    } else if (args[i].startsWith('--base=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--base requires a value');
      options.base = value;
    } else if (args[i].startsWith('--focus=')) {
      const value = args[i].slice(8);
      if (!value) throw new Error('--focus requires a value');
      options.focus = value;
    } else if (args[i].startsWith('-')) {
      options.unknown.push(args[i]);
    } else {
      options.positional.push(args[i]);
    }
  }
  return { command, options };
}

function codexOnPath() {
  const result = runSync('codex', ['--version']);
  return result.status === 0;
}

function codexVersion() {
  const result = runSync('codex', ['--version']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function codexAuthOk() {
  const result = runSync('codex', ['login', 'status']);
  const output = (result.stdout || '') + (result.stderr || '');
  return result.status === 0 && /\bLogged in\b/.test(output);
}

function setup() {
  if (!codexOnPath()) {
    console.log('❌ Codex CLI not found on PATH. Install from https://github.com/openai/codex');
    process.exit(1);
  }
  const version = codexVersion();
  console.log(`✅ Codex CLI found: ${version}`);
  if (!codexAuthOk()) {
    console.log('❌ Codex CLI is not authenticated. Run `codex login`.');
    process.exit(1);
  }
  console.log('✅ Codex CLI is authenticated.');
}

async function review({ base, focus, adversarial = false, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }

  let effectiveFocus = focus;
  if (adversarial && positional.length) {
    if (effectiveFocus) {
      console.error('❌ Cannot use positional focus text together with --focus.');
      process.exit(1);
    }
    effectiveFocus = positional.join(' ');
  } else if (positional.length) {
    console.error(`❌ Unexpected positional argument(s): ${positional.join(' ')}`);
    process.exit(1);
  }

  const gitRoot = findGitRoot();
  if (!gitRoot) {
    console.error('❌ Not inside a git repository.');
    process.exit(1);
  }

  if (!codexOnPath()) {
    console.error('❌ Codex CLI not found on PATH. Run `/kimi-plugin-codex:setup` first.');
    process.exit(1);
  }
  if (!codexAuthOk()) {
    console.error('❌ Codex CLI is not authenticated. Run `/kimi-plugin-codex:setup` first.');
    process.exit(1);
  }

  try {
    validateBaseRef(base);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  try {
    if (!hasChanges(base, gitRoot)) {
      console.log('No changes to review.');
      return;
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  let diff;
  try {
    diff = buildReviewDiff(base, gitRoot);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log('No changes to review.');
    return;
  }

  const displayBase = sanitizePromptInput(base);
  const displayFocus = sanitizePromptInput(effectiveFocus);

  const promptLines = [
    'You are a senior staff engineer doing a read-only code review.',
    'Review the git diff provided on stdin. Do not modify any files.',
  ];
  if (adversarial) {
    promptLines.push('Challenge design decisions, trade-offs, hidden assumptions, and failure modes. Be constructive but skeptical.');
  }
  if (displayFocus) {
    promptLines.push(`Focus: ${displayFocus}`);
  }
  promptLines.push(
    'Categorize findings as Critical, Important, or Minor.',
    'For each finding include severity, file:line, evidence, why it matters, and a recommended fix.',
    'End with an overall verdict.',
  );
  if (base) {
    promptLines.push('', `Base ref: ${displayBase}`);
  }
  const prompt = promptLines.join('\n');

  const result = await runWithStdin('codex', [
    'exec',
    '-s', 'read-only',
    '--ignore-user-config',
    '--ephemeral',
    prompt,
  ], diff, { cwd: gitRoot, maxBuffer: DIFF_MAX_BUFFER, timeout: 5 * 60 * 1000 });

  if ((result.status ?? result.code) !== 0) {
    console.error('❌ Codex review failed.');
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  console.log(result.stdout);
}

let command;
let options;
try {
  ({ command, options } = parseArgs(process.argv));
} catch (err) {
  console.error(`❌ ${err.message}`);
  console.error(USAGE);
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'setup':
      setup();
      break;
    case 'review':
      await review(options);
      break;
    case 'adversarial-review':
      await review({ ...options, adversarial: true });
      break;
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});
