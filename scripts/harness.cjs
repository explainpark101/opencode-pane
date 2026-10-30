#!/usr/bin/env node
// Dev harness: loads the compiled extension with a mocked `vscode` API and runs
// the real spawn -> auth -> webview HTML -> shutdown path.
//
//   node scripts/harness.cjs

'use strict';

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('[harness] dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function disposable(fn) {
  return { dispose: fn || (() => {}) };
}

class Emitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const bound = thisArg ? listener.bind(thisArg) : listener;
      this.listeners.add(bound);
      const d = disposable(() => this.listeners.delete(bound));
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pane-harness-'));
const logs = [];
const commands = new Map();
const providers = new Map();
const statusItems = [];
const terminals = [];
const messages = [];
const globalState = new Map();
const secrets = new Map();
const clipboard = [];

const Uri = {
  file(p) {
    return { scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` };
  },
  parse(value) {
    return { toString: () => value };
  },
  joinPath(base, ...parts) {
    return Uri.file(path.join(base.fsPath, ...parts));
  },
};

const vscodeMock = {
  version: '1.128.0',
  StatusBarAlignment: { Left: 1, Right: 2 },
  EventEmitter: Emitter,
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      this.fn?.();
    }
  },
  Uri: {
    file: Uri.file,
    parse: Uri.parse,
    joinPath: Uri.joinPath,
  },
  env: {
    remoteName: undefined,
    openExternal: async () => true,
    clipboard: {
      async writeText(value) {
        clipboard.push(String(value));
      },
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(workspaceDir), name: path.basename(workspaceDir), index: 0 }],
    getWorkspaceFolder(uri) {
      return String(uri.fsPath).toLowerCase().startsWith(workspaceDir.toLowerCase())
        ? { uri: Uri.file(workspaceDir), name: path.basename(workspaceDir), index: 0 }
        : undefined;
    },
    getConfiguration(section) {
      return {
        get(key, fallback) {
          if (section === 'opencode-pane') {
            // Force a random port so the harness never fights a real server.
            if (key === 'port') return Number(process.env.HARNESS_PORT ?? 0);
            if (key === 'extraArgs') return [];
            if (key === 'executablePath') return process.env.HARNESS_EXEC ?? '';
          }
          return fallback;
        },
      };
    },
    onDidChangeWorkspaceFolders: new Emitter().event,
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel() {
      return {
        appendLine(line) {
          logs.push(String(line));
        },
        show() {},
        dispose() {},
      };
    },
    createStatusBarItem() {
      const item = { text: '', tooltip: '', name: '', command: '', show() {}, hide() {}, dispose() {} };
      statusItems.push(item);
      return item;
    },
    registerWebviewViewProvider(id, provider) {
      providers.set(id, provider);
      return disposable();
    },
    showInformationMessage(message) {
      messages.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage(message) {
      messages.push(message);
      return Promise.resolve(undefined);
    },
    setStatusBarMessage() {
      return disposable();
    },
    createTerminal(options) {
      const terminal = { options, shown: false, sent: [], show() { this.shown = true; }, sendText(t) { this.sent.push(t); }, dispose() {} };
      terminals.push(terminal);
      return terminal;
    },
  },
  commands: {
    registerCommand(id, handler) {
      commands.set(id, handler);
      return disposable(() => commands.delete(id));
    },
    async executeCommand(id, ...args) {
      const handler = commands.get(id);
      if (handler) return handler(...args);
      return undefined;
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require(BUNDLE);

const context = {
  subscriptions: [],
  extensionUri: vscodeMock.Uri.file(ROOT),
  globalState: {
    get(key) {
      return globalState.get(key);
    },
    async update(key, value) {
      globalState.set(key, value);
    },
  },
  secrets: {
    async get(key) {
      return secrets.get(key);
    },
    async store(key, value) {
      secrets.set(key, value);
    },
  },
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function fail(message) {
  console.error(`[harness] FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

(async () => {
  console.log(`[harness] workspace: ${workspaceDir}`);

  await extension.activate(context);

  const provider = providers.get('opencode-pane.view');
  if (!provider) fail('webview view provider was not registered');

  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: () => disposable(),
  };
  const view = {
    webview,
    onDidDispose: () => disposable(),
  };

  provider.resolveWebviewView(view);
  console.log('[harness] view resolved');

  if (process.env.HARNESS_EXPECT_ERROR) {
    const errorDeadline = Date.now() + 20_000;
    while (!/could not start/i.test(webview.html) && Date.now() < errorDeadline) {
      await delay(200);
    }
    if (!/could not start/i.test(webview.html)) {
      console.error(webview.html);
      fail('expected the webview to show an error screen');
    }
    console.log('[harness] error screen shown as expected');
    await extension.deactivate();
    console.log('[harness] ok');
    return;
  }

  const deadline = Date.now() + 60_000;
  while (!webview.html.includes('<iframe') && Date.now() < deadline) {
    await delay(200);
  }
  if (!webview.html.includes('<iframe')) {
    console.error(webview.html);
    fail('webview never reached the ready state');
  }

  const srcMatch = /<iframe src="([^"]+)"/.exec(webview.html);
  if (!srcMatch) fail('iframe tag missing from webview HTML');
  if (process.env.HARNESS_DUMP) {
    fs.writeFileSync(process.env.HARNESS_DUMP, webview.html);
    console.log(`[harness] dumped webview HTML to ${process.env.HARNESS_DUMP}`);
  }
  const src = srcMatch[1].replace(/&amp;/g, '&');
  console.log(`[harness] iframe src: ${src}`);

  if (!/auth_token=/.test(src)) fail('iframe src is missing auth_token');
  if (!/frame-src http:\/\/127\.0\.0\.1:\d+/.test(webview.html)) fail('CSP frame-src is missing');

  const parsed = new URL(src);
  const port = Number(parsed.port);
  if (!port) fail('iframe src has no port');

  const adminToken = await fetch(`${parsed.origin}/api/info`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${secrets.get('opencode-pane.serverPassword')}`).toString('base64')}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!adminToken.ok) fail(`/api/info returned ${adminToken.status}`);
  const info = await adminToken.json();
  console.log(`[harness] api/info: opencode ${info.version}, pid ${info.pid}`);

  const page = await fetch(src, { signal: AbortSignal.timeout(10_000) });
  const html = await page.text();
  if (!page.ok) fail(`web UI returned ${page.status}`);
  if (!/OpenCode/i.test(html)) fail('web UI HTML does not look like opencode');
  console.log(`[harness] web UI: HTTP ${page.status}, ${html.length} bytes`);

  const password = secrets.get('opencode-pane.serverPassword');
  if (!password) fail('password was not stored in SecretStorage');
  if (logs.some((line) => line.includes(password))) fail('password leaked into the output log');
  console.log(`[harness] log lines: ${logs.length}, password redacted: yes`);

  if (statusItems.length === 0) fail('status bar item was not created');
  console.log(`[harness] status bar: ${statusItems[0].text}`);

  if (!(await isPortOpen(port))) fail('server is not listening');

  // --- editor integration -------------------------------------------------
  vscodeMock.window.activeTextEditor = {
    document: { uri: Uri.file(path.join(workspaceDir, 'src', 'example.ts')) },
    selection: { isEmpty: false, start: { line: 1 }, end: { line: 4 } },
  };
  await commands.get('opencode-pane.attachSelection')();
  const mention = clipboard.at(-1);
  const expected = '@src/example.ts#L2-5';
  if (mention !== expected) fail(`attachSelection wrote ${JSON.stringify(mention)}, expected ${JSON.stringify(expected)}`);
  console.log(`[harness] attachSelection: ${mention}`);

  vscodeMock.window.activeTextEditor.selection = { isEmpty: true, start: { line: 0 }, end: { line: 0 } };
  await commands.get('opencode-pane.attachSelection')();
  if (clipboard.at(-1) !== '@src/example.ts') fail(`single-line attach wrote ${JSON.stringify(clipboard.at(-1))}`);
  console.log('[harness] attachSelection (no selection): @src/example.ts');

  await commands.get('opencode-pane.newSession')();
  const routedMatch = /<iframe src="([^"]+)"/.exec(webview.html);
  if (!routedMatch) fail('iframe missing after newSession');
  const routedSrc = routedMatch[1].replace(/&amp;/g, '&');
  if (!/\/new-session\?auth_token=/.test(routedSrc)) fail(`newSession did not navigate the iframe: ${routedSrc}`);
  if (!/frame-src http:\/\/127\.0\.0\.1:\d+/.test(webview.html)) fail('CSP frame-src broken after navigation');
  console.log(`[harness] newSession route: ${routedSrc.replace(/auth_token=.*/, 'auth_token=<redacted>')}`);

  await extension.deactivate();
  await delay(500);
  if (context.subscriptions) {
    for (const subscription of context.subscriptions) {
      try {
        subscription.dispose?.();
      } catch {}
    }
  }

  if (await isPortOpen(port)) fail('server still listening after deactivate()');
  console.log('[harness] server stopped after deactivate()');

  if (messages.some((m) => /could not|failed|error/i.test(m))) {
    fail(`unexpected error message: ${messages.join(' | ')}`);
  }

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  console.log('[harness] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  void extension.deactivate?.();
});
