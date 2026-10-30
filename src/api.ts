import type * as vscode from 'vscode';
import type { ServerInfo } from './server';

export interface SessionSummary {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

export interface LocationInfo {
  directory: string;
  project?: { id: string; directory: string; canonical: string };
}

interface ListResponse<T> {
  data?: T[];
}

function unwrap<T>(body: unknown): T | undefined {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data?: T }).data;
  }
  return undefined;
}

/** Minimal authenticated client for the local `opencode serve` HTTP API. */
export class OpencodeApi {
  private readonly authorization: string;

  constructor(
    private readonly info: ServerInfo,
    private readonly log: vscode.OutputChannel,
  ) {
    this.authorization = `Basic ${Buffer.from(`opencode:${info.password}`, 'utf8').toString('base64')}`;
  }

  get url(): string {
    return this.info.url;
  }

  get cwd(): string {
    return this.info.cwd;
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
    const response = await fetch(`${this.info.url}${path}`, {
      ...init,
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      const snippet = text.slice(0, 300).replace(/\s+/g, ' ');
      throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
    }

    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${path} returned non-JSON content`);
    }
  }

  async location(): Promise<LocationInfo> {
    return this.request<LocationInfo>('/api/location');
  }

  async listSessions(options: { directory?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams({ order: 'desc', limit: String(options.limit ?? 10) });
    if (options.directory) {
      params.set('directory', options.directory);
    }
    const body = await this.request<ListResponse<SessionSummary>>(`/api/session?${params.toString()}`);
    return unwrap<SessionSummary[]>(body) ?? [];
  }

  async createSession(directory: string, title?: string): Promise<SessionSummary> {
    const payload = JSON.stringify({ location: { directory }, ...(title ? { title } : {}) });
    const body = await this.request<unknown>('/api/session', { method: 'POST', body: payload });
    const session = unwrap<SessionSummary>(body) ?? (body as SessionSummary | undefined);
    if (!session?.id) {
      throw new Error('opencode did not return a session id');
    }
    return session;
  }

  async sessionDiff(sessionID: string): Promise<FileDiff[]> {
    const body = await this.request<ListResponse<FileDiff>>(`/api/session/${encodeURIComponent(sessionID)}/diff`);
    return unwrap<FileDiff[]>(body) ?? [];
  }

  async prompt(sessionID: string, text: string): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  logFailure(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(`[api] ${what} failed: ${message}`);
  }
}
