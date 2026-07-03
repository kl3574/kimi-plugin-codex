#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: codex-review.mjs <setup|doctor|review|adversarial-review> [--base <ref>] [--focus <text>] [--path <file-or-dir>] [--probe-runtime]`;
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;
const REVIEW_TIMEOUT_MS = Number(process.env.CODEX_REVIEW_TIMEOUT_MS) || 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = Number(process.env.CODEX_PROBE_TIMEOUT_MS) || 10 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const CONNECT_TIMEOUT_MS = Number(process.env.CODEX_CONNECT_TIMEOUT_MS) || 5000;
const MAX_UNTRACKED_BYTES = Number(process.env.CODEX_MAX_UNTRACKED_BYTES) || 500 * 1024;
const TOTAL_UNTRACKED_BUDGET_BYTES = Number(process.env.CODEX_TOTAL_UNTRACKED_BUDGET_BYTES) || 1024 * 1024;

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
    const { timeout = REVIEW_TIMEOUT_MS, maxBuffer = DIFF_MAX_BUFFER, ...spawnOpts } = opts;
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOpts,
    });
    let stdout = '';
    let stderr = '';
    let combinedBytes = 0;
    let killed = false;
    let timedOut = false;
    let killReason = null;
    let killTimer = null;
    let resolved = false;
    const timer = timeout
      ? setTimeout(() => {
          if (timedOut || killed) return;
          timedOut = true;
          killReason = killReason || 'timeout';
          child.kill('SIGTERM');
          if (!killTimer) {
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          }
        }, timeout)
      : null;
    child.stdout.on('data', (data) => {
      if (resolved) return;
      stdout += data.toString();
      combinedBytes += data.length;
      if (combinedBytes > maxBuffer && !killed && !timedOut && !resolved) {
        killed = true;
        killReason = killReason || 'maxBuffer';
        child.kill('SIGTERM');
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }
      }
    });
    child.stderr.on('data', (data) => {
      if (resolved) return;
      stderr += data.toString();
      combinedBytes += data.length;
      if (combinedBytes > maxBuffer && !killed && !timedOut && !resolved) {
        killed = true;
        killReason = killReason || 'maxBuffer';
        child.kill('SIGTERM');
        if (!killTimer) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }
      }
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 1, signal: null, stdout, stderr: `❌ Failed to start ${cmd}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal === 'SIGKILL') {
        const msg = killReason === 'timeout'
          ? `\n❌ Review timed out after ${timeout / 60000} minutes and was force-killed.`
          : '\n❌ Review was force-killed after output exceeded the maxBuffer limit.';
        resolve({ code: 1, signal: 'SIGKILL', stdout, stderr: stderr + msg });
        return;
      }
      if (timedOut) {
        resolve({ code: 1, signal, stdout, stderr: stderr + `\n❌ Review timed out after ${timeout / 60000} minutes.` });
        return;
      }
      if (signal === 'SIGTERM' && killed) {
        resolve({ code: 1, signal: 'SIGTERM', stdout, stderr: stderr + '\n❌ Output exceeded maxBuffer limit.' });
        return;
      }
      resolve({ code, signal, stdout, stderr });
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

function getMergeBase(base, cwd) {
  const result = runSync('git', ['merge-base', base, 'HEAD'], { cwd });
  if (result.status !== 0) {
    throw new Error(`git merge-base failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  const mergeBase = result.stdout.trim();
  if (!mergeBase) {
    throw new Error(`git merge-base ${base} HEAD returned empty result; the refs may not share a common ancestor.`);
  }
  return mergeBase;
}



