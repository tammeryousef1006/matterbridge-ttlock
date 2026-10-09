import { randomBytes } from 'crypto';
import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, bridgedNode, doorLock, powerSource } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { DoorLock, PowerSource } from 'matterbridge/matter/clusters';

import { LockAdvertisement, LockLogEntry } from './ble/commands.js';
import { normalizeMac } from './ble/keys.js';
import { KeyValueStore, LocalController } from './local.js';
import { METHOD_LABELS, OperationMethod, RecordInfo, classifyCloudRecord, classifyLockRecord } from './records.js';
import { TTLockApi, TTLockLock, TTLockOpenState, errorMessage } from './ttlockApi.js';
import { CloudRecord, WebhookServer, buildWebhookUrl } from './webhook.js';

export type ConnectionMode = 'auto' | 'local' | 'cloud';

export interface TTLockPlatformConfig extends PlatformConfig {
  ttlock_client_id: string;
  ttlock_client_secret: string;
  ttlock_username?: string;
  ttlock_password?: string;
  ttlock_access_token?: string;
  ttlock_api_base_url?: string;
  refreshInterval?: number;
  whiteList?: string[];
  blackList?: string[];
  webhook?: {
    enabled?: boolean;
    publicUrl?: string;
    port?: number;
    url?: string;
  };
  localControl?: {
    mode?: ConnectionMode;
    espHost?: string;
    espPort?: number;
    espEncryptionKey?: string;
    espPassword?: string;
    bluetoothKeys?: string;
    useAppAccount?: boolean;
    verificationCode?: string;
    readLockHistory?: boolean;
  };
}

interface TTLockDevice {
  lock: TTLockLock;
  name: string;
  endpoint: MatterbridgeEndpoint;
  /** When we last sent a lock/unlock, to tell our own changes from someone at the door. */
  lastCommandAt: number;
  /** When the known lock state last changed (by any source), to ignore older records. */
  lastStateAt: number;
  relockTimer?: NodeJS.Timeout;
}

export const DEFAULT_TTLOCK_API_BASE_URL = 'https://api.sciener.com';
const DEFAULT_REFRESH_INTERVAL_S = 300;
const MIN_REFRESH_INTERVAL_S = 30;
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;
const DEFAULT_WEBHOOK_PORT = 8090;
const OWN_COMMAND_WINDOW_MS = 20_000;
/** Cloud records of our own commands can arrive this late. */
const OWN_RECORD_WINDOW_MS = 60_000;
/** History is read later than webhooks arrive, so its records of our commands can be older. */
const OWN_HISTORY_WINDOW_MS = 5 * 60_000;
/** A lock heard over Bluetooth this recently has its state taken from the broadcasts only. */
const LIVE_STATE_MS = 2 * 60_000;
const LOCAL_BUDGET_AUTO_MS = 15_000;
/** In auto mode, how long Bluetooth may try alone before the cloud is tried in parallel. */
const BLUETOOTH_HEAD_START_MS = 4_000;
const LOCAL_BUDGET_LOCAL_MS = 30_000;
/** A lock heard over Bluetooth this recently doesn't need its state polled from the cloud. */
const LOCAL_FRESH_MS = 10 * 60_000;
const SENSITIVE_KEYS = ['ttlock_client_secret', 'ttlock_password', 'ttlock_access_token'];
const SENSITIVE_LOCAL_KEYS = ['espEncryptionKey', 'espPassword', 'bluetoothKeys', 'verificationCode'];

const OPERATION_SOURCE: Record<OperationMethod, DoorLock.OperationSource> = {
  app: DoorLock.OperationSource.Remote,
  passcode: DoorLock.OperationSource.Keypad,
  card: DoorLock.OperationSource.Rfid,
  fingerprint: DoorLock.OperationSource.Biometric,
  face: DoorLock.OperationSource.Biometric,
  palm: DoorLock.OperationSource.Biometric,
  key: DoorLock.OperationSource.Manual,
  inside: DoorLock.OperationSource.Manual,
  remote: DoorLock.OperationSource.Remote,
  gateway: DoorLock.OperationSource.Remote,
  qr: DoorLock.OperationSource.ProprietaryRemote,
  auto: DoorLock.OperationSource.Auto,
  other: DoorLock.OperationSource.Unspecified,
};

