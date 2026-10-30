#!/usr/bin/env node
// Integration test for the editor-integration pieces:
//   1. src/patch.ts  — reverse-applying opencode's unified diffs
//   2. src/api.ts    — talking to a real `opencode serve` instance
//
//   node scripts/test-integration.mjs
//   node scripts/test-integration.mjs --skip-api   (no opencode needed)

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const skipApi = process.argv.includes('--skip-api');
const buildDir = path.join(process.cwd(), 'build-test');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`[test] ok   ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.log(`[test] FAIL ${name}: ${error.message}`);
  }
}

async function runCheck(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`[test] ok   ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.log(`[test] FAIL ${name}: ${error.message}`);
  }
}

function assertEquals(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

async function bundle(entry, outfile, options = {}) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: options.format ?? 'esm',
    outfile,
    external: options.external ?? [],
    logLevel: 'silent',
  });
}

fs.mkdirSync(buildDir, { recursive: true });
await bundle('src/patch.ts', path.join(buildDir, 'patch.mjs'));
const { reverseApply } = await import(pathToFileURL(path.join(buildDir, 'patch.mjs')).href);

check('reverse-apply a single modified hunk', () => {
  const after = 'a\nB\nc\n';
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n');
  assertEquals(reverseApply(after, patch), 'a\nb\nc\n', 'before contents');
});

check('reverse-apply a multi-hunk patch', () => {
  const after = ['l1', 'l2', 'L3', 'l4', 'l5', 'l6', 'l7', 'l8', 'L9', 'l10', ''].join('\n');
  const patch = [
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,4 +1,4 @@',
    ' l1',
    ' l2',
    '-l3',
    '+L3',
    ' l4',
    '@@ -7,4 +7,4 @@',
    ' l7',
    ' l8',
    '-l9',
    '+L9',
    ' l10',
  ].join('\n');
  assertEquals(reverseApply(after, patch), ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', ''].join('\n'), 'before contents');
});

check('reverse-apply an added file yields empty contents', () => {
  const after = 'one\ntwo\n';
  const patch = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n');
  assertEquals(reverseApply(after, patch), '', 'before contents');
});

check('reverse-apply a deleted file restores the removed lines', () => {
  const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two'].join('\n');
  assertEquals(reverseApply('', patch), 'one\ntwo', 'before contents');
});

check('reverse-apply keeps CRLF line endings', () => {
  const after = 'a\r\nB\r\nc\r\n';
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n');
  assertEquals(reverseApply(after, patch), 'a\r\nb\r\nc\r\n', 'before contents');
});

check('reverse-apply rejects a patch that does not match', () => {
  const patch = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' nope', '-zzz', '+yyy'].join('\n');
  let threw = false;
  try {
    reverseApply('a\nb\nc\n', patch);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, 'expected a throw');
});

if (skipApi) {
  console.log('[test] api checks skipped');
} else {
  await bundle('src/api.ts', path.join(buildDir, 'api.mjs'));
  const { OpencodeApi } = await import(pathToFileURL(path.join(buildDir, 'api.mjs')).href);

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pane-api-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# probe\n');
  const password = crypto.randomBytes(32).toString('base64url');
  const port = 47850 + Math.floor(Math.random() * 40);

  const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: project,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = () => {
    try {
      if (process.platform === 'win32' && child.pid) {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // already gone
    }
  };
  process.on('exit', cleanup);

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const url = `http://127.0.0.1:${port}`;
  const log = { appendLine: (line) => console.log(`[log] ${line}`) };
  const info = {
    url,
    port,
    password,
    authToken: Buffer.from(`opencode:${password}`, 'utf8').toString('base64url'),
    cwd: project,
  };

  let api;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    api = new OpencodeApi(info, log);
    try {
      await api.location();
      break;
    } catch {
      await delay(300);
    }
  }

  const run = runCheck;

  await run('api: location is the project directory', async () => {
    const location = await api.location();
    assertEquals(location.directory.toLowerCase(), project.toLowerCase(), 'location.directory');
  });

  let created;
  await run('api: create a session pinned to the project', async () => {
    created = await api.createSession(project, 'opencode-pane test');
    if (!created?.id) throw new Error('no session id');
    assertEquals(created.location?.directory?.toLowerCase(), project.toLowerCase(), 'session location');
  });

  await run('api: list sessions for the project', async () => {
    const sessions = await api.listSessions({ directory: project, limit: 5 });
    const ids = sessions.map((session) => session.id);
    if (!ids.includes(created.id)) throw new Error(`created session missing from ${JSON.stringify(ids)}`);
  });

  await run('api: session diff is empty before any edits', async () => {
    const diffs = await api.sessionDiff(created.id);
    assertEquals(diffs.length, 0, 'diff count');
  });

  cleanup();
}

// --- review: native diff reconstruction with a mocked vscode -----------------
{
  const Module = (await import('node:module')).default;
  const { createRequire } = await import('node:module');
  const requireCjs = createRequire(import.meta.url);

  await bundle('src/review.ts', path.join(buildDir, 'review.cjs'), { format: 'cjs', external: ['vscode'] });

  const diffCalls = [];
  const notices = [];
  const vscodeMock = {
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p }) },
    window: {
      showInformationMessage: async (message) => {
        notices.push(message);
        return undefined;
      },
      showTextDocument: async () => undefined,
    },
    commands: {
      executeCommand: async (id, ...args) => {
        if (id === 'vscode.diff') diffCalls.push(args);
        return undefined;
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  const { reviewChanges } = requireCjs(path.join(buildDir, 'review.cjs'));
  Module._load = originalLoad;

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pane-review-'));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pane-storage-'));
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'line1\nCHANGED\nline3\n');
  fs.writeFileSync(path.join(project, 'new.txt'), 'one\ntwo\n');

  const modifiedPatch = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-line2',
    '+CHANGED',
    ' line3',
  ].join('\n');
  const addedPatch = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n');

  const fakeApi = {
    listSessions: async () => [{ id: 'ses_test', title: 'probe session', location: { directory: project } }],
    sessionDiff: async () => [
      { file: 'src/app.ts', patch: modifiedPatch, additions: 1, deletions: 1, status: 'modified' },
      { file: 'new.txt', patch: addedPatch, additions: 2, deletions: 0, status: 'added' },
    ],
  };

  await runCheck('review: opens one diff per changed file', async () => {
    await reviewChanges({
      api: fakeApi,
      directory: project,
      storageRoot: storage,
      log: { appendLine: () => {} },
    });
    assertEquals(diffCalls.length, 2, 'diff call count');
  });

  check('review: left side is the pre-edit contents', () => {
    const [left, right, title] = diffCalls[0];
    const before = fs.readFileSync(left.fsPath, 'utf8');
    assertEquals(before, 'line1\nline2\nline3\n', 'before contents');
    assertEquals(path.resolve(right.fsPath), path.resolve(project, 'src', 'app.ts'), 'right side is the real file');
    if (!/app\.ts/.test(String(title))) throw new Error(`unexpected diff title: ${title}`);
  });

  check('review: added files diff against empty content', () => {
    const [left] = diffCalls[1];
    assertEquals(fs.readFileSync(left.fsPath, 'utf8'), '', 'before contents');
  });

  check('review: reports the session title', () => {
    const last = notices.at(-1) ?? '';
    if (!/probe session/.test(last)) throw new Error(`unexpected notice: ${last}`);
  });
}

fs.rmSync(buildDir, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n[test] ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
