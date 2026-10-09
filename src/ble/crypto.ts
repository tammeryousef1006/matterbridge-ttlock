/**
 * Cryptographic primitives of the TTLock Bluetooth protocol.
 *
 * Ported from the MIT-licensed `ttlock-ble` Python library by Rodrigo Roque
 * (https://github.com/roquerodrigo/ttlock-ble), which reverse-engineered them
 * from the vendor's `libLockCore.so`.
 */
import { createCipheriv, createDecipheriv } from 'crypto';

const AES_KEY_LEN = 16;

/** Substitution table shared by the CRC-8 and the cloud field codec. */
const DECODE_TABLE = Buffer.from(
  '005ebce2613fdd83c29c7e20a3fd1f419dc3217ffca2401e5f01e3bd3e6082dc' +
    '23079fc1421cfea0e1bf5d0380de3c62bee0025cdf81633d7c22c09e1d43a1ff' +
    '4618faa427799bc584da3866e5bb5907db856739bae406581947a5fb7826c49a' +
    '653bd987045ab8e6a7f91b45c6987a24f8a6441a99c7257b3a6486d85b05e7b9' +
    '8cd2306eedb3510f4e10f2ac2f7193cd114fadf3702ecc92d38d6f31b2ec0e50' +
    'aff1134dce90722c6d33d18f0c52b0ee326c8ed0530defb1f0ae4c1291cf2d73' +
    'ca947628abf517490856b4ea6937d58b5709ebb536688ad495cb2977f4aa4816' +
    'e9b7550b88d6346a2b7597c94a14f6a8742ac896154ba9f7b6e80a54d7896b35',
  'hex',
);

function checkKey(key: Buffer): void {
  if (key.length !== AES_KEY_LEN) throw new Error(`AES key must be ${AES_KEY_LEN} bytes, got ${key.length}`);
}

/** AES-128-CBC with PKCS#7 padding, using the key as the IV (TTLock convention). */
export function aesEncrypt(plain: Buffer, key: Buffer): Buffer {
  checkKey(key);
  const cipher = createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  checkKey(key);
  const decipher = createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Table-driven CRC-8 appended to every frame. */
export function crc8(data: Buffer): number {
  let crc = 0;
  for (const byte of data) crc = DECODE_TABLE[(byte ^ crc) & 0xff];
  return crc & 0xff;
}

/** Reverse of the vendor's `CodecUtils.encode`: XOR with a constant derived from the last byte. */
export function codecDecode(encoded: Buffer): Buffer {
  if (encoded.length < 2) return encoded;
  const xor = DECODE_TABLE[(encoded.length - 1) % 256] ^ encoded[encoded.length - 1];
  const out = Buffer.alloc(encoded.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = encoded[i] ^ xor;
  return out;
}

/**
 * Decode a `lockKey` / `adminPwd` field from the TTLock cloud: base64 of a
 * comma-separated list of encoded byte values. Short values are already plain.
 */
export function decodePassword(field: string): string {
  if (!field || field.length <= 10) return field;
  const csv = Buffer.from(field, 'base64').toString('ascii');
  const raw = Buffer.from(
    csv
      .split(',')
      .filter((x) => x.trim() !== '')
      .map((x) => parseInt(x, 10) & 0xff),
  );
  return codecDecode(raw).toString('latin1');
}

/** Parse the cloud's `aesKeyStr` ("a1,b2,..." or 32 hex chars) into 16 bytes. */
export function aesKeyFromString(value: string): Buffer {
  const s = value.trim();
  if (!s) throw new Error('aesKeyStr is empty');
  if (s.includes(',') || s.includes('.')) {
    const parts = s
      .split(s.includes(',') ? ',' : '.')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => parseInt(x, 16) & 0xff);
    if (parts.length !== AES_KEY_LEN) throw new Error(`AES key has ${parts.length} parts, expected ${AES_KEY_LEN}`);
    return Buffer.from(parts);
  }
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');
  throw new Error('Unrecognised AES key format');
}
