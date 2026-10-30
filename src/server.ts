import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as os from 'node:os';
import * as vscode from 'vscode';

export interface ServerInfo {
  /** Base URL of the running server, e.g. http://127.0.0.1:47821 */
  url: string;
  port: number;
  /** Server password. Never log this. */
  password: string;
  /** base64url("opencode:<password>") used by the web UI's ?auth_token= parameter. */
  authToken: string;
  cwd: string;
  version?: string;
  /** PID reported by the server itself (may differ from the spawned shim). */
  pid?: number;
}

export type ServerSnapshot =
  | { status: 'stopped' }
  | { status: 'starting'; cwd: string }
  | { status: 'ready'; info: ServerInfo }
  | { status: 'error'; message: string; detail?: string };

const SECRET_KEY = 'opencode-pane.serverPassword';
const START_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;

const URL_RE = /server listening on\s+(https?:\/\/[^\s]+)/i;
const ANY_URL_RE = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(line: string): string {
  return line.replace(/(password\s*[:=]?\s*)(\S+)/gi, '$1<redacted>');
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder?.uri.scheme === 'file') {
    return folder.uri.fsPath;
  }
  return os.homedir();
}

function resolveExecutable(override: string): string {
  if (override) {
    return override;
  }

  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const target = process.platform === 'win32' ? 'opencode' : 'opencode';
  try {
    const output = execFileSync(finder, [target], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first) {
      return first;
    }
  } catch {
    // Not on PATH. Let spawn produce the error and surface it to the user.
  }

  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('exit', finish);
      killer.once('error', finish);
      setTimeout(finish, 5_000);
    });
  }

  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface ApiInfo {
  version?: string;
  pid?: number;
}

