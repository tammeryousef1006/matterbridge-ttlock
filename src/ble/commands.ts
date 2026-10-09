/**
 * TTLock V3 command payloads and response parsers
 * (ported from the MIT-licensed `ttlock-ble` library).
 */

export const CMD_QUERY_STATE = 0x14;
export const CMD_GET_OPERATE_LOG = 0x25;
export const CMD_UNLOCK = 0x47;
export const CMD_CHECK_USER_TIME = 0x55;
export const CMD_LOCK = 0x58;

const RESPONSE_SUCCESS = 0x01;

export interface ResponseEnvelope {
  echo: number;
  status: number;
  data: Buffer;
}

/** Every decrypted response is `[echoed command][status][data...]`. */
export function parseEnvelope(plain: Buffer): ResponseEnvelope {
  if (plain.length < 2) throw new Error(`Response too short: ${plain.toString('hex')}`);
  return { echo: plain[0], status: plain[1], data: plain.subarray(2) };
}

export function isSuccess(plain: Buffer): boolean {
  return parseEnvelope(plain).status === RESPONSE_SUCCESS;
}

/** Pack a digit string two digits per byte (BCD). */
function bcd(time: string): Buffer {
  const s = time.length % 2 ? '0' + time : time;
  const out = Buffer.alloc(s.length / 2);
  for (let i = 0; i < s.length; i += 2) out[i / 2] = ((Number(s[i]) << 4) | Number(s[i + 1])) & 0xff;
  return out;
}

/** CHECK_USER_TIME: proves the key is valid now; the lock answers with `psFromLock`. */
export function payloadCheckUserTime(uid = 0, startDate = '0001311400', endDate = '9911301400', lockFlagPos = 0): Buffer {
  const out = Buffer.alloc(17);
  bcd(startDate).copy(out, 0);
  out[9] = (lockFlagPos >>> 24) & 0xff;
  out[10] = (lockFlagPos >>> 16) & 0xff;
  out[11] = (lockFlagPos >>> 8) & 0xff;
  out[12] = lockFlagPos & 0xff;
  // The end date overwrites byte 9, exactly like the vendor SDK.
  bcd(endDate).copy(out, 5);
  out.writeUInt32BE(uid >>> 0, 13);
  return out;
}

export function parseCheckUserTime(plain: Buffer): number {
  const { status, data } = parseEnvelope(plain);
  if (status !== RESPONSE_SUCCESS) throw new Error(`The lock rejected the key (checkUserTime status ${status}, error ${data.toString('hex')})`);
  if (data.length < 4) throw new Error('checkUserTime response too short');
  return data.readUInt32BE(0);
}

/** UNLOCK / LOCK: `(psFromLock + unlockKey) mod 2^32` followed by the current unix time. */
export function payloadUnlock(psFromLock: number, unlockKey: string | number, nowMs = Date.now()): Buffer {
  const sum = (BigInt(psFromLock) + BigInt(String(unlockKey).trim())) & 0xffffffffn;
  const out = Buffer.alloc(8);
  out.writeUInt32BE(Number(sum), 0);
  out.writeUInt32BE(Math.floor(nowMs / 1000) >>> 0, 4);
  return out;
}

/** QUERY_STATE needs no handshake: a fixed literal. */
export function payloadQueryState(): Buffer {
  return Buffer.from('SCIENER', 'ascii');
}

export function parseQueryState(plain: Buffer): { locked?: boolean; battery?: number } {
  const { status, data } = parseEnvelope(plain);
  if (status !== RESPONSE_SUCCESS) return {};
  return {
    battery: data.length >= 1 ? data[0] : undefined,
    locked: data.length >= 2 && (data[1] === 0 || data[1] === 1) ? data[1] === 0 : undefined,
  };
}

/** GET_OPERATE_LOG: `0xFFFF` asks for the records not yet synced. */
export function payloadOperateLog(sequence = 0xffff): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(sequence & 0xffff, 0);
  return out;
}

export interface LockLogEntry {
  recordNumber: number;
  recordType: number;
  date?: Date;
  battery: number;
  /** Fingerprint / card id, keypad code, or accessory MAC depending on the record type. */
  credential?: string;
  uid?: number;
}

/** Decode 6 decimal-valued bytes (yy, mm, dd, hh, mi, ss) in the lock's local time. */
function decodeDate6(raw: Buffer): Date | undefined {
  if (raw.length < 6) return undefined;
  const [yy, mm, dd, hh, mi, ss] = raw;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return undefined;
  return new Date(2000 + yy, mm - 1, dd, hh, mi, ss);
}

