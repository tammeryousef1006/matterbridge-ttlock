import { MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, bridgedNode, doorLock, powerSource } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { DoorLock, PowerSource } from 'matterbridge/matter/clusters';

import { TTLockApi, TTLockLock, TTLockOpenState, errorMessage } from './ttlockApi.js';

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
}

interface TTLockDevice {
  lock: TTLockLock;
  name: string;
  endpoint: MatterbridgeEndpoint;
}

export const DEFAULT_TTLOCK_API_BASE_URL = 'https://api.sciener.com';
const DEFAULT_REFRESH_INTERVAL_S = 300;
const MIN_REFRESH_INTERVAL_S = 30;
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;
const SENSITIVE_KEYS = ['ttlock_client_secret', 'ttlock_password', 'ttlock_access_token'];

export class TTLockPlatform extends MatterbridgeDynamicPlatform {
  private readonly ttlockConfig: TTLockPlatformConfig;
  private readonly api: TTLockApi;
  private readonly devices = new Map<number, TTLockDevice>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;

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

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    let locks: TTLockLock[];
    try {
      await this.api.ensureAuthenticated();
      locks = await this.api.listLocks();
    } catch (error) {
      this.log.error(`Could not load TTLock devices: ${errorMessage(error)}`);
      return;
    }
    this.log.info(`Discovered ${locks.length} TTLock device(s).`);

    for (const lock of locks) {
      try {
        await this.addLock(lock);
      } catch (error) {
        this.log.error(`Failed to add TTLock ${lock.lockId}: ${errorMessage(error)}`);
      }
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.refreshStates();

    const interval = this.refreshIntervalSeconds();
    if (interval > 0) {
      this.log.info(`Refreshing lock state and battery every ${interval} seconds.`);
      this.refreshTimer = setInterval(() => void this.refreshStates(), interval * 1000);
      this.refreshTimer.unref?.();
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private refreshIntervalSeconds(): number {
    const value = Number(this.ttlockConfig.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(MIN_REFRESH_INTERVAL_S, Math.round(value));
  }

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

    endpoint.addCommandHandler('identify', ({ request }) => {
      this.log.info(`Identify request for ${name}: ${JSON.stringify(request)}`);
    });

    // Throwing from a handler fails the Matter command, so controllers show the error
    // and the lock state is left unchanged.
    endpoint.addCommandHandler('lockDoor', async () => {
      this.log.info(`Locking ${name}...`);
      try {
        await this.api.lock(lock.lockId);
        this.log.info(`${name} locked.`);
      } catch (error) {
        this.log.error(`Failed to lock ${name}: ${errorMessage(error)}`);
        throw error;
      }
    });

    endpoint.addCommandHandler('unlockDoor', async () => {
      this.log.info(`Unlocking ${name}...`);
      try {
        await this.api.unlock(lock.lockId);
        this.log.info(`${name} unlocked.`);
      } catch (error) {
        this.log.error(`Failed to unlock ${name}: ${errorMessage(error)}`);
        throw error;
      }
    });

    await this.registerDevice(endpoint);
    this.devices.set(lock.lockId, { lock, name, endpoint });
    this.log.info(`Registered TTLock ${name} (ID: ${lock.lockId}${lock.hasGateway === 1 ? '' : ', no gateway'})`);
    if (lock.hasGateway === 0) {
      this.log.warn(`${name} is not connected to a TTLock gateway; remote lock/unlock and state updates will not work.`);
    }
  }

  /** Update battery levels from the lock list and lock state for gateway-connected locks. */
  private async refreshStates(): Promise<void> {
    if (this.refreshing || this.devices.size === 0) return;
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
        await this.updateBattery(device, normalizeBattery(lock.electricQuantity));
      }

      for (const device of this.devices.values()) {
        if (device.lock.hasGateway === 0) continue;
        try {
          const state = await this.api.queryOpenState(device.lock.lockId);
          if (state === TTLockOpenState.Unknown) continue;
          const lockState = state === TTLockOpenState.Locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
          if (device.endpoint.getAttribute(DoorLock.Cluster.id, 'lockState') !== lockState) {
            this.log.info(`${device.name} is now ${state === TTLockOpenState.Locked ? 'locked' : 'unlocked'}.`);
            await device.endpoint.setAttribute(DoorLock.Cluster.id, 'lockState', lockState, device.endpoint.log);
          }
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
  const copy: PlatformConfig = { ...config };
  for (const key of SENSITIVE_KEYS) if (copy[key]) copy[key] = '********';
  return copy;
}
