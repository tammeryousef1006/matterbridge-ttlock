/**
 * One short Bluetooth session with a lock, through a {@link BleCentral}:
 * connect, enable notifications, run commands, disconnect.
 */
import { TTLockLogger } from '../ttlockApi.js';
import {
  CMD_CHECK_USER_TIME,
  CMD_GET_OPERATE_LOG,
  CMD_LOCK,
  CMD_QUERY_STATE,
  CMD_UNLOCK,
  LockLogEntry,
  parseCheckUserTime,
  parseEnvelope,
  parseOperateLog,
  parseQueryState,
  payloadCheckUserTime,
  payloadOperateLog,
  payloadQueryState,
  payloadUnlock,
} from './commands.js';
import { aesDecrypt } from './crypto.js';
import { BleCentral, GattCharacteristic, GattService } from './espProxy.js';
import { Frame, FrameReassembler } from './frame.js';
import { BleKey } from './keys.js';

const GATT_PROFILES = [
  { service: '00001910-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb', notify: '0000fff4-0000-1000-8000-00805f9b34fb' },
  { service: '6e400001-b5a3-f393-e0a9-e50e24dcca1e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca1e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca1e' },
];
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

/**
 * Compare UUIDs on their first 32 bits. The ESPHome library decodes 128-bit
 * UUIDs through JavaScript numbers, which corrupts their low bits; the leading
 * bits survive and are unique among a lock's services.
 */
export function sameUuid(a: string, b: string): boolean {
  return a.length >= 8 && a.slice(0, 8).toLowerCase() === b.slice(0, 8).toLowerCase();
}
const WRITE_CHUNK = 20;
const RESPONSE_TIMEOUT_MS = 6000;
const POST_NOTIFY_SETTLE_MS = 500;
const MAX_LOG_PAGES = 25;

