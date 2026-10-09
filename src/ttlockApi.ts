import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface TTLockLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface TTLockApiOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username?: string;
  password?: string;
  accessToken?: string;
  timeoutMs?: number;
}

export interface TTLockLock {
  lockId: number;
  lockAlias?: string;
  lockName?: string;
  lockMac?: string;
  lockData?: string;
  electricQuantity?: number;
  hasGateway?: number;
  firmwareRevision?: string;
  modelNum?: string;
  /** Auto-lock delay in seconds (0 or negative when off). */
  autoLockTime?: number;
}

/** Lock open state as reported by /v3/lock/queryOpenState. */
export enum TTLockOpenState {
  Locked = 0,
  Unlocked = 1,
  Unknown = 2,
}

interface TTLockBaseResponse {
  errcode?: number;
  errmsg?: string;
  description?: string;
}

interface TTLockTokenResponse extends TTLockBaseResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  uid?: number;
}

interface TTLockLockListResponse extends TTLockBaseResponse {
  list?: TTLockLock[];
  pageNo?: number;
  pageSize?: number;
  pages?: number;
  total?: number;
}

interface TTLockOpenStateResponse extends TTLockBaseResponse {
  state?: number;
}

/** Error codes TTLock returns when the access token is invalid or expired. */
interface TTLockListResponse extends TTLockBaseResponse {
  list?: Array<Record<string, unknown>>;
  pages?: number;
}

/** A fingerprint, card or passcode registered on a lock. */
export interface TTLockCredential {
  kind: 'fingerprint' | 'card' | 'passcode';
  /** TTLock's id of the credential. */
  id: number;
  /** Fingerprint number, card number or passcode digits (as reported by the lock history). */
  value?: string;
  name: string;
  startDate?: number;
  endDate?: number;
}

function credential(kind: TTLockCredential['kind'], id: unknown, value: unknown, name: unknown, startDate: unknown, endDate: unknown): TTLockCredential | undefined {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return undefined;
  return {
    kind,
    id: numericId,
    value: value === undefined || value === null || value === '' ? undefined : String(value),
    name: typeof name === 'string' ? name.trim() : '',
    startDate: Number(startDate) || undefined,
    endDate: Number(endDate) || undefined,
  };
}

const TOKEN_ERROR_CODES = new Set([10003, 10004]);
/** Refresh the token this long before it actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export class TTLockApiError extends Error {
  constructor(
    message: string,
    public readonly errcode?: number,
  ) {
    super(message);
    this.name = 'TTLockApiError';
  }
}

/** Minimal client for the TTLock Open Platform REST API. */
export class TTLockApi {
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;
  private authPromise: Promise<void> | null = null;

