import * as http from 'node:http';
import * as https from 'node:https';

export interface DaemonStatus {
  phase?: string;
  project?: {
    projectName?: string;
    projectId?: string;
    serverUrl?: string;
  };
  pendingPaths?: string[];
  conflicts?: unknown[];
  latestCompile?: {
    buildId?: string;
    completedAt?: string;
    pdfPath?: string;
  };
  lastSyncAt?: string;
  lastError?: string;
  [key: string]: unknown;
}

export class OfsyncClient {
  public constructor(private readonly serverUrl: string) {}

  public async health(): Promise<void> {
    await this.request<unknown>('GET', '/api/health');
  }

  public status(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>('GET', '/api/status');
  }

  public sync(): Promise<unknown> {
    return this.request<unknown>('POST', '/api/sync');
  }

  public compile(): Promise<unknown> {
    return this.request<unknown>('POST', '/api/compile');
  }

  public syncCode(file: string, line: number, column: number, buildId: string): Promise<unknown> {
    return this.request<unknown>('POST', '/api/synctex/code', { file, line, column, buildId }, 5_000);
  }

  public syncPdf(page: number, h: number, v: number, buildId: string): Promise<unknown> {
    return this.request<unknown>('POST', '/api/synctex/pdf', { page, h: roundSyncTexCoordinate(h), v: roundSyncTexCoordinate(v), buildId }, 5_000);
  }

  public pdfUrl(cacheBust = false): string {
    const url = new URL('/api/pdf', this.serverUrl);
    if (cacheBust) {
      url.searchParams.set('t', String(Date.now()));
    }
    return url.toString();
  }

  public pdf(cacheBust = true): Promise<Uint8Array> {
    const url = new URL('/api/pdf', this.serverUrl);
    if (cacheBust) {
      url.searchParams.set('t', String(Date.now()));
    }
    const transport = url.protocol === 'https:' ? https.request : http.request;

    return new Promise<Uint8Array>((resolve, reject) => {
      const request = transport(url, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        timeout: 20_000,
      }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        result.on('error', reject);
        result.on('end', () => {
          const content = Buffer.concat(chunks);
          if ((result.statusCode ?? 500) >= 400) {
            reject(new Error(`GET /api/pdf failed: ${content.toString('utf8') || `HTTP ${result.statusCode}`}`));
            return;
          }
          resolve(new Uint8Array(content));
        });
      });
      request.on('timeout', () => request.destroy(new Error(`Timed out downloading the PDF from ${url.origin}.`)));
      request.on('error', reject);
      request.end();
    });
  }

  private request<T>(method: 'GET' | 'POST', endpoint: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const url = new URL(endpoint, this.serverUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https.request : http.request;

    return new Promise<T>((resolve, reject) => {
      const request = transport(url, {
        method,
        headers: payload === undefined ? undefined : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        result.on('error', reject);
        result.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text.length === 0 ? {} : JSON.parse(text);
          } catch {
            // Fall back to the response text when a proxy returns non-JSON content.
          }
          if ((result.statusCode ?? 500) >= 400) {
            const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed
              ? String((parsed as { error: unknown }).error)
              : text || `HTTP ${result.statusCode}`;
            reject(new Error(`${method} ${endpoint} failed: ${message}`));
            return;
          }
          resolve(parsed as T);
        });
      });
      request.on('timeout', () => request.destroy(new Error(`Timed out connecting to ${url.origin}.`)));
      request.on('error', reject);
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }
}

function roundSyncTexCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}
