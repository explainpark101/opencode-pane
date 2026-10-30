#!/usr/bin/env node
// Smoke test: spawn `opencode serve`, wait for readiness, and verify the web UI
// is reachable with the auth token the extension generates.
//
//   node scripts/smoke.mjs
//   node scripts/smoke.mjs --chrome   (also render the UI in headless Chrome)

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const useChrome = process.argv.includes('--chrome');

function findOpencode() {
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(finder, ['opencode'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'opencode';
  } catch {
    return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const password = crypto.randomBytes(32).toString('base64url');
const authToken = Buffer.from(`opencode:${password}`, 'utf8').toString('base64url');
const authorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
const executable = findOpencode();

console.log(`[smoke] executable: ${executable}`);

const child = spawn(executable, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let url;
let settled = false;

const cleanup = () => {
  if (settled) return;
  settled = true;
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {}
  } else {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  const match = /server listening on\s+(https?:\/\/\S+)/i.exec(stdout);
  if (match && !url) {
    url = match[1].replace(/\/+$/, '');
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.on('exit', (code, signal) => {
  if (!url) {
    console.error(`[smoke] opencode exited early (${code ?? signal}):\n${stderr}`);
    cleanup();
    process.exit(1);
  }
});

const deadline = Date.now() + 30_000;
while (!url) {
  if (Date.now() > deadline) {
    console.error(`[smoke] timed out waiting for server URL.\n${stdout}\n${stderr}`);
    cleanup();
    process.exit(1);
  }
  await delay(200);
}

console.log(`[smoke] server: ${url}`);

let info;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: { authorization },
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      info = await res.json();
      break;
    }
  } catch {
    // retry
  }
  await delay(300);
}

if (!info) {
  console.error('[smoke] /api/info never became ready');
  cleanup();
  process.exit(1);
}

console.log(`[smoke] version: ${info.version} pid: ${info.pid} hostname: ${info.hostname}`);

const page = await fetch(`${url}/?auth_token=${authToken}`);
const html = await page.text();
if (!page.ok || !/OpenCode/i.test(html)) {
  console.error(`[smoke] web UI failed: HTTP ${page.status}, ${html.length} bytes`);
  cleanup();
  process.exit(1);
}
console.log(`[smoke] web UI: HTTP ${page.status}, ${html.length} bytes`);

const openUrl = `${url}/?auth_token=${authToken}`;
console.log(`[smoke] auth url: ${openUrl}`);

if (useChrome) {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

  const chrome = candidates.find((candidate) => {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });

  if (!chrome) {
    console.warn('[smoke] chrome not found; skipping DOM render');
  } else {
    const userDataDir = process.env.TEMP
      ? `${process.env.TEMP}\\opencode-pane-smoke`
      : '/tmp/opencode-pane-smoke';
    const dom = execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        '--virtual-time-budget=12000',
        '--dump-dom',
        openUrl,
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const hasApp = /data-opencode-mounted|New session|OpenCode/i.test(dom);
    console.log(`[smoke] headless DOM: ${dom.length} bytes, app mounted: ${hasApp}`);
  }
}

cleanup();
console.log('[smoke] ok');