export class TTLockPlatform extends MatterbridgeDynamicPlatform {
  private readonly ttlockConfig: TTLockPlatformConfig;
  private readonly api: TTLockApi;
  private readonly devices = new Map<number, TTLockDevice>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private local: LocalController | undefined;
  private webhook: WebhookServer | undefined;
  private readonly recentCloudRecords: string[] = [];

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion === 'function' && !this.verifyMatterbridgeVersion('3.0.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.0.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.ttlockConfig = config as TTLockPlatformConfig;
    this.log.debug('Received configuration:', JSON.stringify(redact(config), null, 2));

    const clientId = this.ttlockConfig.ttlock_client_id?.trim();
    const clientSecret = this.ttlockConfig.ttlock_client_secret?.trim();
    if (!clientId || !clientSecret) {
      throw new Error('Missing TTLock client ID or client secret in the plugin configuration.');
    }
    const username = this.ttlockConfig.ttlock_username?.trim();
    const accessToken = this.ttlockConfig.ttlock_access_token?.trim();
    if (!(username && this.ttlockConfig.ttlock_password) && !accessToken) {
      this.log.warn('Missing TTLock username/password and access token. One authentication method is required.');
    }

    const baseUrl = this.ttlockConfig.ttlock_api_base_url?.trim() || DEFAULT_TTLOCK_API_BASE_URL;
    this.api = new TTLockApi(
      { baseUrl, clientId, clientSecret, username, password: this.ttlockConfig.ttlock_password, accessToken },
      this.log,
    );
    this.log.info(`TTLock platform initialized. API base URL: ${baseUrl}`);
  }

  /** Local control is active when an ESP32 address is set and the mode isn't cloud-only. */
  private get mode(): ConnectionMode {
    const local = this.ttlockConfig.localControl;
    if (!local?.espHost?.trim()) return 'cloud';
    return local.mode === 'local' || local.mode === 'cloud' ? local.mode : 'auto';
  }

