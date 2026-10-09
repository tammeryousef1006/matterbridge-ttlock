/**
 * Minimal client for the TTLock *app* cloud (servlet.ttlock.com), used only to
 * download the Bluetooth keys of the account's locks. This is the same
 * (unofficial) API the TTLock phone apps use; ported from the MIT-licensed
 * `ttlock-ble` library.
 */
import axios, { AxiosInstance } from 'axios';
import { createHash, createHmac } from 'crypto';

import { BleKey, keyFromObject } from './keys.js';

// Public OEM credentials embedded in the DLock-XP app, as used by `ttlock-ble`.
const APP_ID = '9aa8af853eea43fa839a0a474ee9d8ab';
const APP_SECRET = '07752080e28d43e5f8a7cdb8aad3c0c3';
const PACKAGE_NAME = 'com.dlock.smart';
const DEFAULT_BASE_URL = 'https://servlet.ttlock.com';
const ERR_NEW_DEVICE_LOGIN = -1014;

export class AppCloudError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AppCloudError';
  }

  /** TTLock wants this device confirmed with a code sent by email/SMS. */
  get needsVerification(): boolean {
    return this.code === ERR_NEW_DEVICE_LOGIN;
  }
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

export function signRequest(path: string, params: Record<string, string>): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHmac('sha256', APP_SECRET).update(`${path}?${query}${APP_ID}`, 'utf8').digest('base64');
}

export class TTLockAppCloud {
  private readonly http: AxiosInstance;
  private baseUrl: string;
  private siteId = 0;
  private countryId = 0;
  private uid = 0;
  private accessToken = '';

  constructor(
    private readonly uniqueId: string,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 30000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.http = axios.create({ timeout: timeoutMs });
  }

  /** Find the regional server for this account's region (best effort). */
  async discoverSite(): Promise<void> {
    try {
      const body = await this.post('/system/getCountryAndSiteInfo', { uniqueid: this.uniqueId });
      if (typeof body.apiDomainName === 'string' && body.apiDomainName) this.baseUrl = body.apiDomainName.replace(/\/+$/, '');
      if (body.siteId !== undefined) this.siteId = Number(body.siteId) || 0;
      if (body.countryId !== undefined) this.countryId = Number(body.countryId) || 0;
    } catch {
      // keep the default server
    }
  }

  async login(username: string, password: string): Promise<void> {
    const body = await this.post('/user/login', {
      username,
      password: md5(password),
      platId: '1',
      uniqueid: this.uniqueId,
      packageName: PACKAGE_NAME,
      countryId: String(this.countryId),
      siteId: String(this.siteId),
      install: `install:${PACKAGE_NAME}`,
    });
    const uid = body.uid ?? body.user_id ?? body.userId;
    const token = body.accessToken ?? body.access_token;
    if (uid === undefined || !token) throw new AppCloudError('TTLock app login returned no access token');
    this.uid = Number(uid);
    this.accessToken = String(token);
  }

  /** Ask TTLock to send a new-device verification code to the account's email/phone. */
  async requestVerificationCode(account: string): Promise<void> {
    await this.post(
      '/user/sendValidationCode',
      { account, uniqueid: this.uniqueId, codeType: '4', xWidth: '0', channel: '1', language: 'en', siteId: String(this.siteId) },
      '2.3',
    );
  }

  async validateNewDevice(account: string, code: string): Promise<void> {
    await this.post('/user/loginNewDeviceValidation', {
      userid: account,
      uniqueid: this.uniqueId,
      verificationCode: code,
      platId: '1',
      countryId: String(this.countryId),
      siteId: String(this.siteId),
    });
  }

  /** Download every key of the account and keep the ones usable over Bluetooth. */
  async listKeys(): Promise<BleKey[]> {
    const keys: BleKey[] = [];
    const userInfo = JSON.stringify({ appVersion: '1.6.0', deviceName: 'matterbridge-ttlock', language: 'en', deviceSystemVersion: 'Linux', packageName: PACKAGE_NAME });
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const body = await this.post('/check/syncDataPage', { lastUpdateDate: '0', pageNo: String(pageNo), userInfo, uniqueid: this.uniqueId });
      const page = (body.keyInfos ?? body.keyList ?? []) as unknown;
      if (!Array.isArray(page) || page.length === 0) break;
      for (const item of page) {
        if (!item || typeof item !== 'object') continue;
        const key = keyFromObject({ ...(item as Record<string, unknown>), uid: this.uid }, 'TTLock app account');
        if (key) keys.push(key);
      }
      const pages = Number(body.pages ?? body.pageNos ?? 1);
      if (pageNo >= pages) break;
    }
    return keys;
  }

  private async post(path: string, params: Record<string, string>, version = '2.2'): Promise<Record<string, unknown>> {
    const now = String(Date.now());
    const full: Record<string, string> = { ...params, date: params.date ?? now, d: params.d ?? now };
    const fullPath = '/lock' + path;
    const headers = {
      appid: APP_ID,
      appSecret: APP_SECRET,
      version,
      platform: 'Android-1.6.0',
      language: 'en',
      packageName: PACKAGE_NAME,
      date: full.date,
      uniqueid: this.uniqueId,
      signature: signRequest(fullPath, full),
      refer: '0',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14; matterbridge-ttlock) AppleWebKit/537.36',
      accessToken: this.accessToken,
      operatorUid: this.uid ? String(this.uid) : '',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    let body: Record<string, unknown>;
    try {
      const response = await this.http.post(this.baseUrl + fullPath, new URLSearchParams(full), { headers, validateStatus: () => true });
      body = typeof response.data === 'object' && response.data ? response.data : {};
      if (response.status >= 400 && body.errcode === undefined && body.errorCode === undefined) throw new AppCloudError(`TTLock app cloud returned HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof AppCloudError) throw error;
      throw new AppCloudError(`TTLock app cloud unreachable: ${(error as Error).message}`);
    }
    const code = Number(body.errcode ?? body.errorCode ?? 0);
    if (code !== 0) throw new AppCloudError(`TTLock app cloud error: ${body.errmsg ?? body.description ?? body.message ?? code}`, code);
    return body;
  }
}