function checkGitDiff(result, label) {
  if (result.status !== 0) {
    throw new Error(`git diff (${label}) failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
}

function sanitizePromptInput(s) {
  if (s == null) return '';
  if (typeof s !== 'string') s = String(s);
  return s.replace(/[\r\n]+/g, ' ').replace(/```/g, "'''").trim();
}

function validateBaseRef(base) {
  if (base === undefined || base === null) return;
  const str = String(base);
  if (str.trim() === '') {
    throw new Error('--base requires a non-empty ref');
  }
  if (str.startsWith('-')) {
    throw new Error('--base value cannot start with "-"');
  }
}

function validatePathValue(rawPath) {
  if (rawPath === undefined || rawPath === null) return;
  const str = String(rawPath);
  if (str.trim() === '') {
    throw new Error('--path requires a non-empty value');
  }
  if (str.startsWith('-')) {
    throw new Error('--path value cannot start with "-"');
  }
}

function isTrackedPath(cwd, relPath) {
  const posixRel = relPath.replace(/\\/g, '/');
  if (runSync('git', ['cat-file', '-e', `HEAD:${posixRel}`], { cwd }).status === 0) return true;
  const lsResult = runSync('git', ['ls-files', '--error-unmatch', posixRel], { cwd });
  return lsResult.status === 0;
}

function trackedObjectType(cwd, relPath) {
  const posixRel = relPath.replace(/\\/g, '/');
  const result = runSync('git', ['cat-file', '-t', `HEAD:${posixRel}`], { cwd });
  if (result.status === 0) return result.stdout.trim();
  const idxResult = runSync('git', ['ls-files', '--stage', posixRel], { cwd });
  if (idxResult.status === 0) {
    const mode = idxResult.stdout.trim().split(/\s+/)[0];
    if (mode === '160000') return 'submodule';
    if (mode === '120000') return 'symlink';
    if (mode === '040000') return 'tree';
    return 'blob';
  }
  return 'blob';
}

function resolveTargetPath(rawPath) {
  if (!rawPath) return null;

  const cwdRoot = findGitRoot();
  const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rawPath);

  let stat;
  let targetType = 'file';
  let deleted = false;
  try {
    stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`--path must not point to a symlink: ${absPath}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`--path must point to a file or directory: ${absPath}`);
    }
    targetType = stat.isDirectory() ? 'dir' : 'file';
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const searchRoot = path.dirname(absPath);
      const gitRoot = findGitRoot(searchRoot);
      if (gitRoot) {
        const relPath = path.relative(gitRoot, absPath);
        if (
          relPath !== '..'
          && !relPath.startsWith('..' + path.sep)
          && !path.isAbsolute(relPath)
          && isTrackedPath(gitRoot, relPath)
        ) {
          deleted = true;
          targetType = trackedObjectType(gitRoot, relPath) === 'tree' ? 'dir' : 'file';
        } else {
          throw new Error(`--path does not exist: ${absPath}`);
        }
      } else {
        throw new Error(`--path does not exist: ${absPath}`);
      }
    } else {
      throw err;
    }
  }

  const searchRoot = stat && stat.isDirectory() ? absPath : path.dirname(absPath);
  const gitRoot = findGitRoot(searchRoot);
  if (!gitRoot) {
    throw new Error(`The path ${absPath} is not inside a git repository.`);
  }
  if (cwdRoot && gitRoot !== cwdRoot) {
    throw new Error(`The path ${absPath} is not inside the current git repository (${cwdRoot}).`);
  }
  const relPath = path.relative(gitRoot, absPath);
  if (relPath === '..' || relPath.startsWith('..' + path.sep) || path.isAbsolute(relPath)) {
    throw new Error(`The path ${absPath} is outside the git repository (${gitRoot}).`);
  }
  return {
    absPath,
    gitRoot,
    relPath: relPath || '.',
    targetType,
    deleted,
  };
}

function getDiff(base, cwd, target = null) {
  const pathArgs = target && target.relPath !== '.' ? ['--', target.relPath.replace(/\\/g, '/')] : [];
  if (base) {
    const mergeBase = getMergeBase(base, cwd);
    const result = runSync('git', ['diff', '--no-color', `${mergeBase}..HEAD`, ...pathArgs], { cwd, maxBuffer: DIFF_MAX_BUFFER });
    checkGitDiff(result, 'base');
    return result.stdout;
  }
  const unstaged = runSync('git', ['diff', '--no-color', ...pathArgs], { cwd, maxBuffer: DIFF_MAX_BUFFER });
  checkGitDiff(unstaged, 'unstaged');
  const staged = runSync('git', ['diff', '--cached', '--no-color', ...pathArgs], { cwd, maxBuffer: DIFF_MAX_BUFFER });
  checkGitDiff(staged, 'staged');
  return [staged.stdout, unstaged.stdout].filter(Boolean).join('\n');
}

function getUntrackedFiles(cwd) {
  const result = runSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean);
}

function isBinaryContent(buf) {
  if (buf.length === 0) return false;
  if (buf.includes(0)) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) continue;
    nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.1;
}

function gitBlobHash(content) {
  const header = `blob ${content.length}\0`;
  return crypto.createHash('sha1').update(header).update(content).digest('hex').slice(0, 7);
}

function syntheticNewFileDiff(filePath, relPath) {
  const content = fs.readFileSync(filePath);
  if (isBinaryContent(content)) {
    return { skipped: true, reason: 'binary file' };
  }
  if (content.length === 0) {
    return { skipped: true, reason: 'empty file' };
  }
  const text = content.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const lineCount = endsWithNewline ? lines.length - 1 : lines.length;
  const hash = gitBlobHash(content);
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    `index 0000000..${hash}`,
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lineCount} @@`,
  ];
  const body = lines.slice(0, lineCount).map((line) => `+${line}`);
  if (!endsWithNewline) {
    body.push('\\ No newline at end of file');
  }
  return { diff: header.concat(body).join('\n') };
}

