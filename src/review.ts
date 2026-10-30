import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OpencodeApi, type FileDiff, type SessionSummary } from './api';
import { reverseApply } from './patch';

const MAX_FILES = 8;
const SESSIONS_TO_PROBE = 5;

function relPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : target;
}

function sanitize(relative: string): string {
  return relative.replace(/^([/\\])+/, '').split(/[/\\]+/).filter((part) => part && part !== '..').join(path.sep);
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function describe(session: SessionSummary): string {
  const title = session.title?.trim();
  return title && title.length > 0 ? title : session.id;
}

async function pickSession(api: OpencodeApi, directory: string): Promise<{ session: SessionSummary; diffs: FileDiff[] } | undefined> {
  const sessions = await api.listSessions({ directory, limit: SESSIONS_TO_PROBE });
  for (const session of sessions) {
    const diffs = await api.sessionDiff(session.id).catch(() => [] as FileDiff[]);
    if (diffs.length > 0) {
      return { session, diffs };
    }
  }
  return undefined;
}

export interface ReviewRequest {
  api: OpencodeApi;
  directory: string;
  storageRoot: string;
  log: vscode.OutputChannel;
}

/**
 * Opens the files changed by the newest opencode session in Cursor's native diff
 * editor, reconstructed from `GET /api/session/:id/diff`.
 *
 * The right-hand side is the real file on disk, so the diff editor's revert arrows
 * work per hunk — the closest thing VS Code has to "accept / reject changes".
 */
export async function reviewChanges(request: ReviewRequest): Promise<void> {
  const { api, directory, storageRoot, log } = request;

  const found = await pickSession(api, directory);
  if (!found) {
    void vscode.window.showInformationMessage(
      `opencode: "${path.basename(directory)}" 프로젝트에 아직 검토할 변경 사항이 없습니다.`,
    );
    return;
  }

  const { session, diffs } = found;
  const shown = diffs.slice(0, MAX_FILES);
  const stamp = Date.now().toString(36);
  const workspace = path.join(storageRoot, 'review', stamp);
  await fs.mkdir(workspace, { recursive: true });

  let opened = 0;
  for (const diff of shown) {
    const absolute = path.isAbsolute(diff.file) ? diff.file : path.join(directory, diff.file);
    const relative = relPath(directory, absolute);
    const safe = sanitize(relative);

    const after = diff.status === 'deleted' ? '' : await readIfExists(absolute);
    let before: string;
    try {
      before = diff.status === 'added' ? '' : reverseApply(after, diff.patch);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.appendLine(`[review] could not reconstruct ${relative}: ${detail}`);
      const patchFile = path.join(workspace, `${safe.replace(/[/\\]/g, '__')}.diff`);
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, diff.patch, 'utf8');
      await vscode.window.showTextDocument(vscode.Uri.file(patchFile), { preview: false });
      opened += 1;
      continue;
    }

    const beforeFile = path.join(workspace, 'before', safe);
    await fs.mkdir(path.dirname(beforeFile), { recursive: true });
    await fs.writeFile(beforeFile, before, 'utf8');

    let rightFile = absolute;
    if (diff.status === 'deleted') {
      rightFile = path.join(workspace, 'after', safe);
      await fs.mkdir(path.dirname(rightFile), { recursive: true });
      await fs.writeFile(rightFile, '', 'utf8');
    }

    const title = `opencode: ${relative} (+${diff.additions} -${diff.deletions})`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(beforeFile),
      vscode.Uri.file(rightFile),
      title,
      { preview: false },
    );
    opened += 1;
  }

  const extra = diffs.length - shown.length;
  const suffix = extra > 0 ? ` (외 ${extra}개 파일 생략)` : '';
  void vscode.window.showInformationMessage(
    `opencode: ${opened}개 파일 변경 — "${describe(session)}"${suffix}. diff 편집기의 되돌리기 화살표로 부분 취소할 수 있습니다.`,
  );
}
