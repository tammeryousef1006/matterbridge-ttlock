/**
 * Receives the TTLock Open Platform callback (lock records pushed by the
 * TTLock cloud in real time) on a small HTTP server.
 */
import { timingSafeEqual } from 'crypto';
import http from 'http';

import { TTLockLogger } from './ttlockApi.js';

export interface CloudRecord {
  lockId?: number;
  lockMac?: string;
  /** Cloud record type (Open API `recordType`). */
  recordType?: number;
  /** Lock-native record type, when the cloud includes it. */
  recordTypeFromLock?: number;
  success: boolean;
  username?: string;
  keyboardPwd?: string;
  lockDate?: number;
  battery?: number;
}

const MAX_BODY_BYTES = 256 * 1024;

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function str(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** Accept the callback body as JSON or form data; `records` may be a JSON string. */
export function parseCallbackBody(raw: string, contentType: string | undefined): CloudRecord[] {
  let body: Record<string, unknown> = {};
  const text = raw.trim();
  if (!text) return [];
  if ((contentType ?? '').includes('json') || text.startsWith('{') || text.startsWith('[')) {
    const parsed = JSON.parse(text);
    body = Array.isArray(parsed) ? { records: parsed } : parsed;
  } else {
    for (const [key, value] of new URLSearchParams(text)) body[key] = value;
  }
  let records: unknown = body.records ?? body.record ?? body.data;
  if (typeof records === 'string') {
    try {
      records = JSON.parse(records);
    } catch {
      records = [];
    }
  }
  if (!Array.isArray(records)) records = records && typeof records === 'object' ? [records] : [body];
  const topLockId = num(body.lockId);
  const topLockMac = str(body.lockMac);
  return (records as Array<Record<string, unknown>>)
    .filter((r) => r && typeof r === 'object')
    .map((r) => toCloudRecord(r, topLockId, topLockMac))
    .filter((r) => r.lockId !== undefined || r.lockMac !== undefined);
}

/** A lock record as the TTLock cloud sends it (callback or /v3/lockRecord/list). */
export function toCloudRecord(r: Record<string, unknown>, lockId?: number, lockMac?: string): CloudRecord {
  return {
    lockId: num(r.lockId) ?? lockId,
    lockMac: str(r.lockMac) ?? lockMac,
    recordType: num(r.recordType),
    recordTypeFromLock: num(r.recordTypeFromLock),
    success: r.success === undefined ? true : Number(r.success) === 1 || r.success === true,
    username: str(r.username),
    keyboardPwd: str(r.keyboardPwd),
    lockDate: num(r.lockDate),
    battery: num(r.electricQuantity),
  };
}

export function buildWebhookUrl(publicUrl: string, token: string): string {
  return `${publicUrl.trim().replace(/\/+$/, '')}/ttlock/${token}`;
}

export class WebhookServer {
  private server: http.Server | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly onRecords: (records: CloudRecord[]) => void,
    private readonly log: TTLockLogger,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(new Error(error.code === 'EADDRINUSE' ? `port ${this.port} is already in use` : error.message));
      });
      server.listen(this.port, () => {
        this.server = server;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = undefined;
    });
  }

  get listeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    const match = /^\/ttlock\/([^/]+)$/.exec(path);
    if (!match || !this.tokenMatches(match[1])) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Lets you (or TTLock) check the URL from a browser.
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const records = parseCallbackBody(raw, req.headers['content-type']);
        this.log.debug(`Webhook received ${records.length} record(s).`);
        if (records.length) this.onRecords(records);
      } catch (error) {
        this.log.debug(`Webhook: could not parse callback body (${(error as Error).message}): ${raw.slice(0, 500)}`);
      }
      // TTLock expects "success", otherwise it retries.
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
    });
  }
}
