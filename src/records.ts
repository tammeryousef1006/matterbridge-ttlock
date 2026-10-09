/**
 * Classifies TTLock operation records (from the lock's own history or the
 * TTLock cloud callback) into a lock/unlock operation and how it was done.
 */

export type OperationMethod = 'app' | 'passcode' | 'card' | 'fingerprint' | 'face' | 'palm' | 'key' | 'inside' | 'remote' | 'gateway' | 'qr' | 'auto' | 'other';

export interface RecordInfo {
  operation?: 'lock' | 'unlock';
  method: OperationMethod;
  success: boolean;
}

/** Record types written by the lock itself (`LogOperate` in the vendor SDK); also sent by the cloud as `recordTypeFromLock`. */
const LOCK_RECORD_TYPES: Record<number, RecordInfo> = {
  1: { operation: 'unlock', method: 'app', success: true },
  3: { operation: 'unlock', method: 'app', success: true },
  4: { operation: 'unlock', method: 'passcode', success: true },
  7: { operation: 'unlock', method: 'passcode', success: false },
  17: { operation: 'unlock', method: 'card', success: true },
  19: { operation: 'unlock', method: 'remote', success: true },
  20: { operation: 'unlock', method: 'fingerprint', success: true },
  22: { operation: 'unlock', method: 'fingerprint', success: false },
  25: { operation: 'unlock', method: 'card', success: false },
  26: { operation: 'lock', method: 'app', success: true },
  27: { operation: 'unlock', method: 'key', success: true },
  28: { operation: 'unlock', method: 'gateway', success: true },
  32: { operation: 'unlock', method: 'inside', success: true },
  33: { operation: 'lock', method: 'fingerprint', success: true },
  34: { operation: 'lock', method: 'passcode', success: true },
  35: { operation: 'lock', method: 'card', success: true },
  36: { operation: 'lock', method: 'key', success: true },
  37: { operation: 'unlock', method: 'remote', success: true },
  38: { operation: 'unlock', method: 'passcode', success: false },
  39: { operation: 'unlock', method: 'card', success: false },
  40: { operation: 'unlock', method: 'fingerprint', success: false },
  41: { operation: 'unlock', method: 'app', success: false },
  52: { operation: 'lock', method: 'app', success: true },
  55: { operation: 'unlock', method: 'remote', success: true },
  56: { operation: 'unlock', method: 'passcode', success: true },
  57: { operation: 'unlock', method: 'qr', success: true },
  58: { operation: 'unlock', method: 'qr', success: false },
  61: { operation: 'lock', method: 'qr', success: true },
  67: { operation: 'unlock', method: 'face', success: true },
  68: { operation: 'unlock', method: 'face', success: false },
  69: { operation: 'lock', method: 'face', success: true },
  75: { operation: 'unlock', method: 'app', success: true },
  76: { operation: 'unlock', method: 'gateway', success: true },
  77: { operation: 'unlock', method: 'app', success: true },
  78: { operation: 'unlock', method: 'passcode', success: true },
  79: { operation: 'unlock', method: 'fingerprint', success: true },
  80: { operation: 'unlock', method: 'card', success: true },
  81: { operation: 'unlock', method: 'face', success: true },
  82: { operation: 'unlock', method: 'remote', success: true },
  83: { operation: 'unlock', method: 'palm', success: true },
  84: { operation: 'unlock', method: 'palm', success: true },
  85: { operation: 'unlock', method: 'palm', success: false },
  86: { operation: 'lock', method: 'palm', success: true },
  91: { operation: 'unlock', method: 'card', success: false },
  92: { operation: 'unlock', method: 'passcode', success: true },
  94: { operation: 'unlock', method: 'other', success: true },
  95: { operation: 'lock', method: 'other', success: true },
  111: { operation: 'unlock', method: 'auto', success: true },
};

/** Record types used by the TTLock cloud (`recordType` in the Open API and its callback). */
const CLOUD_RECORD_TYPES: Record<number, RecordInfo> = {
  1: { operation: 'unlock', method: 'app', success: true },
  4: { operation: 'unlock', method: 'passcode', success: true },
  7: { operation: 'unlock', method: 'card', success: true },
  8: { operation: 'unlock', method: 'fingerprint', success: true },
  9: { operation: 'unlock', method: 'remote', success: true },
  10: { operation: 'unlock', method: 'key', success: true },
  11: { operation: 'lock', method: 'app', success: true },
  12: { operation: 'unlock', method: 'gateway', success: true },
  32: { operation: 'unlock', method: 'inside', success: true },
  33: { operation: 'lock', method: 'fingerprint', success: true },
  34: { operation: 'lock', method: 'passcode', success: true },
  35: { operation: 'lock', method: 'card', success: true },
  36: { operation: 'lock', method: 'key', success: true },
  37: { operation: 'unlock', method: 'remote', success: true },
  45: { operation: 'lock', method: 'auto', success: true },
  46: { operation: 'unlock', method: 'remote', success: true },
  47: { operation: 'lock', method: 'remote', success: true },
  49: { operation: 'unlock', method: 'card', success: true },
  52: { operation: 'lock', method: 'app', success: true },
  55: { operation: 'unlock', method: 'remote', success: true },
  57: { operation: 'unlock', method: 'qr', success: true },
  61: { operation: 'lock', method: 'qr', success: true },
};

export function classifyLockRecord(recordType: number): RecordInfo | undefined {
  return LOCK_RECORD_TYPES[recordType];
}

export function classifyCloudRecord(recordType: number): RecordInfo | undefined {
  return CLOUD_RECORD_TYPES[recordType];
}

export const METHOD_LABELS: Record<OperationMethod, string> = {
  app: 'the app',
  passcode: 'passcode',
  card: 'card',
  fingerprint: 'fingerprint',
  face: 'face recognition',
  palm: 'palm vein',
  key: 'mechanical key',
  inside: 'the inside handle',
  remote: 'remote / key fob',
  gateway: 'the gateway',
  qr: 'QR code',
  auto: 'auto-lock',
  other: 'another device',
};
