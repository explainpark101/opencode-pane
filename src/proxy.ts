import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import * as zlib from 'node:zlib';
import type * as vscode from 'vscode';
import type { ServerInfo } from './server';

export const BRIDGE_PATH = '/__opencode-pane/bridge.js';

const MAX_HTML_BYTES = 8 * 1024 * 1024;

function isHtml(contentType: string | undefined): boolean {
  return !!contentType && /^text\/html\b/i.test(contentType);
}

function injectBridge(html: string): string {
  if (html.includes(BRIDGE_PATH)) {
    return html;
  }
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) {
    return `${html.slice(0, head)}${tag}${html.slice(head)}`;
  }
  return `${tag}${html}`;
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(body);
    case 'deflate':
      return zlib.inflateSync(body);
    case 'br':
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

function rewriteHeader(value: string, upstream: URL): string {
  try {
    const parsed = new URL(value);
    return `${upstream.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return value;
  }
}

/**
 * A tiny transparent HTTP proxy in front of the local opencode server.
 *
 * The opencode web UI is a cross-origin iframe from the extension webview, so
 * the webview cannot inject a keyboard/drag bridge into it. Serving the UI
 * through this proxy gives us a same-origin document to inject `bridge.js`
 * into, while every asset/API/WebSocket request is forwarded unchanged.
 */
export class OpencodeProxy implements vscode.Disposable {
  private server?: http.Server;
  private port?: number;
  private readonly sockets = new Set<net.Socket>();
  private readonly upstream: URL;

  constructor(
    private readonly info: ServerInfo,
    private readonly log: vscode.OutputChannel,
    private readonly bridgeScript: string,
  ) {
    this.upstream = new URL(info.url);
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }

  async start(): Promise<string> {
    if (this.server && this.url) {
      return this.url;
    }

    const server = http.createServer((request, response) => this.handle(request, response));
    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('could not allocate a proxy port');
    }

    this.server = server;
    this.port = address.port;
    const url = `http://127.0.0.1:${address.port}`;
    this.log.appendLine(`[proxy] ${url} -> ${this.info.url}`);
    return url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  dispose(): void {
    void this.stop();
  }

  private target(requestUrl: string | undefined): URL {
    const parsed = new URL(requestUrl ?? '/', 'http://localhost');
    return new URL(`${parsed.pathname}${parsed.search}`, this.upstream);
  }

  private headers(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        continue;
      }
      switch (key.toLowerCase()) {
        case 'host':
        case 'connection':
        case 'keep-alive':
        case 'proxy-connection':
        case 'transfer-encoding':
        case 'accept-encoding':
          continue;
        default:
          headers[key] = value;
      }
    }
    headers.host = this.upstream.host;
    headers['accept-encoding'] = 'identity';
    if (typeof headers.origin === 'string') {
      headers.origin = this.upstream.origin;
    }
    if (typeof headers.referer === 'string') {
      headers.referer = rewriteHeader(headers.referer, this.upstream);
    }
    return headers;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const requestUrl = request.url ?? '/';
    if (requestUrl.split('?')[0] === BRIDGE_PATH) {
      const body = Buffer.from(this.bridgeScript, 'utf8');
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    const target = this.target(request.url);
    const transport = this.upstream.protocol === 'https:' ? https : http;
    const proxy = transport.request(
      {
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: this.headers(request.headers),
      },
      (upstream) => this.respond(response, upstream),
    );

    proxy.on('error', (error) => {
      this.log.appendLine(`[proxy] ${request.method ?? 'GET'} ${requestUrl} failed: ${error.message}`);
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('opencode proxy request failed');
    });
    request.on('aborted', () => proxy.destroy());
    request.pipe(proxy);
  }

  private respond(response: http.ServerResponse, upstream: http.IncomingMessage): void {
    const contentType = upstream.headers['content-type'];
    if (!isHtml(contentType)) {
      response.writeHead(upstream.statusCode ?? 200, upstream.headers);
      upstream.pipe(response);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    upstream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTML_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    upstream.on('end', () => {
      if (tooLarge) {
        this.log.appendLine('[proxy] HTML document too large to inject the bridge');
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('opencode HTML document is too large to inject the bridge');
        return;
      }

      let body: Buffer;
      try {
        body = decodeBody(Buffer.concat(chunks), upstream.headers['content-encoding'] as string | undefined);
      } catch (error) {
        this.log.appendLine(
          `[proxy] could not decode HTML (${error instanceof Error ? error.message : String(error)})`,
        );
        response.writeHead(upstream.statusCode ?? 200, upstream.headers);
        response.end(Buffer.concat(chunks));
        return;
      }

      const html = injectBridge(body.toString('utf8'));
      const output = Buffer.from(html, 'utf8');
      const headers = { ...upstream.headers };
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['content-encoding'];
      headers['content-length'] = String(output.length);
      response.writeHead(upstream.statusCode ?? 200, headers);
      response.end(output);
    });

    upstream.on('error', () => response.destroy());
  }

  private handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.upstream.protocol !== 'http:') {
      socket.destroy();
      return;
    }

    const target = this.target(request.url);
    const upstream = net.connect(
      Number(this.upstream.port || 80),
      this.upstream.hostname,
      () => {
        const headers = this.headers(request.headers);
        headers.connection = 'Upgrade';
        headers.upgrade = request.headers.upgrade ?? 'websocket';
        const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`];
        for (const [key, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) lines.push(`${key}: ${item}`);
          } else {
            lines.push(`${key}: ${value}`);
          }
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );

    this.sockets.add(upstream);
    upstream.once('close', () => this.sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }
}