function getUntrackedFileDiff(cwd, file) {
  return syntheticNewFileDiff(path.resolve(cwd, file), file);
}

function formatUntrackedDiff(cwd, target = null) {
  let files = getUntrackedFiles(cwd);
  if (target && target.relPath !== '.') {
    const rel = target.relPath.replace(/\\/g, '/');
    if (target.targetType === 'file') {
      files = files.filter((f) => f === rel);
    } else {
      const prefix = rel + '/';
      files = files.filter((f) => f.startsWith(prefix));
    }
  }
  if (files.length === 0) return { diff: '', hasRealDiff: false, skipped: [] };
  const parts = [];
  const skipped = [];
  let totalBytes = 0;
  const resolvedCwd = path.resolve(cwd);
  for (const file of files) {
    const fullPath = path.resolve(cwd, file);
    if (!fullPath.startsWith(resolvedCwd + path.sep) && fullPath !== resolvedCwd) {
      skipped.push(`${file} (path traversal)`);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      skipped.push(`${file} (read error)`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push(`${file} (symlink)`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${file} (not a regular file)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      skipped.push(`${file} (file too large)`);
      continue;
    }
    let result;
    try {
      result = getUntrackedFileDiff(cwd, file);
    } catch (err) {
      skipped.push(`${file} (diff error: ${err.message})`);
      continue;
    }
    if (result.skipped) {
      skipped.push(`${file} (${result.reason})`);
      continue;
    }
    const diffBytes = Buffer.byteLength(result.diff, 'utf8');
    if (totalBytes + diffBytes > TOTAL_UNTRACKED_BUDGET_BYTES) {
      skipped.push(`${file} (total untracked budget exceeded)`);
      continue;
    }
    totalBytes += diffBytes;
    parts.push(result.diff);
  }
  const diff = parts.length > 0 && skipped.length > 0
    ? [...parts, `\n# Skipped untracked files: ${skipped.join(', ')}`].join('\n')
    : parts.join('\n');
  return { diff, hasRealDiff: parts.length > 0, skipped };
}

function buildReviewDiff(base, cwd, target = null) {
  const trackedDiff = getDiff(base, cwd, target);
  if (base) {
    return { diff: trackedDiff, hasRealDiff: trackedDiff.trim().length > 0, skipped: [] };
  }
  const untracked = formatUntrackedDiff(cwd, target);
  return {
    diff: [trackedDiff, untracked.diff].filter(Boolean).join('\n'),
    hasRealDiff: trackedDiff.trim().length > 0 || untracked.hasRealDiff,
    skipped: untracked.skipped,
  };
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
  const envArgs = process.env.REVIEW_ARGS;
  if (envArgs !== undefined) {
    const tokens = envArgs.length > 0 ? splitArgsString(envArgs) : [];
    const command = argv[2];
    if (command && tokens[0] !== command) {
      return [command, ...tokens];
    }
    return tokens;
  }
  const args = argv.slice(2).filter((a) => a.length > 0);
  if (args.length === 1 && /\s/.test(args[0])) {
    return splitArgsString(args[0]);
  }
  return args;
}

function parseArgs(argv) {
  const args = normalizeArgv(argv);
  const command = args[0];
  const options = { base: null, focus: '', path: null, probeRuntime: false, unknown: [], positional: [] };
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
    } else if (args[i] === '--path') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error('--path requires a value');
      }
      options.path = args[++i];
    } else if (args[i] === '--probe-runtime') {
      options.probeRuntime = true;
    } else if (args[i].startsWith('--base=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--base requires a value');
      options.base = value;
    } else if (args[i].startsWith('--focus=')) {
      const value = args[i].slice(8);
      if (!value) throw new Error('--focus requires a value');
      options.focus = value;
    } else if (args[i].startsWith('--path=')) {
      const value = args[i].slice(7);
      if (!value) throw new Error('--path requires a value');
      options.path = value;
    } else if (args[i].startsWith('-')) {
      options.unknown.push(args[i]);
    } else {
      options.positional.push(args[i]);
    }
  }
  return { command, options };
}