  constructor(
    private readonly options: TTLockApiOptions,
    private readonly log: TTLockLogger,
  ) {
    this.http = axios.create({
      baseURL: options.baseUrl.replace(/\/+$/, ''),
      timeout: options.timeoutMs ?? 15000,
    });
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  get canLogin(): boolean {
    return !!(this.options.username && this.options.password);
  }

  /** Make sure a usable access token is available, logging in or refreshing as needed. */
  async ensureAuthenticated(force = false): Promise<void> {
    if (!force && this.accessToken && (this.tokenExpiresAt === 0 || Date.now() < this.tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS)) return;
    // Share one in-flight authentication between concurrent callers
    if (!this.authPromise) {
      this.authPromise = this.authenticate(force).finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  private async authenticate(force: boolean): Promise<void> {
    if (this.refreshToken) {
      try {
        await this.requestToken({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
        this.log.debug('Refreshed TTLock access token.');
        return;
      } catch (error) {
        this.log.warn(`Failed to refresh TTLock access token, logging in again: ${errorMessage(error)}`);
        this.refreshToken = null;
      }
    }

    if (this.canLogin) {
      const hashedPassword = crypto.createHash('md5').update(this.options.password!).digest('hex');
      await this.requestToken({ username: this.options.username!, password: hashedPassword });
      this.log.info('Successfully authenticated with the TTLock API.');
      return;
    }

    if (this.options.accessToken && (!force || !this.accessToken)) {
      // A static token can't be renewed; use it until TTLock rejects it
      this.accessToken = this.options.accessToken;
      this.tokenExpiresAt = 0;
      this.log.info('Using the configured TTLock access token.');
      return;
    }

    throw new TTLockApiError('No valid TTLock credentials: configure username/password or a valid access token.');
  }

  private async requestToken(params: Record<string, string>): Promise<void> {
    const response = await this.http.post<TTLockTokenResponse>(
      '/oauth2/token',
      new URLSearchParams({ clientId: this.options.clientId, clientSecret: this.options.clientSecret, ...params }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const data = response.data;
    if (!data?.access_token) {
      throw new TTLockApiError(`Authentication failed: ${data?.errmsg || data?.description || 'no access token in response'}`, data?.errcode);
    }
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token ?? null;
    this.tokenExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : 0;
  }

  /** Perform an authenticated API call, re-authenticating once if the token was rejected. */
  private async call<T extends TTLockBaseResponse>(method: 'get' | 'post', path: string, params: Record<string, string | number>): Promise<T> {
    await this.ensureAuthenticated();
    try {
      return await this.rawCall<T>(method, path, params);
    } catch (error) {
      if (error instanceof TTLockApiError && error.errcode !== undefined && TOKEN_ERROR_CODES.has(error.errcode)) {
        this.log.info('TTLock access token was rejected, re-authenticating...');
        await this.ensureAuthenticated(true);
        return await this.rawCall<T>(method, path, params);
      }
      throw error;
    }
  }

  private async rawCall<T extends TTLockBaseResponse>(method: 'get' | 'post', path: string, params: Record<string, string | number>): Promise<T> {
    const allParams: Record<string, string> = { clientId: this.options.clientId, accessToken: this.accessToken ?? '', date: String(Date.now()) };
    for (const [key, value] of Object.entries(params)) allParams[key] = String(value);

    let data: T;
    try {
      const response =
        method === 'get'
          ? await this.http.get<T>(path, { params: allParams })
          : await this.http.post<T>(path, new URLSearchParams(allParams), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      data = response.data;
    } catch (error) {
      throw new TTLockApiError(`Request to ${path} failed: ${errorMessage(error)}`);
    }
    if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
      throw new TTLockApiError(`TTLock API error on ${path}: ${data.errmsg || data.description || 'unknown error'} (errcode ${data.errcode})`, data.errcode);
    }
    return data;
  }

  /** List all locks on the account, following pagination. */
  async listLocks(): Promise<TTLockLock[]> {
    const locks: TTLockLock[] = [];
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const data = await this.call<TTLockLockListResponse>('get', '/v3/lock/list', { pageNo, pageSize: PAGE_SIZE });
      const list = data.list ?? [];
      locks.push(...list);
      const pages = data.pages ?? 1;
      if (pageNo >= pages || list.length === 0) break;
    }
    return locks;
  }

  async lock(lockId: number): Promise<void> {
    await this.call('post', '/v3/lock/lock', { lockId });
  }

  async unlock(lockId: number): Promise<void> {
    await this.call('post', '/v3/lock/unlock', { lockId });
  }

  /**
   * The lock's credentials (fingerprints, cards and passcodes) from the official API.
   * A type the account can't list (or that the lock doesn't support) is returned empty.
   */
  async listCredentials(lockId: number): Promise<TTLockCredential[]> {
    const sources: Array<{ kind: TTLockCredential['kind']; path: string; map: (item: Record<string, unknown>) => TTLockCredential | undefined }> = [
      {
        kind: 'fingerprint',
        path: '/v3/fingerprint/list',
        map: (i) => credential('fingerprint', i.fingerprintId, i.fingerprintNumber, i.fingerprintName, i.startDate, i.endDate),
      },
      { kind: 'card', path: '/v3/identityCard/list', map: (i) => credential('card', i.cardId, i.cardNumber, i.cardName, i.startDate, i.endDate) },
      {
        kind: 'passcode',
        path: '/v3/lock/listKeyboardPwd',
        map: (i) => credential('passcode', i.keyboardPwdId, i.keyboardPwd, i.keyboardPwdName, i.startDate, i.endDate),
      },
    ];
    const all: TTLockCredential[] = [];
    for (const source of sources) {
      try {
        for (let pageNo = 1; pageNo <= 20; pageNo++) {
          const data = await this.call<TTLockListResponse>('get', source.path, { lockId, pageNo, pageSize: PAGE_SIZE });
          const list = data.list ?? [];
          for (const item of list) {
            const c = source.map(item);
            if (c) all.push(c);
          }
          if (pageNo >= (data.pages ?? 1) || list.length === 0) break;
        }
      } catch (error) {
        this.log.debug(`Could not list ${source.kind}s of lock ${lockId}: ${errorMessage(error)}`);
      }
    }
    return all;
  }

  /** Recent operation records the gateway uploaded to the cloud (newest first). */
  async listRecords(lockId: number, sinceMs: number): Promise<Array<Record<string, unknown>>> {
    const data = await this.call<TTLockListResponse>('get', '/v3/lockRecord/list', { lockId, startDate: Math.floor(sinceMs), endDate: Date.now() + 60_000, pageNo: 1, pageSize: 20 });
    return data.list ?? [];
  }

  /** Query the current open state. Requires the lock to be connected to a gateway. */
  async queryOpenState(lockId: number): Promise<TTLockOpenState> {
    const data = await this.call<TTLockOpenStateResponse>('get', '/v3/lock/queryOpenState', { lockId });
    return data.state === 0 || data.state === 1 ? data.state : TTLockOpenState.Unknown;
  }
}

export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `${error.message} (HTTP ${status})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
