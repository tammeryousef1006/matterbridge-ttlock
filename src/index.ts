import { Matterbridge, MatterbridgeEndpoint, MatterbridgeDynamicPlatform, PlatformConfig, doorLockDevice, bridgedNode, DoorLock } from "matterbridge";

import axios from 'axios';
import * as crypto from 'crypto';

interface TTLockPlatformConfig extends PlatformConfig {
  ttlock_client_id: string;
  ttlock_client_secret: string;
  ttlock_username?: string;
  ttlock_password?: string;
  ttlock_access_token?: string;
  ttlock_api_base_url?: string;
}

interface TTLockTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  uid?: number;
  openid?: string;
  errcode?: number;
  errmsg?: string;
}

interface TTLockDeviceData {
  lockId: number;
  lockAlias: string;
  lockMac: string;
  lockData: string;
}

interface TTLockDeviceListResponse {
  list: TTLockDeviceData[];
  pageNo: number;
  pageSize: number;
  pages: number;
  total: number;
  errcode?: number;
  errmsg?: string;
}

interface TTLockCommandResponse {
    errcode?: number;
    errmsg?: string;
    description?: string;
}

const DEFAULT_TTLOCK_API_BASE_URL = 'https://api.sciener.com';

export class TTLockPlatform extends MatterbridgeDynamicPlatform {
  public log: any; // This will be the instance passed by Matterbridge
  public config: PlatformConfig;
  public version: string;

  private ttlockConfig: TTLockPlatformConfig;
  private accessToken: string | null = null;
  private readonly apiBaseUrl: string;

  constructor(matterbridge: Matterbridge, log: any, config: PlatformConfig) {
    super(matterbridge, log, config);

    this.log = log; // Use the logger instance provided by Matterbridge
    this.config = config;
    this.version = String(config.version || '0.0.0'); 

    this.ttlockConfig = config as TTLockPlatformConfig;
    this.apiBaseUrl = (this.ttlockConfig.ttlock_api_base_url?.trim() !== "" ? this.ttlockConfig.ttlock_api_base_url : DEFAULT_TTLOCK_API_BASE_URL) || DEFAULT_TTLOCK_API_BASE_URL;

    this.log.info("TTLockPlatform constructor called.");
    this.log.debug("Received configuration by plugin (raw):", JSON.stringify(config, null, 2));

    if (!this.ttlockConfig.ttlock_client_id || !this.ttlockConfig.ttlock_client_secret) {
      this.log.error("Missing TTLock clientId or clientSecret in configuration.");
      throw new Error("Missing TTLock clientId or clientSecret");
    }
    if (!this.ttlockConfig.ttlock_username || !this.ttlockConfig.ttlock_password) {
      if (!this.ttlockConfig.ttlock_access_token) {
        this.log.warn("Missing TTLock username/password AND access token. One authentication method is required.");
      }
    }
    this.log.info("TTLock Platform Initialized. API Base URL:", this.apiBaseUrl);
  }

