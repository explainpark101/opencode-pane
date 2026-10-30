/**
 * Tiny unified-diff helper.
 *
 * opencode's `/api/session/:id/diff` returns full-file unified patches. To show a
 * change in Cursor's native diff editor we need the file *before* opencode touched
 * it, which we reconstruct by reverse-applying the patch to the current contents.
 * No dependency, no git required.
 */

interface HunkLine {
  kind: 'context' | 'old' | 'new';
  text: string;
}

interface Hunk {
  /** 1-based start line on the old side, from the `@@ -a,b +c,d @@` header. */
  oldStart: number;
  lines: HunkLine[];
}

const HUNK_RE = /^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:\d+)?\s*@@/;

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;

  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const match = HUNK_RE.exec(raw);
      current = { oldStart: match ? Number(match[1]) : 0, lines: [] };
      hunks.push(current);
      continue;
    }

    if (!current) {
      // File headers (`---`, `+++`, `diff --git`, `index`) before the first hunk.
      continue;
    }

    if (raw.startsWith('diff ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      current = undefined;
      continue;
    }

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    }

    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'new', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'old', text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: raw.slice(1) });
    } else if (raw === '') {
      current.lines.push({ kind: 'context', text: '' });
    } else {
      current = undefined;
    }
  }

  return hunks.filter((hunk) => hunk.lines.length > 0);
}

function findSequence(lines: string[], target: string[], from: number): number {
  if (target.length === 0) {
    return Math.min(from, lines.length);
  }
  outer: for (let start = Math.max(0, from); start + target.length <= lines.length; start += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (lines[start + offset] !== target[offset]) {
        continue outer;
      }
    }
    return start;
  }
  return -1;
}

/**
 * Reverse-apply a unified diff: returns the contents the file had before the patch.
 * Throws when the patch does not line up with `current`.
 */
export function reverseApply(current: string, patch: string): string {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) {
    return current;
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(current);
  const lines = current.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  let cursor = 0;
  for (const hunk of hunks) {
    const target = hunk.lines.filter((line) => line.kind !== 'old').map((line) => line.text);
    const replacement = hunk.lines.filter((line) => line.kind !== 'new').map((line) => line.text);

    let at = findSequence(lines, target, cursor);
    if (at < 0) {
      const fallback = hunk.oldStart > 0 ? hunk.oldStart - 1 : cursor;
      at = findSequence(lines, target, Math.max(0, fallback));
    }
    if (at < 0) {
      throw new Error('patch does not apply to the current file contents');
    }

    lines.splice(at, target.length, ...replacement);
    cursor = at + replacement.length;
  }

  let result = lines.join(newline);
  if (hadTrailingNewline && result.length > 0) {
    result += newline;
  }
  return result;
}