  private get store(): KeyValueStore {
    const context = this.context;
    return {
      get: async <T>(key: string, defaultValue?: T) => (context ? ((await context.get<T>(key, defaultValue as T)) as T) : (defaultValue as T)),
      set: async <T>(key: string, value: T) => {
        if (context) await context.set<T>(key, value);
      },
    };
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    let locks: TTLockLock[];
    try {
      await this.api.ensureAuthenticated();
      locks = await this.api.listLocks();
      await this.store.set('lockListCache', locks);
    } catch (error) {
      if (this.mode === 'cloud') {
        this.log.error(`Could not load TTLock devices: ${errorMessage(error)}`);
        return;
      }
      // With local control the locks still work offline, from the last known list.
      locks = await this.store.get<TTLockLock[]>('lockListCache', []);
      this.log.warn(`Could not reach the TTLock cloud (${errorMessage(error)}); using ${locks.length} lock(s) from the last successful start.`);
    }
    this.log.info(`Discovered ${locks.length} TTLock device(s).`);

    for (const lock of locks) {
      try {
        await this.addLock(lock);
      } catch (error) {
        this.log.error(`Failed to add TTLock ${lock.lockId}: ${errorMessage(error)}`);
      }
    }

    if (this.mode !== 'cloud') await this.startLocal();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.refreshStates();

    const interval = this.refreshIntervalSeconds();
    if (interval > 0) {
      this.log.info(`Refreshing lock state and battery from the cloud every ${interval} seconds.`);
      this.refreshTimer = setInterval(() => void this.refreshStates(), interval * 1000);
      this.refreshTimer.unref?.();
    }

    if (this.ttlockConfig.webhook?.enabled === true) await this.startWebhook();
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const device of this.devices.values()) if (device.relockTimer) clearTimeout(device.relockTimer);
    this.local?.stop();
    this.local = undefined;
    await this.webhook?.stop();
    this.webhook = undefined;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.ttlockConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
  }

  // ---- devices ------------------------------------------------------------

  private async addLock(lock: TTLockLock): Promise<void> {
    const name = (lock.lockAlias || lock.lockName || `TTLock ${lock.lockId}`).trim();
    // Keep the identity used by earlier versions so already-paired locks are not re-created
    const serial = `ttlock-${lock.lockId}`;

    this.setSelectDevice(serial, name, undefined, 'hub');
    if (!this.validateDevice([name, serial, String(lock.lockId)])) return;

    const battery = normalizeBattery(lock.electricQuantity);
    const endpoint = new MatterbridgeEndpoint([doorLock, bridgedNode, powerSource], { id: serial }, this.config.debug === true)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        0xfff1,
        'TTLock Inc.',
        `TTLock Model ${lock.lockMac ?? lock.lockId}`,
        parseInt(this.version.replace(/\D/g, '')) || 1,
        this.version,
        1,
        lock.firmwareRevision || '1.0.0',
      )
      .createDefaultDoorLockClusterServer(DoorLock.LockState.Locked, DoorLock.LockType.DeadBolt)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(battery ?? 100, chargeLevel(battery), 6000, 'AA', 4);

    const device: TTLockDevice = { lock, name, endpoint, lastCommandAt: 0, lastStateAt: 0 };

    endpoint.addCommandHandler('identify', ({ request }) => {
      this.log.info(`Identify request for ${name}: ${JSON.stringify(request)}`);
    });

    // Throwing from a handler fails the Matter command, so controllers show the error
    // and the lock state is left unchanged.
    endpoint.addCommandHandler('lockDoor', async () => {
      await this.runCommand(device, 'lock');
    });
    endpoint.addCommandHandler('unlockDoor', async () => {
      await this.runCommand(device, 'unlock');
    });

    await this.registerDevice(endpoint);
    this.devices.set(lock.lockId, device);
    this.log.info(`Registered TTLock ${name} (ID: ${lock.lockId}${lock.hasGateway === 1 ? '' : ', no gateway'})`);
    if (lock.hasGateway === 0 && this.mode === 'cloud') {
      this.log.warn(`${name} is not connected to a TTLock gateway; remote lock/unlock and state updates will not work.`);
    }
  }

  private async runCommand(device: TTLockDevice, action: 'lock' | 'unlock'): Promise<void> {
    const { name, lock } = device;
    const verb = action === 'lock' ? 'Locking' : 'Unlocking';
    const done = action === 'lock' ? 'locked' : 'unlocked';
    device.lastCommandAt = Date.now();
    const mode = this.mode;
    const finished = () => {
      device.lastCommandAt = device.lastStateAt = Date.now();
    };

    if (mode === 'local') {
      if (!this.local?.hasKey(lock.lockId)) {
        const error = new Error(`no Bluetooth key or ESP32 connection for ${name}, and the connection mode is "local only"`);
        this.log.error(`Failed to ${action} ${name}: ${error.message}`);
        throw error;
      }
      this.log.info(`${verb} ${name} over Bluetooth...`);
      try {
        await this.local.control(lock.lockId, action, LOCAL_BUDGET_LOCAL_MS);
      } catch (error) {
        this.log.error(`Failed to ${action} ${name} over Bluetooth: ${errorMessage(error)}`);
        throw error;
      }
      finished();
      this.log.info(`${name} ${done} over Bluetooth.`);
      return;
    }

    if (mode === 'auto' && this.local?.hasKey(lock.lockId)) {
      // Bluetooth gets a head start. If it isn't done by then (the lock is asleep, or busy
      // with the gateway), the cloud starts too, and whichever finishes first wins.
      this.log.info(`${verb} ${name} over Bluetooth...`);
      const abort = new AbortController();
      const ble = this.local.control(lock.lockId, action, LOCAL_BUDGET_AUTO_MS, abort.signal).then(() => 'bluetooth' as const);
      ble.catch(() => undefined);
      let headStart: NodeJS.Timeout | undefined;
      const first = await Promise.race([
        ble,
        new Promise<'slow'>((resolve) => {
          headStart = setTimeout(() => resolve('slow'), BLUETOOTH_HEAD_START_MS);
        }),
      ]).catch((error: unknown) => error as Error);
      clearTimeout(headStart);
      if (first === 'bluetooth') {
        finished();
        this.log.info(`${name} ${done} over Bluetooth.`);
        return;
      }
      if (first instanceof Error) {
        this.log.info(`Bluetooth ${action} of ${name} failed (${errorMessage(first)}); using the cloud instead.`);
      } else {
        this.log.info(`Bluetooth is slow to reach ${name}; also trying the TTLock cloud.`);
        const cloud = this.cloudControl(lock.lockId, action).then(() => 'cloud' as const);
        cloud.catch(() => undefined);
        let winner: 'bluetooth' | 'cloud';
        try {
          winner = await Promise.any([ble, cloud]);
        } catch (error) {
          const errors = (error as AggregateError).errors ?? [];
          const cloudError = errors[1] ?? error;
          this.log.error(`Failed to ${action} ${name}: Bluetooth: ${errorMessage(errors[0])}; cloud: ${errorMessage(cloudError)}`);
          throw cloudError;
        }
        // Don't let a late Bluetooth connection send the command a second time.
        if (winner === 'cloud') abort.abort();
        finished();
        this.log.info(`${name} ${done} ${winner === 'cloud' ? 'through the TTLock cloud' : 'over Bluetooth'}.`);
        return;
      }
    }

    this.log.info(`${verb} ${name} through the TTLock cloud...`);
    try {
      await this.cloudControl(lock.lockId, action);
      finished();
      this.log.info(`${name} ${done}.`);
    } catch (error) {
      this.log.error(`Failed to ${action} ${name}: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async cloudControl(lockId: number, action: 'lock' | 'unlock'): Promise<void> {
    if (action === 'lock') await this.api.lock(lockId);
    else await this.api.unlock(lockId);
  }

  // ---- state updates ------------------------------------------------------

  private async setLockState(device: TTLockDevice, locked: boolean, how: string): Promise<boolean> {
    const lockState = locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
    if (device.endpoint.getAttribute(DoorLock.Cluster.id, 'lockState') === lockState) return false;
    if (device.relockTimer) clearTimeout(device.relockTimer);
    device.relockTimer = undefined;
    this.log.info(`${device.name} is now ${locked ? 'locked' : 'unlocked'}${how}.`);
    device.lastStateAt = Date.now();
    await device.endpoint.setAttribute(DoorLock.Cluster.id, 'lockState', lockState, device.endpoint.log);
    return true;
  }

  private async emitOperation(device: TTLockDevice, operation: 'lock' | 'unlock', source: DoorLock.OperationSource, success: boolean): Promise<void> {
    const payload = {
      lockOperationType: operation === 'lock' ? DoorLock.LockOperationType.Lock : DoorLock.LockOperationType.Unlock,
      operationSource: source,
      userIndex: null,
      fabricIndex: null,
      sourceNode: null,
    };
    try {
      if (success) await device.endpoint.triggerEvent(DoorLock.Cluster.id, 'lockOperation', payload, device.endpoint.log);
      else await device.endpoint.triggerEvent(DoorLock.Cluster.id, 'lockOperationError', { ...payload, operationError: DoorLock.OperationError.InvalidCredential }, device.endpoint.log);
    } catch (error) {
      this.log.debug(`Could not send the lock operation event for ${device.name}: ${errorMessage(error)}`);
    }
  }

  /** Apply a lock/unlock record (from the webhook or the lock history). */
  private async applyRecord(device: TTLockDevice, info: RecordInfo, who: string | undefined, happenedAt?: number, ownWindowMs = OWN_RECORD_WINDOW_MS): Promise<void> {
    if (!info.operation) return;
    const label = METHOD_LABELS[info.method];
    const by = `${label}${who ? ` (${who})` : ''}`;
    // The cloud also reports the plugin's own commands (as "app"/"gateway"), seconds later.
    if (info.success && ['app', 'gateway', 'remote'].includes(info.method) && Date.now() - device.lastCommandAt < ownWindowMs) {
      this.log.info(`${device.name}: record of our own ${info.operation} command, ignored.`);
      return;
    }
    if (!info.success) {
      this.log.info(`${device.name}: failed ${info.operation} attempt with ${by}.`);
      await this.emitOperation(device, info.operation, OPERATION_SOURCE[info.method], false);
      return;
    }
    // A record older than the state we already know (e.g. the lock has auto-locked since)
    // is still reported as an event, but must not roll the state back.
    const plausible = happenedAt !== undefined && Math.abs(Date.now() - happenedAt) < 24 * 3600_000;
    // While the ESP32 hears the lock, its broadcasts are the source of truth for the state.
    const liveState = this.local?.seenRecently(device.lock.lockId, LIVE_STATE_MS) ?? false;
    const stale = liveState || (plausible && happenedAt! < device.lastStateAt - 3000);
    const changed = stale ? false : await this.setLockState(device, info.operation === 'lock', ` by ${by}`);
    if (!changed) this.log.info(`${device.name} ${info.operation === 'lock' ? 'locked' : 'unlocked'} by ${by}${stale && plausible ? ` ${Math.round((Date.now() - happenedAt!) / 1000)}s ago` : ''}.`);
    await this.emitOperation(device, info.operation, OPERATION_SOURCE[info.method], true);
    if (info.operation === 'unlock') this.scheduleRelock(device);
  }

  /** Without live Bluetooth state, assume the lock's auto-lock fires after its configured delay. */
  private scheduleRelock(device: TTLockDevice): void {
    const seconds = Number(device.lock.autoLockTime);
    if (!(seconds > 0) || this.local?.seenRecently(device.lock.lockId, LOCAL_FRESH_MS)) return;
    device.relockTimer = setTimeout(() => {
      device.relockTimer = undefined;
      void this.setLockState(device, true, ' (auto-lock)');
    }, seconds * 1000);
    device.relockTimer.unref?.();
  }

  // ---- local control ------------------------------------------------------

  private async startLocal(): Promise<void> {
    const cfg = this.ttlockConfig.localControl ?? {};
    const port = Number(cfg.espPort) || 6053;
    this.log.info(`Local control enabled (mode: ${this.mode}) through the ESP32 at ${cfg.espHost}:${port}.`);
    this.local = new LocalController(
      {
        espHost: cfg.espHost!.trim(),
        espPort: port,
        espEncryptionKey: cfg.espEncryptionKey?.trim(),
        espPassword: cfg.espPassword,
        manualKeysJson: cfg.bluetoothKeys,
        useAppAccount: cfg.useAppAccount !== false,
        appUsername: this.ttlockConfig.ttlock_username?.trim(),
        appPassword: this.ttlockConfig.ttlock_password,
        verificationCode: cfg.verificationCode,
        readHistory: cfg.readLockHistory === true,
      },
      this.store,
      this.log,
      {
        onAdvertisement: (lockId, adv) => void this.onAdvertisement(lockId, adv),
        onRecords: (lockId, records) => void this.onLockRecords(lockId, records),
      },
    );
    try {
      await this.local.start([...this.devices.values()].map((d) => d.lock));
    } catch (error) {
      this.log.error(`Local control could not start: ${errorMessage(error)}`);
    }
  }

  private async onAdvertisement(lockId: number, adv: LockAdvertisement): Promise<void> {
    const device = this.devices.get(lockId);
    if (!device) return;
    await this.updateBattery(device, normalizeBattery(adv.battery));
    if (adv.locked === undefined) return;
    const changed = await this.setLockState(device, adv.locked, ' (seen over Bluetooth)');
    const ours = Date.now() - device.lastCommandAt < OWN_COMMAND_WINDOW_MS;
    // Without a source that says who/how, still report that someone operated the lock.
    const detailed = this.ttlockConfig.webhook?.enabled === true || this.ttlockConfig.localControl?.readLockHistory === true;
    if (changed && !ours && !detailed) await this.emitOperation(device, adv.locked ? 'lock' : 'unlock', DoorLock.OperationSource.Unspecified, true);
  }

  private async onLockRecords(lockId: number, records: LockLogEntry[]): Promise<void> {
    const device = this.devices.get(lockId);
    if (!device) return;
    for (const record of records) {
      const info = classifyLockRecord(record.recordType);
      if (!info) {
        this.log.debug(`${device.name}: history record type ${record.recordType} (not a lock/unlock).`);
        continue;
      }
      const who = record.credential && info.method !== 'passcode' ? `#${record.credential}` : undefined;
      await this.applyRecord(device, info, who, undefined, OWN_HISTORY_WINDOW_MS);
    }
  }

  // ---- webhook ------------------------------------------------------------

  private async startWebhook(): Promise<void> {
    const cfg = this.ttlockConfig.webhook ?? {};
    const port = Number(cfg.port) || DEFAULT_WEBHOOK_PORT;
    let token = await this.store.get<string>('webhookToken', '');
    if (!token) {
      token = randomBytes(18).toString('base64url');
      await this.store.set('webhookToken', token);
    }
    this.webhook = new WebhookServer(port, token, (records) => void this.onCloudRecords(records), this.log);
    try {
      await this.webhook.start();
    } catch (error) {
      this.log.error(`Webhook could not start on port ${port}: ${errorMessage(error)}`);
      this.webhook = undefined;
      return;
    }
    const publicUrl = cfg.publicUrl?.trim();
    if (!publicUrl) {
      this.log.warn(`Webhook is listening on port ${port}, but no public URL is set. Fill in "Public URL" in the plugin settings so the plugin can show the full webhook URL.`);
      return;
    }
    if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(publicUrl)) {
      this.log.warn(`The webhook public URL ${publicUrl} looks like a local address. TTLock's servers cannot reach it; use an internet-reachable address (for example a Cloudflare Tunnel).`);
    }
    const url = buildWebhookUrl(publicUrl, token);
    this.log.info(`Webhook ready on port ${port}. Paste this URL as the callback URL of your TTLock Open Platform application: ${url}`);
    if (cfg.url !== url) {
      this.ttlockConfig.webhook = { ...cfg, url };
      try {
        this.saveConfig(this.config);
      } catch (error) {
        this.log.debug(`Could not save the webhook URL into the config: ${errorMessage(error)}`);
      }
    }
  }

  private async onCloudRecords(records: CloudRecord[]): Promise<void> {
    for (const record of records) {
      const dedupKey = `${record.lockId ?? record.lockMac}:${record.lockDate}:${record.recordType}:${record.recordTypeFromLock}`;
      if (record.lockDate !== undefined) {
        if (this.recentCloudRecords.includes(dedupKey)) continue;
        this.recentCloudRecords.push(dedupKey);
        if (this.recentCloudRecords.length > 200) this.recentCloudRecords.shift();
      }
      const device =
        (record.lockId !== undefined ? this.devices.get(record.lockId) : undefined) ??
        [...this.devices.values()].find((d) => record.lockMac && d.lock.lockMac && normalizeMac(d.lock.lockMac) === normalizeMac(record.lockMac));
      this.log.info(
        `Webhook record: lock ${record.lockId ?? record.lockMac}, type ${record.recordType ?? '-'}/${record.recordTypeFromLock ?? '-'}, ${record.success ? 'success' : 'failed'}${record.username ? `, by ${record.username}` : ''}${record.lockDate ? `, at ${new Date(record.lockDate).toISOString()}` : ''}.`,
      );
      if (!device) continue;
      if (record.battery !== undefined && !this.local?.seenRecently(device.lock.lockId, LOCAL_FRESH_MS)) await this.updateBattery(device, normalizeBattery(record.battery));
      const info =
        (record.recordTypeFromLock !== undefined ? classifyLockRecord(record.recordTypeFromLock) : undefined) ??
        (record.recordType !== undefined ? classifyCloudRecord(record.recordType) : undefined);
      if (!info) {
        this.log.debug(`${device.name}: webhook record type ${record.recordType}/${record.recordTypeFromLock} (not a lock/unlock).`);
        continue;
      }
      await this.applyRecord(device, { ...info, success: info.success && record.success }, record.username, record.lockDate);
    }
  }

  // ---- cloud polling ------------------------------------------------------

  /** Update battery levels from the lock list and lock state for gateway-connected locks. */
  private async refreshStates(): Promise<void> {
    if (this.refreshing || this.devices.size === 0) return;
    // In local-only mode the state comes from Bluetooth.
    if (this.mode === 'local') return;
    this.refreshing = true;
    try {
      let locks: TTLockLock[] = [];
      try {
        locks = await this.api.listLocks();
      } catch (error) {
        this.log.warn(`Failed to refresh TTLock device list: ${errorMessage(error)}`);
      }
      for (const lock of locks) {
        const device = this.devices.get(lock.lockId);
        if (!device) continue;
        device.lock = { ...device.lock, ...lock };
        // The lock's own Bluetooth broadcast is fresher than the cloud's battery value.
        if (!this.local?.seenRecently(lock.lockId, LOCAL_FRESH_MS)) await this.updateBattery(device, normalizeBattery(lock.electricQuantity));
      }

      for (const device of this.devices.values()) {
        if (device.lock.hasGateway === 0) continue;
        // Live Bluetooth state is more accurate than the cloud's; don't let a stale poll override it.
        if (this.local?.seenRecently(device.lock.lockId, LOCAL_FRESH_MS)) continue;
        try {
          const state = await this.api.queryOpenState(device.lock.lockId);
          if (state === TTLockOpenState.Unknown) continue;
          await this.setLockState(device, state === TTLockOpenState.Locked, '');
        } catch (error) {
          this.log.debug(`Could not query lock state of ${device.name}: ${errorMessage(error)}`);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async updateBattery(device: TTLockDevice, percent: number | undefined): Promise<void> {
    if (percent === undefined) return;
    const { endpoint } = device;
    if (endpoint.getAttribute(PowerSource.Cluster.id, 'batPercentRemaining') === percent * 2) return;
    await endpoint.setAttribute(PowerSource.Cluster.id, 'batPercentRemaining', percent * 2, endpoint.log);
    await endpoint.setAttribute(PowerSource.Cluster.id, 'batChargeLevel', chargeLevel(percent), endpoint.log);
    await endpoint.setAttribute(PowerSource.Cluster.id, 'batReplacementNeeded', percent <= LOW_BATTERY_PERCENT, endpoint.log);
  }
}

function normalizeBattery(value: unknown): number | undefined {
  const percent = Number(value);
  if (value === undefined || value === null || !Number.isFinite(percent) || percent < 0) return undefined;
  return Math.min(100, Math.round(percent));
}

function chargeLevel(percent: number | undefined): PowerSource.BatChargeLevel {
  if (percent === undefined || percent > LOW_BATTERY_PERCENT) return PowerSource.BatChargeLevel.Ok;
  return percent > CRITICAL_BATTERY_PERCENT ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Critical;
}

function redact(config: PlatformConfig): PlatformConfig {
  const copy = { ...config } as TTLockPlatformConfig;
  for (const key of SENSITIVE_KEYS) if (copy[key]) copy[key] = '********';
  if (copy.localControl) {
    const local = { ...copy.localControl } as Record<string, unknown>;
    for (const key of SENSITIVE_LOCAL_KEYS) if (local[key]) local[key] = '********';
    copy.localControl = local as TTLockPlatformConfig['localControl'];
  }
  return copy;
}
