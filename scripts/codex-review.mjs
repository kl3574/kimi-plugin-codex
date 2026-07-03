#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';

const USAGE = `Usage: codex-review.mjs <setup|review|adversarial-review> [--base <ref>] [--focus <text>]`;

function runSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function runWithStdin(cmd, args, stdin, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
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

function getDiff(base, cwd) {
  const args = ['diff', '--no-color'];
  if (base) {
    args.push(`${base}...HEAD`);
  }
  const result = runSync('git', args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const options = { base: null, focus: '' };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--base' && i + 1 < args.length) {
      options.base = args[++i];
    } else if (args[i] === '--focus' && i + 1 < args.length) {
      options.focus = args[++i];
    } else if (args[i].startsWith('--base=')) {
      options.base = args[i].slice(7);
    } else if (args[i].startsWith('--focus=')) {
      options.focus = args[i].slice(8);
    }
  }
  return { command, options };
}

function codexOnPath() {
  const result = runSync('which', ['codex']);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function codexVersion() {
  const result = runSync('codex', ['--version']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function codexAuthOk() {
  const result = runSync('codex', ['login', 'status']);
  const output = (result.stdout || '') + (result.stderr || '');
  return result.status === 0 && output.includes('Logged in');
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

async function review({ base, focus, adversarial = false }) {
  const gitRoot = findGitRoot();
  if (!gitRoot) {
    console.error('❌ Not inside a git repository.');
    process.exit(1);
  }

  if (!codexOnPath()) {
    console.error('❌ Codex CLI not found on PATH. Run `codex-setup` first.');
    process.exit(1);
  }

  let diff;
  try {
    diff = getDiff(base, gitRoot);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log('No changes to review.');
    return;
  }

  let result;
  if (adversarial) {
    const prompt = [
      'You are a senior staff engineer doing a read-only adversarial code review.',
      focus ? `Focus: ${focus}` : '',
      'Challenge design decisions, trade-offs, hidden assumptions, and failure modes.',
      'Categorize findings as Critical, Important, or Minor.',
      'For each finding include severity, file:line, evidence, why it matters, and a recommended fix.',
      'End with an overall verdict.',
    ].join('\n');

    result = await runWithStdin('codex', [
      'exec',
      '-s', 'read-only',
      '--ignore-user-config',
      '--ephemeral',
      prompt,
    ], diff, { cwd: gitRoot });
  } else {
    const codexArgs = ['review'];
    if (base) {
      codexArgs.push('--base', base);
    } else {
      codexArgs.push('--uncommitted');
    }
    result = runSync('codex', codexArgs, { cwd: gitRoot, maxBuffer: 32 * 1024 * 1024 });
  }

  if (result.status !== 0 && result.code !== 0) {
    console.error('❌ Codex review failed.');
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  console.log(result.stdout);
}

const { command, options } = parseArgs(process.argv);

switch (command) {
  case 'setup':
    setup();
    break;
  case 'review':
    review(options);
    break;
  case 'adversarial-review':
    review({ ...options, adversarial: true });
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
