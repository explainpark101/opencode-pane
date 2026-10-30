import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { OpencodeServer, ServerInfo, ServerSnapshot } from './server';

const DRAG_HINT_KEY = 'opencode-pane.dragHintShown';

interface WebviewMessage {
  type?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function iframeUrl(info: ServerInfo, route: string | undefined): string {
  const path = route && route.startsWith('/') ? route : '/';
  return `${info.url}${path}?auth_token=${encodeURIComponent(info.authToken)}`;
}

function defaultCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.scheme === 'file');
  return folder?.uri.fsPath ?? os.homedir();
}

function signature(snapshot: ServerSnapshot): string {
  switch (snapshot.status) {
    case 'ready':
      return `ready:${snapshot.info.url}:${snapshot.info.authToken}`;
    case 'starting':
      return `starting:${snapshot.cwd}`;
    case 'error':
      return `error:${snapshot.message}:${snapshot.detail ?? ''}`;
    default:
      return 'stopped';
  }
}

export class OpencodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode-pane.view';

  private view?: vscode.WebviewView;
  private renderedKey?: string;
  private route?: string;
  private routeUrl?: string;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly server: OpencodeServer,
    private readonly log: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      this.server.onDidChange((snapshot) => {
        if (snapshot.status === 'ready') {
          if (this.routeUrl && this.routeUrl !== snapshot.info.url) {
            this.route = undefined;
          }
          this.routeUrl = snapshot.info.url;
        } else {
          this.route = undefined;
          this.routeUrl = undefined;
        }
        this.render(snapshot);
      }),
    );
  }

  /**
   * Navigates the embedded web UI to a route such as `/new-session` by reloading the
   * iframe with the auth token. Only meaningful once the server is ready.
   */
  showRoute(route: string): void {
    this.route = route;
    this.renderedKey = undefined;
    this.render(this.server.state);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.renderedKey = undefined;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    view.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void this.handleMessage(message);
      },
      undefined,
      this.disposables,
    );

    view.onDidDispose(
      () => {
        if (this.view === view) {
          this.view = undefined;
        }
      },
      undefined,
      this.disposables,
    );

    this.render(
      this.server.state.status === 'stopped'
        ? { status: 'starting', cwd: defaultCwd() }
        : this.server.state,
    );
    void this.ensureStarted();
    void this.showDragHint();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message?.type) {
      case 'retry':
        try {
          await this.server.restart();
        } catch (error) {
          this.log.appendLine(
            `[view] retry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case 'start':
        try {
          await this.server.start();
        } catch (error) {
          this.log.appendLine(
            `[view] start failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case 'logs':
        this.log.show(true);
        break;
      case 'settings':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:local.opencode-pane',
        );
        break;
      case 'tui':
        void vscode.commands.executeCommand('opencode-pane.openTuiInTerminal');
        break;
      default:
        break;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.server.state.status !== 'stopped') {
      return;
    }
    try {
      await this.server.start();
    } catch (error) {
      this.log.appendLine(
        `[view] start failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async showDragHint(): Promise<void> {
    if (this.context.globalState.get<boolean>(DRAG_HINT_KEY)) {
      return;
    }
    await this.context.globalState.update(DRAG_HINT_KEY, true);
    void vscode.window.showInformationMessage(
      'opencode is running in the sidebar. To dock it, drag the opencode icon from the Activity Bar onto the right sidebar (or right-click it and choose "Move View Container To").',
      'Got it',
    );
  }

  private render(snapshot: ServerSnapshot): void {
    const view = this.view;
    if (!view) {
      return;
    }

    const key = `${signature(snapshot)}|${this.route ?? '/'}`;
    if (key === this.renderedKey) {
      return;
    }
    this.renderedKey = key;
    view.webview.html = this.html(snapshot);
  }

  private html(snapshot: ServerSnapshot): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const frameSource =
      snapshot.status === 'ready' ? new URL(snapshot.info.url).origin : "'none'";

    const policy = [
      "default-src 'none'",
      'img-src data:',
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      `frame-src ${frameSource}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode</title>
<style>
  :root { color-scheme: light dark; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
  }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--vscode-editor-background);
  }
  .pane {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: 1.05em;
    font-weight: 600;
  }
  p {
    margin: 0;
    max-width: 44ch;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    overflow-wrap: anywhere;
  }
  code, pre {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }
  pre {
    box-sizing: border-box;
    max-width: 100%;
    max-height: 220px;
    overflow: auto;
    margin: 4px 0 0;
    padding: 8px 10px;
    text-align: left;
    white-space: pre-wrap;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
    color: var(--vscode-foreground);
  }
  details {
    max-width: 100%;
  }
  summary {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 4px;
  }
  button {
    font: inherit;
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .spinner {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2.4s; }
  }
  .hint {
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
${this.body(snapshot)}
<script nonce="${nonce}">
  (function () {
    const api = acquireVsCodeApi();
    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-action]');
      if (!button) return;
      const action = button.getAttribute('data-action');
      if (!action) return;
      api.postMessage({ type: action });
    });
  })();
</script>
</body>
</html>`;
  }

  private body(snapshot: ServerSnapshot): string {
    switch (snapshot.status) {
      case 'ready': {
        const src = escapeHtml(iframeUrl(snapshot.info, this.route));
        return `<iframe src="${src}" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer" title="opencode"></iframe>`;
      }
      case 'starting':
        return `<div class="pane">
  <div class="spinner" role="status" aria-label="Starting"></div>
  <h1>Starting opencode…</h1>
  <p>Launching the local server in <code>${escapeHtml(snapshot.cwd)}</code></p>
</div>`;
      case 'error':
        return `<div class="pane">
  <h1>opencode could not start</h1>
  <p>${escapeHtml(snapshot.message)}</p>
  ${
    snapshot.detail
      ? `<details><summary>Show details</summary><pre>${escapeHtml(snapshot.detail)}</pre></details>`
      : ''
  }
  <div class="actions">
    <button class="primary" data-action="retry">Retry</button>
    <button data-action="logs">Show logs</button>
    <button data-action="settings">Settings</button>
    <button data-action="tui">Open TUI in terminal</button>
  </div>
</div>`;
      default:
        return `<div class="pane">
  <h1>opencode is stopped</h1>
  <p>The local opencode server is not running.</p>
  <div class="actions">
    <button class="primary" data-action="start">Start server</button>
    <button data-action="logs">Show logs</button>
    <button data-action="tui">Open TUI in terminal</button>
  </div>
  <p class="hint">Tip: drag this view onto the right sidebar to dock it beside the agent chat.</p>
</div>`;
    }
  }
}
