/**
 * The per-lock secrets needed to operate a lock over Bluetooth, and the ways
 * to obtain them.
 */
import { aesKeyFromString, codecDecode, decodePassword } from './crypto.js';
import { LockVersion } from './frame.js';

export interface BleKey {
  lockMac: string;
  lockId?: number;
  aesKey: Buffer;
  unlockKey: string;
  lockVersion: LockVersion;
  uid: number;
  /** Where the key came from, for logs. */
  source: string;
}

export function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : mac.toUpperCase();
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseLockVersion(value: unknown): LockVersion | undefined {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.protocolType === undefined || o.protocolVersion === undefined) return undefined;
  return {
    protocolType: toInt(o.protocolType),
    protocolVersion: toInt(o.protocolVersion),
    scene: toInt(o.scene),
    groupId: toInt(o.groupId),
    orgId: toInt(o.orgId),
  };
}

/**
 * Build a key from an object in any of the known shapes: the TTLock app
 * cloud's key list, the Home Assistant "TTLock BLE" integration's stored key,
 * or the lock data of the TTLock SDK.
 */
export function keyFromObject(obj: Record<string, unknown>, source: string): BleKey | undefined {
  const aesKeyStr = obj.aesKeyStr ?? obj.aesKey;
  const unlockRaw = obj.unlockKey ?? obj.lockKey ?? obj.noKeyPwd;
  const lockVersion = parseLockVersion(obj.lockVersion);
  const lockMac = obj.lockMac;
  if (typeof aesKeyStr !== 'string' || unlockRaw === undefined || unlockRaw === null || !lockVersion || typeof lockMac !== 'string') return undefined;
  let aesKey: Buffer;
  try {
    aesKey = aesKeyFromString(aesKeyStr);
  } catch {
    return undefined;
  }
  const unlockKey = decodePassword(String(unlockRaw)).trim();
  if (!/^\d+$/.test(unlockKey)) return undefined;
  return {
    lockMac: normalizeMac(lockMac),
    lockId: obj.lockId !== undefined ? toInt(obj.lockId) : undefined,
    aesKey,
    unlockKey,
    lockVersion,
    uid: toInt(obj.uid),
    source,
  };
}

/** Collect every key-shaped object found anywhere inside a JSON value. */
export function keysFromJson(value: unknown, source: string): BleKey[] {
  const found: BleKey[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    const key = keyFromObject(v as Record<string, unknown>, source);
    if (key) found.push(key);
    for (const child of Object.values(v as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

/** Parse the "Bluetooth keys (JSON)" config text. Throws with a readable message on invalid JSON. */
export function keysFromConfigText(text: string): BleKey[] {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the Bluetooth keys field is not valid JSON (${(error as Error).message})`);
  }
  return keysFromJson(parsed, 'manual keys');
}

export interface LockDataResult {
  key?: BleKey;
  /** What was tried, safe to log (no secrets). */
  diagnostic: string;
}

/**
 * Try to read the keys out of the `lockData` string the TTLock Open API returns
 * for each lock. Its format is not documented, so several known encodings are
 * tried. Experimental.
 */
export function keyFromLockData(lockData: string | undefined, lockMac: string, lockId: number): LockDataResult {
  if (!lockData) return { diagnostic: 'the TTLock API returned no lockData for this lock' };
  const attempts: Array<[string, () => string]> = [
    ['plain JSON', () => lockData],
    ['base64 JSON', () => Buffer.from(lockData, 'base64').toString('utf8')],
    ['base64 + codec', () => codecDecode(Buffer.from(lockData, 'base64')).toString('utf8')],
    ['base64 CSV + codec', () => decodePassword(lockData)],
    ['raw + codec', () => codecDecode(Buffer.from(lockData, 'latin1')).toString('utf8')],
  ];
  const notes: string[] = [];
  for (const [name, decode] of attempts) {
    let text: string;
    try {
      text = decode();
    } catch {
      continue;
    }
    const start = text.indexOf('{');
    if (start < 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const fields = Object.keys(obj as object).sort().join(',');
    const withMac = { lockMac, lockId, ...(obj as Record<string, unknown>) };
    const key = keyFromObject(withMac, `lockData (${name})`);
    if (key) return { key, diagnostic: `decoded with "${name}"` };
    notes.push(`"${name}" gave JSON without usable keys (fields: ${fields})`);
  }
  const charset = /^[A-Za-z0-9+/=]+$/.test(lockData) ? 'base64-like' : /^[0-9a-fA-F]+$/.test(lockData) ? 'hex-like' : 'mixed';
  return { diagnostic: `could not decode lockData (${lockData.length} chars, ${charset})${notes.length ? '; ' + notes.join('; ') : ''}` };
}