function codexOnPath() {
  const result = runSync('codex', ['--version'], { timeout: PROBE_TIMEOUT_MS });
  return result.status === 0;
}

function codexVersion() {
  const result = runSync('codex', ['--version'], { timeout: PROBE_TIMEOUT_MS });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function codexAuthOk() {
  const result = runSync('codex', ['login', 'status'], { timeout: PROBE_TIMEOUT_MS });
  if (result.status !== 0) return false;
  const output = (result.stdout || '') + (result.stderr || '');
  return /\bLogged\s+in\b/i.test(output);
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

// -------------------- doctor helpers --------------------

function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.F_OK);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function canConnectSync(host, port) {
  const code = `
    const net = require('net');
    const socket = net.connect(${Number(port)}, ${JSON.stringify(host)}, () => { socket.end(); process.exit(0); });
    socket.setTimeout(${CONNECT_TIMEOUT_MS});
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => process.exit(1));
  `;
  const result = runSync('node', ['-e', code], { timeout: CONNECT_TIMEOUT_MS + 2000 });
  return result.status === 0;
}

function checkProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) {
    return { ok: true, detail: 'No HTTP(S)_PROXY environment variable set' };
  }
  let host;
  let port;
  try {
    const urlString = /^https?:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
    const u = new URL(urlString);
    host = u.hostname;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, detail: `Proxy URL has invalid port: ${u.port || '(default)'}` };
    }
  } catch (err) {
    return { ok: false, detail: `Proxy URL parse failed: ${err.message}` };
  }
  const reachable = canConnectSync(host, Number(port));
  if (reachable) {
    return { ok: true, detail: `Proxy socket reachable: ${host}:${port}` };
  }
  return { ok: false, detail: `Proxy socket unreachable: ${host}:${port}` };
}

async function probeCodex() {
  const result = await runWithStdin('codex', [
    'exec',
    '-s', 'read-only',
    '--ignore-user-config',
    '--ephemeral',
    'Reply exactly: RUNTIME-OK',
  ], '', { timeout: PROBE_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER });
  if (result.code !== 0) {
    return { ok: false, detail: (result.stderr || '').trim() || `exit ${result.code}` };
  }
  const first = result.stdout.trim().split('\n')[0];
  if (first !== 'RUNTIME-OK') {
    return { ok: false, detail: `unexpected output: "${first}"` };
  }
  return { ok: true, detail: `returned "${first}"` };
}

