/**
 * Local control of TTLock locks through an ESPHome Bluetooth proxy:
 * live state from advertisements, lock/unlock over Bluetooth, and
 * (optionally) the lock's own history of who opened it and how.
 */
import { randomBytes } from 'crypto';

import { AppCloudError, TTLockAppCloud } from './ble/appCloud.js';
import { LockAdvertisement, LockLogEntry, parseAdvertisement } from './ble/commands.js';
import { EspProxy, ManufacturerAdvertisement } from './ble/espProxy.js';
import { BleKey, keyFromLockData, keysFromConfigText, normalizeMac } from './ble/keys.js';
import { BleLockError, LockSession } from './ble/lockSession.js';
import { TTLockLock, TTLockLogger } from './ttlockApi.js';

export interface LocalOptions {
  espHost: string;
  espPort?: number;
  espEncryptionKey?: string;
  espPassword?: string;
  manualKeysJson?: string;
  useAppAccount: boolean;
  appUsername?: string;
  appPassword?: string;
  verificationCode?: string;
  readHistory: boolean;
}

/** Persistent storage the controller uses (the plugin's Matterbridge context). */
export interface KeyValueStore {
  get<T>(key: string, defaultValue?: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface LocalCallbacks {
  onAdvertisement(lockId: number, adv: LockAdvertisement): void;
  onRecords(lockId: number, records: LockLogEntry[]): void;
}

interface StoredKey {
  lockMac: string;
  lockId?: number;
  aesKey: string;
  unlockKey: string;
  lockVersion: BleKey['lockVersion'];
  uid: number;
  source: string;
}

const HISTORY_RETRY_MS = 120_000;
const SILENT_AFTER_MS = 120_000;
const MAX_SEEN_RECORDS = 300;

function storeKey(key: BleKey): StoredKey {
  return { ...key, aesKey: key.aesKey.toString('hex') };
}

function loadKey(stored: StoredKey): BleKey {
  return { ...stored, aesKey: Buffer.from(stored.aesKey, 'hex') };
}

export class LocalController {
  private proxy: EspProxy | undefined;
  private readonly keys = new Map<string, BleKey>(); // by MAC
  private readonly lockIdsByMac = new Map<string, number>();
  private readonly lastAdvertisement = new Map<string, LockAdvertisement>();
  private readonly lastSeenAt = new Map<string, number>();
  private readonly silentSince = new Map<string, number>();
  private readonly lastFlags = new Map<string, number>();
  private watchdog: NodeJS.Timeout | undefined;
  private readonly historyBusy = new Set<string>();
  private readonly historyAttemptAt = new Map<string, number>();
  private seenRecords: Record<string, number[]> = {};
  private seededLocks = new Set<string>();
  private advertisementSeen = new Set<string>();

  constructor(
    private readonly options: LocalOptions,
    private readonly store: KeyValueStore,
    private readonly log: TTLockLogger,
    private readonly callbacks: LocalCallbacks,
  ) {}

  get connected(): boolean {
    return this.proxy?.ready ?? false;
  }

  /** Whether the ESP32 received a broadcast from this lock within `ms`. */
  seenRecently(lockId: number, ms: number): boolean {
    const mac = this.macOf(lockId);
    return !!mac && this.connected && Date.now() - (this.lastSeenAt.get(mac) ?? 0) < ms;
  }

  hasKey(lockId: number): boolean {
    const mac = this.macOf(lockId);
    return !!mac && this.keys.has(mac);
  }

  private macOf(lockId: number): string | undefined {
    for (const [mac, id] of this.lockIdsByMac) if (id === lockId) return mac;
    return undefined;
  }

  /** Load keys for the given locks and connect to the ESP32. */
  async start(locks: TTLockLock[]): Promise<void> {
    for (const lock of locks) if (lock.lockMac) this.lockIdsByMac.set(normalizeMac(lock.lockMac), lock.lockId);
    this.seenRecords = await this.store.get<Record<string, number[]>>('localSeenRecords', {});
    this.seededLocks = new Set(Object.keys(this.seenRecords));
    await this.loadKeys(locks);

    this.proxy = new EspProxy({ host: this.options.espHost, port: this.options.espPort, encryptionKey: this.options.espEncryptionKey, password: this.options.espPassword }, this.log);
    this.proxy.on('advertisement', (adv: ManufacturerAdvertisement) => this.handleAdvertisement(adv));
    this.proxy.on('ready', () => {
      setTimeout(() => {
        if (this.proxy?.ready && this.proxy.receivedAdvertisements === 0) {
          this.log.warn(
            'The ESP32 proxy has not sent any Bluetooth advertisements yet. If Home Assistant (or another program) also uses this ESP32 for Bluetooth, remove it there: an ESPHome Bluetooth proxy only serves one client.',
          );
        }
      }, 60_000).unref?.();
    });
    this.proxy.start();

    // A lock that is connected to something (or out of range) stops broadcasting; say so once.
    this.watchdog = setInterval(() => {
      if (!this.proxy?.ready) return;
      for (const [mac, lockId] of this.lockIdsByMac) {
        const lastSeen = this.lastSeenAt.get(mac);
        if (lastSeen === undefined || this.silentSince.has(mac) || Date.now() - lastSeen < SILENT_AFTER_MS) continue;
        this.silentSince.set(mac, lastSeen);
        this.log.info(
          `No Bluetooth broadcasts from lock ${lockId} for ${Math.round((Date.now() - lastSeen) / 1000)}s. The lock may still be connected to the ESP32 or another device (TTLock app, gateway), or be out of range.`,
        );
      }
    }, 30_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.proxy?.stop();
    this.proxy = undefined;
  }

  // ---- keys ---------------------------------------------------------------

  private async loadKeys(locks: TTLockLock[]): Promise<void> {
    const wanted = locks.filter((l) => l.lockMac);
    const missing = () => wanted.filter((l) => !this.keys.has(normalizeMac(l.lockMac!)));
    const add = (key: BleKey) => {
      if (!this.keys.has(key.lockMac) && this.lockIdsByMac.has(key.lockMac)) this.keys.set(key.lockMac, key);
    };

    // 1. Keys pasted into the configuration
    if (this.options.manualKeysJson?.trim()) {
      try {
        const manual = keysFromConfigText(this.options.manualKeysJson);
        manual.forEach(add);
        if (!manual.length) this.log.warn('The "Bluetooth keys (JSON)" field contains no usable key (expected objects with aesKeyStr, unlockKey/lockKey, lockVersion and lockMac).');
      } catch (error) {
        this.log.warn(`Ignoring the Bluetooth keys field: ${(error as Error).message}`);
      }
    }

    // 2. The lockData returned by the TTLock Open API (experimental). Always tried
    // and logged, so test logs show whether this route works for a lock.
    for (const lock of wanted) {
      const result = keyFromLockData(lock.lockData, lock.lockMac!, lock.lockId);
      const usedAlready = this.keys.has(normalizeMac(lock.lockMac!));
      if (result.key) add(result.key);
      this.log.info(`TTLock API lockData for ${lock.lockAlias ?? lock.lockId}: ${result.key ? 'contains a usable Bluetooth key' : 'no usable key'} (${result.diagnostic})${usedAlready ? '; using the configured key' : ''}.`);
    }

    // 3. Keys cached from a previous app-account download
    if (missing().length) {
      const cached = await this.store.get<StoredKey[]>('localKeyCache', []);
      cached.map(loadKey).forEach(add);
    }

    // 4. Download from the TTLock app account
    if (missing().length && this.options.useAppAccount) {
      const downloaded = await this.downloadAppKeys();
      downloaded.forEach(add);
    }

    for (const lock of wanted) {
      const key = this.keys.get(normalizeMac(lock.lockMac!));
      if (key) this.log.info(`Local control ready for ${lock.lockAlias ?? lock.lockId} (key from ${key.source}).`);
      else this.log.warn(`No Bluetooth key for ${lock.lockAlias ?? lock.lockId}: it will be controlled through the cloud. See the README section "Local control" for how to provide one.`);
    }
  }

  private async downloadAppKeys(): Promise<BleKey[]> {
    const { appUsername: username, appPassword: password } = this.options;
    if (!username || !password) {
      this.log.info('Skipping the TTLock app account key download: no username/password configured.');
      return [];
    }
    let uniqueId = await this.store.get<string>('appUniqueId', '');
    if (!uniqueId) {
      uniqueId = randomBytes(16).toString('hex');
      await this.store.set('appUniqueId', uniqueId);
    }
    const cloud = new TTLockAppCloud(uniqueId);
    try {
      await cloud.discoverSite();
      const code = this.options.verificationCode?.trim();
      try {
        await cloud.login(username, password);
      } catch (error) {
        if (!(error instanceof AppCloudError) || !error.needsVerification) throw error;
        if (code) {
          await cloud.validateNewDevice(username, code);
          await cloud.login(username, password);
        } else {
          const requestedAt = await this.store.get<number>('appCodeRequestedAt', 0);
          if (Date.now() - requestedAt > 10 * 60_000) {
            await cloud.requestVerificationCode(username);
            await this.store.set('appCodeRequestedAt', Date.now());
          }
          this.log.warn(
            'TTLock sent a verification code to your account email/phone to approve this device. Enter it in the plugin settings under "Local control" > "Verification code", save, and restart.',
          );
          return [];
        }
      }
      const keys = await cloud.listKeys();
      this.log.info(`Downloaded ${keys.length} Bluetooth key(s) from the TTLock app account.`);
      await this.store.set('localKeyCache', keys.map(storeKey));
      return keys;
    } catch (error) {
      this.log.warn(`Could not download Bluetooth keys from the TTLock app account: ${(error as Error).message}`);
      return [];
    }
  }

  // ---- advertisements -----------------------------------------------------

  private handleAdvertisement(adv: ManufacturerAdvertisement): void {
    const mac = normalizeMac(adv.mac);
    const lockId = this.lockIdsByMac.get(mac);
    if (lockId === undefined) return;
    const decoded = parseAdvertisement(adv.data);
    if (!decoded || decoded.mac !== mac) return;
    this.proxy?.rememberAddressType(mac, adv.addressType);
    this.lastSeenAt.set(mac, Date.now());
    if (!this.advertisementSeen.has(mac)) {
      this.advertisementSeen.add(mac);
      this.log.info(`The ESP32 can see lock ${lockId} (signal ${adv.rssi ?? '?'} dBm).`);
    }
    if (this.silentSince.has(mac)) {
      this.log.info(`Lock ${lockId} is broadcasting over Bluetooth again (it was silent for ${Math.round((Date.now() - this.silentSince.get(mac)!) / 1000)}s).`);
      this.silentSince.delete(mac);
    }
    const previous = this.lastAdvertisement.get(mac);
    this.lastAdvertisement.set(mac, decoded);
    const flags = adv.data.length > 3 ? adv.data[3] : -1;
    if (flags !== this.lastFlags.get(mac)) {
      // Info level during the beta, to learn how real locks report fingerprint/keypad use.
      this.log.info(
        `Bluetooth broadcast from lock ${lockId}: ${decoded.dormant ? 'asleep (state unknown)' : decoded.locked ? 'locked' : 'unlocked'}, battery ${decoded.battery}%${decoded.hasNewRecords ? ', has new records' : ''} [flags 0x${flags.toString(16).padStart(2, '0')}, data ${adv.data.toString('hex')}].`,
      );
      this.lastFlags.set(mac, flags);
    }
    if (!previous || previous.locked !== decoded.locked || previous.battery !== decoded.battery || previous.hasNewRecords !== decoded.hasNewRecords) {
      this.callbacks.onAdvertisement(lockId, decoded);
    }
    if (decoded.hasNewRecords && this.options.readHistory && this.keys.has(mac)) void this.fetchHistory(mac, lockId);
  }

  // ---- commands -----------------------------------------------------------

  /** Lock or unlock over Bluetooth within `budgetMs`. Throws if it could not be done. */
  async control(lockId: number, action: 'lock' | 'unlock', budgetMs: number): Promise<void> {
    const mac = this.macOf(lockId);
    const key = mac ? this.keys.get(mac) : undefined;
    if (!mac || !key) throw new BleLockError('no Bluetooth key for this lock');
    const proxy = this.proxy;
    if (!proxy?.ready) throw new BleLockError('the ESP32 Bluetooth proxy is not connected');
    const deadline = Date.now() + budgetMs;
    // Report success as soon as the lock confirms; the Bluetooth disconnect finishes afterwards
    // (still inside the exclusive section, so the next session waits for it).
    return new Promise<void>((resolve, reject) => {
      void proxy
        .exclusive(async () => {
          const session = new LockSession(proxy, key, this.log, `lock ${lockId}`);
          try {
            await session.open(deadline);
            if (action === 'unlock') await session.unlock();
            else await session.lock();
            resolve();
          } catch (error) {
            this.log.info(`Bluetooth ${action} of lock ${lockId} failed after: ${session.timingSummary}`);
            reject(error);
            return;
          } finally {
            await session.close();
          }
          session.mark('disconnect');
          this.log.info(`Bluetooth ${action} timing for lock ${lockId}: ${session.timingSummary}`);
        })
        .catch(reject);
    });
  }

  // ---- history ------------------------------------------------------------

  private async fetchHistory(mac: string, lockId: number): Promise<void> {
    if (this.historyBusy.has(mac) || Date.now() - (this.historyAttemptAt.get(mac) ?? 0) < HISTORY_RETRY_MS) return;
    const proxy = this.proxy;
    const key = this.keys.get(mac);
    if (!proxy?.ready || !key) return;
    this.historyBusy.add(mac);
    this.historyAttemptAt.set(mac, Date.now());
    try {
      const entries = await proxy.exclusive(async () => {
        const session = new LockSession(proxy, key, this.log, `lock ${lockId}`);
        try {
          await session.open(Date.now() + 30_000);
          return await session.readNewRecords();
        } finally {
          await session.close();
        }
      });
      const seen = new Set(this.seenRecords[mac] ?? []);
      const fresh = entries.filter((e) => !seen.has(e.recordNumber));
      for (const entry of fresh) seen.add(entry.recordNumber);
      this.seenRecords[mac] = [...seen].slice(-MAX_SEEN_RECORDS);
      await this.store.set('localSeenRecords', this.seenRecords);
      if (!this.seededLocks.has(mac)) {
        // The first read returns old history; don't replay it.
        this.seededLocks.add(mac);
        this.log.info(`Read ${fresh.length} existing history record(s) from lock ${lockId}; new ones will be reported from now on.`);
        return;
      }
      if (fresh.length) this.callbacks.onRecords(lockId, fresh);
    } catch (error) {
      this.log.debug(`Could not read the history of lock ${lockId}: ${(error as Error).message}`);
    } finally {
      this.historyBusy.delete(mac);
    }
  }
}