export class BleLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleLockError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LockSession {
  private writeHandle = 0;
  private reassembler = new FrameReassembler();
  private inbox: Frame[] = [];
  private waiter: (() => void) | undefined;
  private disconnected = false;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly central: BleCentral,
    private readonly key: BleKey,
    private readonly log: TTLockLogger,
    private readonly label: string,
  ) {}

  private readonly startedAt = Date.now();
  private lastMark = this.startedAt;
  private readonly timings: string[] = [];

  /** Record how long the last phase took, for the debug log. */
  mark(phase: string): void {
    const now = Date.now();
    this.timings.push(`${phase} ${now - this.lastMark}ms`);
    this.lastMark = now;
  }

  /** e.g. "connect 2100ms, services 80ms, ... (total 3200ms)" */
  get timingSummary(): string {
    return `${this.timings.join(', ')} (total ${Date.now() - this.startedAt}ms)`;
  }

  /** Connect (retrying, since a sleeping lock may miss the first attempts) and prepare the GATT link. */
  async open(deadline: number): Promise<void> {
    await this.connect(deadline, true);
    let services = await this.central.getServices(this.key.lockMac);
    this.mark('services');
    if (!this.findCharacteristics(services)) {
      // A stale service cache on the proxy: reconnect with a fresh discovery.
      this.log.debug(`${this.label}: TTLock service missing from the cached services, rediscovering`);
      await this.central.disconnectDevice(this.key.lockMac);
      await this.connect(deadline, false);
      services = await this.central.getServices(this.key.lockMac);
      this.mark('services (fresh)');
    }
    const notify = this.findCharacteristics(services);
    if (!notify) throw new BleLockError('the lock does not expose the TTLock Bluetooth service');
    await this.central.startNotify(this.key.lockMac, notify);
    await sleep(POST_NOTIFY_SETTLE_MS);
    this.mark('notify');
    // Some firmware only starts answering after one ATT read.
    const battery = services.flatMap((s) => s.characteristics).find((c) => sameUuid(c.uuid, BATTERY_CHAR));
    if (battery) {
      await this.central.read(this.key.lockMac, battery.handle);
      this.mark('wake read');
    }
  }

  private async connect(deadline: number, useCache: boolean): Promise<void> {
    const mac = this.key.lockMac;
    let lastError: Error | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1500) break;
      attempts = attempt;
      try {
        await this.central.connectDevice(mac, Math.min(remaining, 10000), useCache);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error as Error;
        this.log.debug(`${this.label}: Bluetooth connect attempt ${attempt} failed: ${lastError.message}`);
        // Cancel the pending connection on the proxy, but don't let that eat the time budget.
        await Promise.race([this.central.disconnectDevice(mac), sleep(1000)]);
        await sleep(200);
      }
    }
    if (lastError) throw new BleLockError(`could not connect over Bluetooth: ${lastError.message}`);
    if (Date.now() >= deadline) throw new BleLockError('could not connect over Bluetooth in time');
    this.mark(attempts > 1 ? `connect (${attempts} attempts)` : 'connect');
    if (!this.cleanups.length) {
      this.cleanups.push(this.central.onNotify(mac, (_handle, data) => this.onData(data)));
      this.cleanups.push(
        this.central.onDisconnect(mac, () => {
          this.disconnected = true;
          this.waiter?.();
        }),
      );
    }
    this.disconnected = false;
  }

  /** Pick the write/notify characteristics; returns the notify one, or undefined if absent. */
  private findCharacteristics(services: GattService[]): GattCharacteristic | undefined {
    for (const profile of GATT_PROFILES) {
      const service = services.find((s) => sameUuid(s.uuid, profile.service));
      const write = service?.characteristics.find((c) => sameUuid(c.uuid, profile.write));
      const notifyChar = service?.characteristics.find((c) => sameUuid(c.uuid, profile.notify));
      if (write && notifyChar) {
        this.writeHandle = write.handle;
        return notifyChar;
      }
    }
    return undefined;
  }

  async close(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    await this.central.disconnectDevice(this.key.lockMac);
  }

  async unlock(): Promise<void> {
    await this.control(CMD_UNLOCK, 'unlock');
  }

  async lock(): Promise<void> {
    await this.control(CMD_LOCK, 'lock');
  }

  async queryState(): Promise<{ locked?: boolean; battery?: number }> {
    return parseQueryState(await this.exchange(CMD_QUERY_STATE, payloadQueryState()));
  }

  /** Read the records the lock has not synced yet (oldest first). */
  async readNewRecords(maxEntries = 25): Promise<LockLogEntry[]> {
    const all: LockLogEntry[] = [];
    const seen = new Set<number>();
    let sequence = 0xffff;
    for (let page = 0; page < MAX_LOG_PAGES; page++) {
      const { entries, lastSequence } = parseOperateLog(await this.exchange(CMD_GET_OPERATE_LOG, payloadOperateLog(sequence)));
      const fresh = entries.filter((e) => !seen.has(e.recordNumber));
      if (!fresh.length) break;
      for (const entry of fresh) seen.add(entry.recordNumber);
      all.push(...fresh);
      if (all.length >= maxEntries) return all.slice(0, maxEntries);
      if (lastSequence === 0 || lastSequence === sequence) break;
      sequence = lastSequence;
    }
    return all;
  }

  private async control(command: number, label: string): Promise<void> {
    const ps = parseCheckUserTime(await this.exchange(CMD_CHECK_USER_TIME, payloadCheckUserTime()));
    this.mark('handshake');
    const plain = await this.exchange(command, payloadUnlock(ps, this.key.unlockKey));
    this.mark(label);
    const { status, data } = parseEnvelope(plain);
    if (status !== 0x01) throw new BleLockError(`the lock refused to ${label} (status ${status}, error ${data.toString('hex')})`);
  }

  /** Send one command and wait for the reply that echoes it; other frames are pushes. */
  private async exchange(command: number, payload: Buffer): Promise<Buffer> {
    if (this.disconnected) throw new BleLockError('the lock dropped the Bluetooth connection');
    const wire = Frame.forLock(this.key.lockVersion, command, payload, this.key.aesKey).build();
    for (let i = 0; i < wire.length; i += WRITE_CHUNK) {
      await this.central.write(this.key.lockMac, this.writeHandle, wire.subarray(i, i + WRITE_CHUNK));
    }
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    for (;;) {
      const frame = this.inbox.shift();
      if (frame) {
        let plain: Buffer;
        try {
          plain = aesDecrypt(frame.data, this.key.aesKey);
        } catch {
          throw new BleLockError('could not decrypt the lock reply; the Bluetooth key is probably wrong');
        }
        if (plain.length >= 2 && plain[0] === command) return plain;
        this.log.debug(`${this.label}: push frame while waiting for 0x${command.toString(16)}: ${plain.toString('hex')}`);
        continue;
      }
      if (this.disconnected) throw new BleLockError('the lock dropped the Bluetooth connection');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BleLockError(`the lock did not answer command 0x${command.toString(16)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = undefined;
    }
  }

  private onData(data: Buffer): void {
    const frames = this.reassembler.feed(data);
    if (!frames.length) return;
    this.inbox.push(...frames);
    this.waiter?.();
  }
}