async function fetchApiInfo(url: string, password: string): Promise<ApiInfo> {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
  const response = await fetch(`${url}/api/info`, {
    headers: { authorization },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as ApiInfo;
  return { version: body.version, pid: body.pid };
}

async function waitForApiInfo(
  url: string,
  password: string,
  aborted: () => boolean,
): Promise<ApiInfo> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (aborted()) {
      throw new Error('opencode exited while starting up.');
    }
    try {
      return await fetchApiInfo(url, password);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
  }

  throw new Error(
    `opencode did not become ready within ${READY_TIMEOUT_MS / 1000}s (last error: ${lastError}).`,
  );
}

export class OpencodeServer implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ServerSnapshot>();
  readonly onDidChange = this.emitter.event;

  private child?: ChildProcess;
  private info?: ServerInfo;
  private snapshot: ServerSnapshot = { status: 'stopped' };
  private pending?: Promise<ServerInfo>;
  private generation = 0;
  private disposed = false;
  private lastCwd?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {}

  get state(): ServerSnapshot {
    return this.snapshot;
  }

  /** Working directory the server was last started in. */
  get cwd(): string | undefined {
    return this.lastCwd;
  }

  async start(): Promise<ServerInfo> {
    if (this.disposed) {
      throw new Error('opencode server manager is disposed.');
    }
    if (this.info) {
      return this.info;
    }
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.launch().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    this.info = undefined;

    try {
      if (child) {
        this.log.appendLine('[server] stopping');
        await killProcessTree(child);
      }
    } finally {
      if (!this.disposed) {
        this.setState({ status: 'stopped' });
      }
    }
  }

  async restart(): Promise<ServerInfo> {
    await this.stop();
    return this.start();
  }

  private setState(snapshot: ServerSnapshot): void {
    this.snapshot = snapshot;
    if (!this.disposed) {
      this.emitter.fire(snapshot);
    }
  }

  private async getPassword(): Promise<string> {
    try {
      const existing = await this.context.secrets.get(SECRET_KEY);
      if (existing) {
        return existing;
      }
      const created = crypto.randomBytes(32).toString('base64url');
      await this.context.secrets.store(SECRET_KEY, created);
      return created;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.appendLine(`[server] secret storage unavailable (${message}); using a session password`);
      return crypto.randomBytes(32).toString('base64url');
    }
  }

  private async launch(): Promise<ServerInfo> {
    try {
      return await this.launchInner();
    } catch (error) {
      if (!this.disposed && this.snapshot.status === 'starting') {
        this.setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async launchInner(): Promise<ServerInfo> {
    const generation = ++this.generation;
    const cwd = workspaceCwd();
    this.lastCwd = cwd;
    this.setState({ status: 'starting', cwd });

    if (vscode.env.remoteName) {
      throw new Error(
        `Remote windows are not supported yet (remoteName: ${vscode.env.remoteName}). Open the folder locally.`,
      );
    }

    const config = vscode.workspace.getConfiguration('opencode-pane');
    const executable = resolveExecutable(String(config.get<string>('executablePath', '') ?? '').trim());
    const password = await this.getPassword();
    const extraArgs = (config.get<string[]>('extraArgs', []) ?? []).filter(
      (arg): arg is string => typeof arg === 'string',
    );

    const preferredPort = Math.max(0, Math.floor(Number(config.get<number>('port', 0)) || 0));
    let port = 0;
    if (preferredPort > 0) {
      if (await isPortFree(preferredPort)) {
        port = preferredPort;
      } else {
        this.log.appendLine(`[server] port ${preferredPort} is in use, falling back to a random port`);
      }
    }

    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', ...extraArgs];

    this.log.appendLine(`[server] spawn ${quote(executable)} ${args.join(' ')}`);
    this.log.appendLine(`[server] cwd ${cwd}`);

    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;

    let stderrTail = '';
    let urlFound = false;
    let resolveUrl: (url: string) => void = () => {};
    let rejectUrl: (error: Error) => void = () => {};
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    const startTimer = setTimeout(() => {
      if (!urlFound) {
        rejectUrl(new Error(`Timed out after ${START_TIMEOUT_MS / 1000}s waiting for opencode to start.`));
      }
    }, START_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        this.log.appendLine(`[out] ${redact(line)}`);
        if (urlFound) continue;
        const match = URL_RE.exec(line) ?? ANY_URL_RE.exec(line);
        if (match) {
          urlFound = true;
          clearTimeout(startTimer);
          resolveUrl(match[1].replace(/\/+$/, ''));
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.replace(/\u001b\[[0-9;]*m/g, '');
      stderrTail = (stderrTail + text).slice(-8_000);
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line) {
          this.log.appendLine(`[err] ${redact(line)}`);
        }
      }
    });

    child.once('error', (error) => {
      clearTimeout(startTimer);
      this.log.appendLine(`[server] spawn failed: ${error.message}`);
      if (!urlFound) {
        rejectUrl(new Error(`Could not run "${executable}": ${error.message}`));
      }
    });

    child.once('exit', (code, signal) => {
      clearTimeout(startTimer);
      const reason = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
      this.log.appendLine(`[server] exited (${reason})`);
      if (!urlFound) {
        rejectUrl(new Error(`opencode exited (${reason}) before it was ready.`));
      }

      const wasReady = this.info !== undefined;
      if (this.child === child) {
        this.child = undefined;
        this.info = undefined;
      }

      if (generation !== this.generation) {
        return;
      }

      this.setState({
        status: 'error',
        message: wasReady
          ? `opencode stopped unexpectedly (${reason}).`
          : `opencode failed to start (${reason}).`,
        detail: stderrTail.trim() || undefined,
      });
    });

    let url: string;
    try {
      url = await urlPromise;
    } catch (error) {
      await killProcessTree(child);
      throw error;
    }

    if (generation !== this.generation) {
      await killProcessTree(child);
      throw new Error('opencode server start was cancelled.');
    }

    let api: ApiInfo;
    try {
      api = await waitForApiInfo(url, password, () => this.child !== child);
    } catch (error) {
      await killProcessTree(child);
      throw error;
    }

    if (generation !== this.generation) {
      await killProcessTree(child);
      throw new Error('opencode server start was cancelled.');
    }

    const parsed = new URL(url);
    const info: ServerInfo = {
      url,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
      password,
      authToken: Buffer.from(`opencode:${password}`, 'utf8').toString('base64url'),
      cwd,
      version: api.version,
      pid: api.pid,
    };

    this.info = info;
    this.setState({ status: 'ready', info });
    this.log.appendLine(
      `[server] ready ${url} (opencode ${api.version ?? 'unknown'}, pid ${api.pid ?? 'unknown'})`,
    );
    return info;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    this.info = undefined;
    if (child) {
      void killProcessTree(child);
    }
    this.emitter.dispose();
  }
}