const APP_RECORDS = new Set([1, 26, 28, 41, 52, 75, 76, 77]);
const PASSCODE_RECORDS = new Set([4, 5, 6, 7, 9, 10, 11, 12, 13, 34, 38, 78, 92]);
const CARD_RECORDS = new Set([15, 17, 18, 25, 35, 39, 51, 74, 80, 91]);
const SIX_BYTE_ID_RECORDS = new Set([20, 21, 22, 23, 33, 40, 79, 67, 68, 69, 70, 71, 72, 81, 83, 84, 85, 86, 87, 88, 89]);

function decodeTail(recordType: number, tail: Buffer): Pick<LockLogEntry, 'credential' | 'uid'> {
  if (APP_RECORDS.has(recordType)) return tail.length >= 8 ? { uid: tail.readUInt32BE(0) } : {};
  if (PASSCODE_RECORDS.has(recordType)) {
    if (tail.length < 1 || 1 + tail[0] > tail.length) return {};
    return { credential: tail.subarray(1, 1 + tail[0]).toString('latin1') };
  }
  if (CARD_RECORDS.has(recordType)) return tail.length ? { credential: BigInt('0x' + tail.toString('hex')).toString() } : {};
  if (SIX_BYTE_ID_RECORDS.has(recordType)) return tail.length >= 6 ? { credential: BigInt('0x' + tail.subarray(0, 6).toString('hex')).toString() } : {};
  return {};
}

/** Decode one GET_OPERATE_LOG response page into entries and the cursor for the next page. */
export function parseOperateLog(plain: Buffer): { entries: LockLogEntry[]; lastSequence: number } {
  const { status, data } = parseEnvelope(plain);
  if (status !== RESPONSE_SUCCESS || data.length < 2) return { entries: [], lastSequence: 0 };
  const totalLen = data.readUInt16BE(0);
  if (totalLen === 0 || data.length < 4) return { entries: [], lastSequence: 0 };
  const sequence = data.readUInt16BE(2);
  const entries: LockLogEntry[] = [];
  let idx = 4;
  while (idx < data.length) {
    const recLen = data[idx];
    idx += 1;
    const recStart = idx;
    if (recStart + recLen > data.length || recLen < 8) break;
    const recordType = data[idx];
    const date = decodeDate6(data.subarray(idx + 1, idx + 7));
    const battery = data[idx + 7];
    const tail = data.subarray(idx + 8, recStart + recLen);
    entries.push({ recordNumber: sequence - entries.length - 1, recordType, date, battery, ...decodeTail(recordType, tail) });
    idx = recStart + recLen;
  }
  return { entries, lastSequence: sequence };
}

/** State the lock broadcasts in its BLE advertisements; readable without any key. */
export interface LockAdvertisement {
  mac: string;
  /** undefined while the lock is dormant: the bolt bit is then meaningless. */
  locked?: boolean;
  hasNewRecords: boolean;
  dormant: boolean;
  battery: number;
}

const UNLOCKED_BIT = 0x01;
const NEW_RECORDS_BIT = 0x02;
const DORMANT_BIT = 0x10;

/**
 * Decode a manufacturer-data AD record. `raw` starts with the two "company id"
 * bytes, which TTLock reuses as protocol fields (05 03 for V3 locks).
 */
export function parseAdvertisement(raw: Buffer): LockAdvertisement | undefined {
  if (raw.length < 15) return undefined;
  const header = `${raw[0]},${raw[1]}`;
  if (header === '18,25' || header === '255,255') return undefined; // firmware-update mode
  let protocolType: number;
  let protocolVersion: number;
  let scene: number;
  let flagsOffset: number;
  if (header === '5,3') {
    [protocolType, protocolVersion, scene, flagsOffset] = [5, 3, raw[2], 3];
  } else {
    [protocolType, protocolVersion, scene, flagsOffset] = [raw[4], raw[5], raw[7], 8];
  }
  // Older locks and the V2S family carry no state in their advertisements.
  if (protocolType < 5 || (protocolType === 5 && protocolVersion === 1)) return undefined;
  void scene;
  const flags = raw[flagsOffset];
  const dormant = (flags & DORMANT_BIT) !== 0;
  const mac = Array.from(raw.subarray(raw.length - 6))
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
  return {
    mac,
    locked: dormant ? undefined : (flags & UNLOCKED_BIT) === 0,
    hasNewRecords: (flags & NEW_RECORDS_BIT) !== 0,
    dormant,
    battery: raw[flagsOffset + 1],
  };
}