async function doctor({ probeRuntime, base, focus, path: pathOption, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (positional.length) {
    console.error(`❌ Unexpected positional argument(s): ${positional.join(' ')}`);
    process.exit(1);
  }
  if (base !== undefined && base !== null) {
    console.error('❌ --base is not valid for the doctor command.');
    process.exit(1);
  }
  if (focus) {
    console.error('❌ --focus is not valid for the doctor command.');
    process.exit(1);
  }
  if (pathOption) {
    console.error('❌ --path is not valid for the doctor command.');
    process.exit(1);
  }
  const issues = [];
  function report(ok, label, detail = '') {
    const status = ok ? '[OK]' : '[FAIL]';
    const line = detail ? `${label} - ${detail}` : label;
    console.log(`${status} ${line}`);
    if (!ok) issues.push(line);
  }

  console.log('# Codex for Kimi - Doctor\n');

  console.log('## Plugin-local checks');
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  const cwdGitRoot = findGitRoot();
  if (cwdGitRoot) {
    report(true, 'Current directory is inside a git repository', cwdGitRoot);
  } else {
    report(false, 'Current directory is not inside a git repository');
  }
  report(isWritableDir(os.tmpdir()), 'Temp directory is writable', os.tmpdir());
  const root = pluginRoot();
  const rootWritable = isWritableDir(root);
  console.log(`${rootWritable ? '[OK]' : '[INFO]'} Plugin root is writable - ${root}${rootWritable ? '' : ' (read-only is OK for managed installs)'}`);
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  report(isWritableDir(kimiHome), 'Kimi Code home is writable', kimiHome);

  console.log('\n## External CLI checks');
  if (codexOnPath()) {
    report(true, 'Codex CLI found', codexVersion());
  } else {
    report(false, 'Codex CLI not found on PATH', 'Install from https://github.com/openai/codex');
  }
  const codexAuth = codexAuthOk();
  report(codexAuth, 'Codex CLI authenticated', codexAuth ? '' : 'Run `codex login`');

  console.log('\n## Network / proxy checks');
  const proxy = checkProxy();
  report(proxy.ok, proxy.detail);
  const proxyConfigured = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  const direct = canConnectSync('api.openai.com', 443);
  if (proxyConfigured) {
    console.log(`[INFO] Direct connection to api.openai.com:443 - ${direct ? 'reachable' : 'unreachable'} (proxy is configured)`);
  } else {
    report(direct, 'Direct connection to api.openai.com:443');
  }

  if (probeRuntime) {
    console.log('\n## Runtime probe');
    const probe = await probeCodex();
    report(probe.ok, 'Minimal Codex prompt', probe.detail);
  }

  console.log('\n## Summary');
  if (issues.length === 0) {
    console.log('All checks passed.');
  } else {
    console.log(`${issues.length} check(s) failed. See [FAIL] lines above.`);
    process.exit(1);
  }
}

// -------------------- review --------------------

async function review({ base, focus, path: rawPath, probeRuntime, adversarial = false, unknown = [], positional = [] }) {
  if (unknown.length) {
    console.error(`❌ Unknown option(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  if (probeRuntime) {
    console.error('❌ --probe-runtime is only valid for the doctor command.');
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

  let target;
  try {
    validatePathValue(rawPath);
    target = resolveTargetPath(rawPath);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const gitRoot = target ? target.gitRoot : findGitRoot();
  if (!gitRoot) {
    console.error('❌ Not inside a git repository.');
    process.exit(1);
  }

  if (!codexOnPath()) {
    console.error('❌ Codex CLI not found on PATH. Run `/kimi-plugin-codex:setup` or `/kimi-plugin-codex:doctor` first.');
    process.exit(1);
  }
  if (!codexAuthOk()) {
    console.error('❌ Codex CLI is not authenticated. Run `codex login` and try again.');
    process.exit(1);
  }

  try {
    validateBaseRef(base);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (base) {
    const dirty = gitStatusPorcelain(gitRoot).trim();
    if (dirty) {
      console.warn('⚠️ Working tree has uncommitted/untracked changes that are excluded from --base review. Run without --base to include them.');
    }
  }

  let diffResult;
  try {
    diffResult = buildReviewDiff(base, gitRoot, target);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (diffResult.skipped.length) {
    console.warn(`⚠️ Skipped untracked files: ${diffResult.skipped.join(', ')}`);
  }
  if (!diffResult.hasRealDiff) {
    console.log('No changes to review.');
    return;
  }
  let diff = diffResult.diff;

  const maxDiffChars = 120000;
  const codePoints = [...diff];
  let truncated = false;
  if (codePoints.length > maxDiffChars) {
    diff = codePoints.slice(0, maxDiffChars).join('') + '\n\n[diff truncated]';
    truncated = true;
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
  ], diff, { cwd: gitRoot, maxBuffer: DIFF_MAX_BUFFER, timeout: REVIEW_TIMEOUT_MS });

  console.error('## Plugin-local status');
  console.error(`Target: ${target ? target.absPath : gitRoot}`);
  console.error(`Base ref: ${base || '(none)'}`);
  console.error(`Diff size: ${Buffer.byteLength(diff, 'utf8')} bytes sent to Codex`);
  console.error();

  if (result.code !== 0) {
    console.error('❌ Codex review failed (external CLI).');
    console.error(`Exit code: ${result.code ?? 'unknown'}`);
    if (result.signal) console.error(`Signal: ${result.signal}`);
    if (result.stderr) {
      console.error('## External CLI stderr');
      console.error(result.stderr);
    }
    process.exit(1);
  }

  console.log('## Codex CLI review output\n');
  if (truncated) {
    console.log('⚠️ Diff was truncated before sending to Codex.\n');
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
    case 'doctor':
      await doctor(options);
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