  private async authenticate(): Promise<boolean> {
    if (this.ttlockConfig.ttlock_access_token) {
      this.log.info("Using provided TTLock access token.");
      this.accessToken = this.ttlockConfig.ttlock_access_token;
      return true;
    }

    if (!this.ttlockConfig.ttlock_username || !this.ttlockConfig.ttlock_password) {
      this.log.error("Cannot authenticate: Username or password not provided and no pre-existing access token.");
      return false;
    }

    this.log.info("Attempting to authenticate with TTLock API using username/password...");
    const hashedPassword = crypto.createHash('md5').update(this.ttlockConfig.ttlock_password!).digest('hex').toLowerCase();

    try {
      const tokenEndpoint = `${this.apiBaseUrl}/oauth2/token`;
      const response = await axios.post<TTLockTokenResponse>(
        tokenEndpoint,
        new URLSearchParams({
          clientId: this.ttlockConfig.ttlock_client_id,
          clientSecret: this.ttlockConfig.ttlock_client_secret,
          username: this.ttlockConfig.ttlock_username,
          password: hashedPassword,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.log.info("Successfully authenticated with TTLock API.");
        return true;
      } else {
        this.log.error("Failed to authenticate with TTLock API:", response.data.errmsg || "No access token in response");
        return false;
      }
    } catch (error: any) {
      this.log.error("Error authenticating with TTLock API:", error.message);
      if (error.response) {
        this.log.error("API Response Status:", error.response.status, "Data:", error.response.data);
      }
      return false;
    }
  }

  private async discoverDevices(): Promise<void> {
    if (!this.accessToken) {
      this.log.error("Cannot discover devices: Not authenticated.");
      return;
    }

    this.log.info("Discovering TTLock devices...");
    try {
      const listEndpoint = `${this.apiBaseUrl}/v3/lock/list`;
      const response = await axios.get<TTLockDeviceListResponse>(listEndpoint, {
        params: {
          clientId: this.ttlockConfig.ttlock_client_id,
          accessToken: this.accessToken,
          pageNo: 1,
          pageSize: 20,
          date: Date.now(),
        },
      });

      if (response.data && response.data.list) {
        this.log.info(`Discovered ${response.data.list.length} TTLock devices.`);
        for (const deviceData of response.data.list) {
          this.log.info(`Found lock: ${deviceData.lockAlias} (ID: ${deviceData.lockId})`);
          const uniqueId = `ttlock-${deviceData.lockId}`;

          const endpoint = new MatterbridgeEndpoint([doorLockDevice, bridgedNode], { uniqueStorageKey: uniqueId }, this.config.debug as boolean)
            .createDefaultIdentifyClusterServer()
            .createDefaultGroupsClusterServer()
            .createDefaultBridgedDeviceBasicInformationClusterServer(
              deviceData.lockAlias || `TTLock ${deviceData.lockId}`,
              uniqueId, 0xfff1, 'TTLock Inc.', `TTLock Model ${deviceData.lockMac}`, 1, this.version)
            .createDefaultDoorLockClusterServer(DoorLock.LockState.Locked, DoorLock.LockType.DeadBolt);

          endpoint.addCommandHandler('lockDoor', async ({ attributes: { lockState } }: any) => {
            this.log.info(`Received lockDoor command for ${deviceData.lockAlias}.`);
            if (!this.accessToken) { this.log.error("Cannot lock door: Not authenticated."); return; }
            try {
              const apiResponse = await axios.post<TTLockCommandResponse>(
                `${this.apiBaseUrl}/v3/lock/lock`,
                new URLSearchParams({ clientId: this.ttlockConfig.ttlock_client_id, accessToken: this.accessToken, lockId: deviceData.lockId.toString(), date: Date.now().toString() }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
              );
              if (apiResponse.data && apiResponse.data.errcode === 0) {
                this.log.info(`Successfully locked ${deviceData.lockAlias} via API.`);
                await endpoint.setAttribute(DoorLock.Cluster.id, 'lockState', DoorLock.LockState.Locked);
              } else {
                this.log.error(`Failed to lock ${deviceData.lockAlias} via API:`, apiResponse.data.errmsg || 'Unknown error');
              }
            } catch (error: any) {
              this.log.error(`Error sending lock command for ${deviceData.lockAlias}:`, error.message);
              if (error.response) this.log.error("API Response Status:", error.response.status, "Data:", error.response.data);
            }
          });

          endpoint.addCommandHandler('unlockDoor', async ({ attributes: { lockState } }: any) => {
            this.log.info(`Received unlockDoor command for ${deviceData.lockAlias}.`);
            if (!this.accessToken) { this.log.error("Cannot unlock door: Not authenticated."); return; }
            try {
              const apiResponse = await axios.post<TTLockCommandResponse>(
                `${this.apiBaseUrl}/v3/lock/unlock`,
                new URLSearchParams({ clientId: this.ttlockConfig.ttlock_client_id, accessToken: this.accessToken, lockId: deviceData.lockId.toString(), date: Date.now().toString() }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
              );
              if (apiResponse.data && apiResponse.data.errcode === 0) {
                this.log.info(`Successfully unlocked ${deviceData.lockAlias} via API.`);
                await endpoint.setAttribute(DoorLock.Cluster.id, 'lockState', DoorLock.LockState.Unlocked);
              } else {
                this.log.error(`Failed to unlock ${deviceData.lockAlias} via API:`, apiResponse.data.errmsg || 'Unknown error');
              }
            } catch (error: any) {
              this.log.error(`Error sending unlock command for ${deviceData.lockAlias}:`, error.message);
              if (error.response) this.log.error("API Response Status:", error.response.status, "Data:", error.response.data);
            }
          });

          if (this.validateDevice(endpoint.deviceName ?? '')) {
            await this.registerDevice(endpoint);
            this.log.info(`Registered Matterbridge endpoint for ${deviceData.lockAlias}`);
          } else {
            this.log.warn(`Device ${deviceData.lockAlias} is in blacklist/not in whitelist, skipping registration.`);
          }
        } // Closes the "for (const deviceData of response.data.list)"
      } else {
        this.log.warn("No devices found or error in API response:", response.data.errmsg || 'Empty list');
      }
    } catch (error: any) {
      this.log.error("Error discovering TTLock devices:", error.message);
      if (error.response) this.log.error("API Response Status:", error.response.status, "Data:", error.response.data);
    }
  } // Closes "private async discoverDevices()"

  public async registerDevice(device: MatterbridgeEndpoint): Promise<void> {
    return super.registerDevice(device);
  }

  public validateDevice(device: string | string[], logValidation?: boolean): boolean {
    return super.validateDevice(device, logValidation ?? true);
  }

  async onStart(reason?: string): Promise<void> {
    this.log.info("TTLock Platform starting process initiated:", reason || "no reason given");
    const authenticated = await this.authenticate();
    if (authenticated) {
      await this.discoverDevices();
    } else {
      this.log.error("TTLock Platform could not authenticate. Device discovery will not proceed.");
    }
    this.log.info("TTLock Platform onStart finished.");
  }

  async onShutdown(reason?: string): Promise<void> {
    this.log.info("TTLock Platform shutting down:", reason || "no reason given");
    this.accessToken = null;
    await super.onShutdown(reason); 
  }
}

export default function DefaultPlatform(matterbridge: Matterbridge, log: any, config: PlatformConfig): MatterbridgeDynamicPlatform {
  return new TTLockPlatform(matterbridge, log, config);
}

