/**
 * TTLock V3 Bluetooth frame format (ported from the MIT-licensed `ttlock-ble` library).
 *
 *   7F 5A | proto | sub_ver | scene | group_id(2) | org_id(2) | cmd | encrypt | len | data | CRC | 0D 0A
 */
import { aesDecrypt, aesEncrypt, crc8 } from './crypto.js';

export const ENCRYPT_PLAIN = 0xaa;
export const ENCRYPT_AES = 0x02;
const HEADER = Buffer.from([0x7f, 0x5a]);
const TRAILER = Buffer.from([0x0d, 0x0a]);
const V3_HEADER_LEN = 12;
const LEGACY_HEADER_LEN = 6;
const V3_LENGTH_INDEX = 11;
const LEGACY_LENGTH_INDEX = 5;
const MIN_PROTOCOL_TYPE = 5;

export interface LockVersion {
  protocolType: number;
  protocolVersion: number;
  scene: number;
  groupId: number;
  orgId: number;
}

export class Frame {
  constructor(
    readonly protocolType: number,
    readonly subVersion: number,
    readonly scene: number,
    readonly groupId: number,
    readonly orgId: number,
    readonly command: number,
    readonly encrypt: number,
    readonly data: Buffer,
  ) {}

  /** A command frame addressed to a lock, with its payload AES-encrypted. */
  static forLock(version: LockVersion, command: number, payload: Buffer, key: Buffer): Frame {
    // The encrypt byte stays 0xAA: the firmware reads it as "frame from the app".
    return new Frame(version.protocolType, version.protocolVersion, version.scene, version.groupId, version.orgId, command, ENCRYPT_PLAIN, aesEncrypt(payload, key));
  }

  /** Serialise to wire bytes, CRLF-terminated. */
  build(): Buffer {
    const header =
      this.protocolType >= 5
        ? Buffer.from([
            HEADER[0],
            HEADER[1],
            this.protocolType & 0xff,
            this.subVersion & 0xff,
            this.scene & 0xff,
            (this.groupId >> 8) & 0xff,
            this.groupId & 0xff,
            (this.orgId >> 8) & 0xff,
            this.orgId & 0xff,
            this.command & 0xff,
            this.encrypt & 0xff,
            this.data.length & 0xff,
          ])
        : Buffer.from([HEADER[0], HEADER[1], this.protocolType & 0xff, this.command & 0xff, this.encrypt & 0xff, this.data.length & 0xff]);
    const body = Buffer.concat([header, this.data]);
    return Buffer.concat([body, Buffer.from([crc8(body)]), TRAILER]);
  }

  /** Parse a frame body (without CRC and trailer). */
  static parse(raw: Buffer): Frame {
    if (raw.length < 7 || raw[0] !== HEADER[0] || raw[1] !== HEADER[1]) throw new Error(`Invalid TTLock frame: ${raw.toString('hex')}`);
    const proto = raw[2];
    const headerLen = proto >= 5 ? V3_HEADER_LEN : LEGACY_HEADER_LEN;
    if (raw.length < headerLen) throw new Error('Truncated TTLock frame header');
    const length = raw[proto >= 5 ? V3_LENGTH_INDEX : LEGACY_LENGTH_INDEX];
    if (raw.length < headerLen + length) throw new Error(`Truncated TTLock frame: declared ${length} payload bytes, got ${raw.length - headerLen}`);
    const data = Buffer.from(raw.subarray(headerLen, headerLen + length));
    if (proto >= 5) {
      return new Frame(proto, raw[3], raw[4], (raw[5] << 8) | raw[6], (raw[7] << 8) | raw[8], raw[9], raw[10], data);
    }
    return new Frame(proto, 0, 0, 0, 0, raw[3], raw[4], data);
  }

  decrypt(key: Buffer): Buffer {
    return this.encrypt === ENCRYPT_AES ? aesDecrypt(this.data, key) : this.data;
  }
}

/**
 * Buffers notification chunks (20 bytes each) until whole frames have arrived.
 * Frame boundaries come from the declared length, since AES ciphertext may
 * itself contain CRLF or the header bytes.
 */
export class FrameReassembler {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    for (;;) {
      const start = this.buf.indexOf(HEADER);
      if (start < 0) {
        // A header may straddle two notifications; keep the last byte.
        this.buf = this.buf.subarray(Math.max(this.buf.length - 1, 0));
        break;
      }
      this.buf = this.buf.subarray(start);
      if (this.buf.length >= 3 && this.buf[2] < MIN_PROTOCOL_TYPE) {
        this.buf = this.buf.subarray(HEADER.length);
        continue;
      }
      if (this.buf.length <= V3_LENGTH_INDEX) break;
      const size = V3_HEADER_LEN + this.buf[V3_LENGTH_INDEX] + 1 + TRAILER.length;
      if (this.buf.length < size) break;
      if (!this.buf.subarray(size - TRAILER.length, size).equals(TRAILER)) {
        // The declared length doesn't land on a terminator: this header was ciphertext.
        this.buf = this.buf.subarray(HEADER.length);
        continue;
      }
      const raw = Buffer.from(this.buf.subarray(0, size - TRAILER.length));
      this.buf = this.buf.subarray(size);
      try {
        out.push(Frame.parse(raw));
      } catch {
        // skip malformed frame
      }
    }
    return out;
  }
}
