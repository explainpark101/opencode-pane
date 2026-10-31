import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OpencodeApi } from './api';
import { reviewChanges } from './review';
import { OpencodeServer, workspaceCwd, type ServerInfo } from './server';
import { OpencodeViewProvider } from './webview';

let activeServer: OpencodeServer | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('opencode');
  context.subscriptions.push(log);

  const server = new OpencodeServer(context, log);
  activeServer = server;
  context.subscriptions.push(server);

  const provider = new OpencodeViewProvider(server, log, context);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OpencodeViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  let lastEditor = vscode.window.activeTextEditor;
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          lastEditor = editor;
        }
      }),
    );
  }

  const status = vscode.window.createStatusBarItem('opencode-pane.status', vscode.StatusBarAlignment.Right, 99);
  status.name = 'opencode';
  status.command = 'opencode-pane.open';
  status.show();
  context.subscriptions.push(status);

  const updateStatus = (): void => {
    const snapshot = server.state;
    switch (snapshot.status) {
      case 'ready':
        status.text = `$(comment-discussion) opencode ${snapshot.info.port}`;
        status.tooltip = `opencode is running at ${snapshot.info.url}\nproject: ${snapshot.info.cwd}\nClick to open the pane.`;
        break;
      case 'starting':
        status.text = '$(loading~spin) opencode';
        status.tooltip = 'Starting the opencode server…';
        break;
      case 'error':
        status.text = '$(warning) opencode';
        status.tooltip = `${snapshot.message}\nClick to open the pane.`;
        break;
      default:
        status.text = '$(comment-discussion) opencode';
        status.tooltip = 'opencode is stopped. Click to open the pane.';
        break;
    }
  };

  context.subscriptions.push(server.onDidChange(updateStatus));
  updateStatus();

  const focusView = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand('opencode-pane.view.focus');
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.opencodePaneContainer');
    }
  };

  const ensureServer = async (): Promise<ServerInfo> => {
    const snapshot = server.state;
    if (snapshot.status === 'ready') {
      const cwd = workspaceCwd();
      if (snapshot.info.cwd !== cwd) {
        log.appendLine(`[server] project changed (${snapshot.info.cwd} -> ${cwd}), restarting`);
        provider.workspaceChanged();
        return server.restart();
      }
      return snapshot.info;
    }
    return server.start();
  };

  const createSession = async (info: ServerInfo): Promise<string> => {
    const api = new OpencodeApi(info, log);
    const session = await api.createSession(info.cwd);
    return session.id;
  };

  /**
   * Copies the mention to the clipboard and inserts it into the opencode
   * composer. If the pane is not on a session yet, a session is created first.
   */
  const attachMention = async (mention: string): Promise<void> => {
    await vscode.env.clipboard.writeText(mention);

    let inserted = false;
    try {
      const info = await ensureServer();
      await focusView();
      inserted = await provider.attachText(mention);

      if (!inserted && !provider.hasSessionRoute()) {
        const sessionID = await createSession(info);
        await provider.showSession(info, sessionID);
        inserted = await provider.attachText(mention);
      }
    } catch (error) {
      log.appendLine(`[command] attach failed: ${errorMessage(error)}`);
    }

    if (inserted) {
      vscode.window.setStatusBarMessage(`opencode: ${mention} 첨부됨`, 6_000);
    } else {
      vscode.window.setStatusBarMessage(
        `opencode: ${mention} 복사됨 — 패널 입력창에서 Ctrl+V`,
        10_000,
      );
    }
  };

  const toMention = (fsPath: string): string => {
    const normalized = path.normalize(fsPath);
    const folders =
      vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file') ?? [];

    let best: string | undefined;
    for (const folder of folders) {
      const relative = path.relative(folder.uri.fsPath, normalized);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }
      if (!best || relative.length < best.length) {
        best = relative;
      }
    }

    const target = best ?? normalized;
    return `@${target.split(path.sep).join('/')}`;
  };

  const attachPaths = async (paths: unknown): Promise<void> => {
    const list = Array.isArray(paths)
      ? paths.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : typeof paths === 'string' && paths.length > 0
        ? [paths]
        : [];

    if (list.length === 0) {
      void vscode.window.showWarningMessage('opencode: 첨부할 파일 경로가 없습니다.');
      return;
    }

    await attachMention(list.map(toMention).join(' '));
  };

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('opencode-pane.open', async () => {
    await focusView();
  });

  register('opencode-pane.newSession', async () => {
    try {
      const info = await ensureServer();
      const sessionID = await createSession(info);
      await focusView();
      await provider.showSession(info, sessionID);
      vscode.window.setStatusBarMessage(`opencode: ${path.basename(info.cwd)}에서 새 세션`, 5_000);
    } catch (error) {
      const detail = errorMessage(error);
      log.appendLine(`[command] new session failed: ${detail}`);
      void vscode.window.showErrorMessage(`opencode: ${detail}`);
    }
  });

  register('opencode-pane.attachSelection', async () => {
    const editor = vscode.window.activeTextEditor ?? lastEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('opencode: 첨부할 편집기가 없습니다.');
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
      void vscode.window.showWarningMessage('opencode: 워크스페이스 안의 파일만 첨부할 수 있습니다.');
      return;
    }

    let relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
    const selection = editor.selection;
    if (selection && !selection.isEmpty) {
      const start = selection.start.line + 1;
      const end = selection.end.line + 1;
      relative += start === end ? `#L${start}` : `#L${start}-${end}`;
    }

    await attachMention(`@${relative}`);
  });

  register('opencode-pane.attachPaths', async (paths) => {
    await attachPaths(paths);
  });

  register('opencode-pane.reviewChanges', async () => {
    try {
      const info = await ensureServer();
      const api = new OpencodeApi(info, log);
      await reviewChanges({
        api,
        directory: info.cwd,
        storageRoot: context.globalStorageUri.fsPath,
        log,
      });
    } catch (error) {
      const detail = errorMessage(error);
      log.appendLine(`[command] review changes failed: ${detail}`);
      void vscode.window.showErrorMessage(`opencode: ${detail}`);
    }
  });

  register('opencode-pane.restartServer', async () => {
    try {
      const info = await server.restart();
      vscode.window.setStatusBarMessage(`opencode restarted on port ${info.port}`, 4_000);
    } catch (error) {
      const detail = errorMessage(error);
      log.appendLine(`[command] restart failed: ${detail}`);
      void vscode.window.showErrorMessage(`opencode: ${detail}`);
    }
  });

  register('opencode-pane.stopServer', async () => {
    if (server.state.status === 'stopped') {
      vscode.window.setStatusBarMessage('opencode is already stopped', 3_000);
      return;
    }
    await server.stop();
    vscode.window.setStatusBarMessage('opencode server stopped', 3_000);
  });

  register('opencode-pane.showLogs', () => {
    log.show(true);
  });

  register('opencode-pane.openInBrowser', async () => {
    try {
      const info = await ensureServer();
      const url = `${info.url}/?auth_token=${encodeURIComponent(info.authToken)}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      const detail = errorMessage(error);
      void vscode.window.showErrorMessage(`opencode: ${detail}`);
    }
  });

  register('opencode-pane.openTuiInTerminal', () => {
    const cwd =
      server.cwd ??
      vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri.fsPath ??
      os.homedir();
    const terminal = vscode.window.createTerminal({
      name: 'opencode',
      cwd,
      iconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'opencode.svg'),
    });
    terminal.show();
    terminal.sendText('opencode');
  });

  register('opencode-pane.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.opencode-pane');
  });

  context.subscriptions.push(
    provider.onDidDrop((paths) => {
      void vscode.commands.executeCommand('opencode-pane.attachPaths', paths);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      log.appendLine(`[server] workspace folders changed, target cwd is now ${workspaceCwd()}`);
      const snapshot = server.state;
      if (snapshot.status === 'ready' || snapshot.status === 'starting') {
        provider.workspaceChanged();
        try {
          await server.restart();
        } catch (error) {
          log.appendLine(`[server] restart after workspace change failed: ${errorMessage(error)}`);
        }
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  const server = activeServer;
  activeServer = undefined;
  await server?.stop();
}
