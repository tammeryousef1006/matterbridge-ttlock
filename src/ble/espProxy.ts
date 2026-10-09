/**
 * Talks to an ESPHome Bluetooth proxy (ESP32) over the ESPHome native API:
 * receives BLE advertisements and runs GATT connections on our behalf.
 *
 * Note: an ESPHome Bluetooth proxy serves one API client at a time for
 * Bluetooth, so the ESP32 must not also be used by Home Assistant.
 */
import { EventEmitter } from 'events';
import { createRequire } from 'module';

import { TTLockLogger } from '../ttlockApi.js';
import { normalizeMac } from './keys.js';

const BT_BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export interface EspProxyOptions {
  host: string;
  port?: number;
  encryptionKey?: string;
  password?: string;
}

export interface ManufacturerAdvertisement {
  mac: string;
  addressType?: number;
  rssi?: number;
  /** Manufacturer data including the two company-id bytes (little-endian). */
  data: Buffer;
}

export interface GattCharacteristic {
  uuid: string;
  handle: number;
  properties: number;
  descriptors: Array<{ uuid: string; handle: number }>;
}

export interface GattService {
  uuid: string;
  handle: number;
  characteristics: GattCharacteristic[];
}

/** The subset of the proxy a lock session needs; lets tests substitute a fake. */
export interface BleCentral {
  /** `useCache`: let the proxy reuse its cached GATT services (skips discovery) when it supports that. */
  connectDevice(mac: string, timeoutMs: number, useCache?: boolean): Promise<void>;
  disconnectDevice(mac: string): Promise<void>;
  getServices(mac: string): Promise<GattService[]>;
  startNotify(mac: string, characteristic: GattCharacteristic): Promise<void>;
  write(mac: string, handle: number, data: Buffer): Promise<void>;
  read(mac: string, handle: number): Promise<Buffer | undefined>;
  onNotify(mac: string, listener: (handle: number, data: Buffer) => void): () => void;
  onDisconnect(mac: string, listener: () => void): () => void;
  /** Serialise whole sessions: the proxy has few connection slots and a lock accepts one central. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/** Full 128-bit lowercase UUID from an ESPHome uuid list or short uuid. */
export function fullUuid(uuid: unknown, shortUuid: unknown): string {
  if (typeof uuid === 'string' && uuid.length > 0) return uuid.toLowerCase();
  const short = Number(shortUuid);
  if (Number.isFinite(short) && short > 0) return short.toString(16).padStart(8, '0') + BT_BASE_UUID_SUFFIX;
  return '';
}

export function macToNumber(mac: string): number {
  return parseInt(mac.replace(/[^0-9a-fA-F]/g, ''), 16);
}

export function numberToMac(value: number | string): string {
  const hex = BigInt(value).toString(16).padStart(12, '0');
  return normalizeMac(hex);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value as number[]);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return Buffer.alloc(0);
}

type AnyMessage = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The ESPHome library's generated protobuf code calls `readPacked*` reader
 * methods that google-protobuf 4 no longer has (it fails to parse, for
 * example, GATT services with 128-bit UUIDs and then drops the connection).
 * Add them back on top of the `readPackable*Into` methods that replaced them.
 */
export function patchProtobufReader(requireFromLibrary: NodeJS.Require): void {
  const reader = requireFromLibrary('google-protobuf').BinaryReader?.prototype;
  if (!reader) return;
  const aliases: Record<string, string> = {
    readPackedUint64: 'readPackableUint64Into',
    readPackedUint32: 'readPackableUint32Into',
    readPackedSint32: 'readPackableSint32Into',
    readPackedBool: 'readPackableBoolInto',
    readPackedEnum: 'readPackableEnumInto',
    readPackedFloat: 'readPackableFloatInto',
  };
  for (const [missing, replacement] of Object.entries(aliases)) {
    if (typeof reader[missing] === 'function' || typeof reader[replacement] !== 'function') continue;
    reader[missing] = function (this: AnyMessage) {
      const values: unknown[] = [];
      this[replacement](values);
      return values;
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s ${what}`)), ms);
    }),
  ]);
}

export class EspProxy extends EventEmitter implements BleCentral {
  private connection: AnyMessage | undefined;
  private pb: AnyMessage | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readyFlag = false;
  private stopped = false;
  private advertisementCount = 0;
  private lastError: string | undefined;
  private everConnected = false;
  private remoteCaching = false;

  constructor(
    private readonly options: EspProxyOptions,
    private readonly log: TTLockLogger,
  ) {
    super();
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  get receivedAdvertisements(): number {
    return this.advertisementCount;
  }

  start(): void {
    const require = createRequire(import.meta.url);
    const libraryPath = require.resolve('@2colors/esphome-native-api');
    patchProtobufReader(createRequire(libraryPath));
    const { Connection } = require('@2colors/esphome-native-api');
    this.pb = require('@2colors/esphome-native-api/lib/utils/messages.js').pb;
    const connection = new Connection({
      host: this.options.host,
      port: this.options.port ?? 6053,
      encryptionKey: this.options.encryptionKey || '',
      password: this.options.password || '',
      clientInfo: 'matterbridge-ttlock',
      reconnect: true,
      reconnectInterval: 15000,
    });
    this.connection = connection;

    connection.on('authorized', () => {
      try {
        connection.subscribeBluetoothAdvertisementService();
        this.readyFlag = true;
        this.everConnected = true;
        this.log.info(`Connected to the ESP32 Bluetooth proxy at ${this.options.host}.`);
        connection
          .deviceInfoService()
          .then((info: AnyMessage) => {
            const flags = Number(info?.bluetoothProxyFeatureFlags ?? 0);
            // BluetoothProxyFeature.REMOTE_CACHING = 4
            this.remoteCaching = (flags & 4) !== 0;
            this.log.debug(`ESP32 proxy ${info?.name ?? ''} (ESPHome ${info?.esphomeVersion ?? '?'}), Bluetooth proxy features ${flags}${this.remoteCaching ? ' (service caching)' : ''}.`);
          })
          .catch(() => undefined);
        this.emit('ready');
      } catch (error) {
        this.log.warn(`ESP32 proxy: could not subscribe to Bluetooth advertisements: ${(error as Error).message}`);
      }
    });
    connection.on('unauthorized', () => this.setDown());
    connection.on('disconnected', () => this.setDown());
    connection.on('error', (error: Error) => {
      if (this.stopped) return;
      this.lastError = String(error?.message ?? error);
      this.log.debug(`ESP32 proxy error: ${this.lastError}`);
      if (/encryption|handshake|invalid password|noise/i.test(String(error?.message))) {
        this.log.warn(`ESP32 proxy at ${this.options.host} refused the connection: ${error.message}. Check the API encryption key.`);
      }
    });
    connection.on('message.BluetoothLEAdvertisementResponse', (adv: AnyMessage) => this.handleAdvertisement(adv));
    connection.on('message.BluetoothGATTNotifyDataResponse', (msg: AnyMessage) => {
      this.emit(`notify:${numberToMac(msg.address)}`, Number(msg.handle), toBuffer(msg.data));
    });
    connection.on('message.BluetoothDeviceConnectionResponse', (msg: AnyMessage) => {
      if (!msg.connected) this.emit(`disconnect:${numberToMac(msg.address)}`);
    });
    connection.on('message.BluetoothGATTErrorResponse', (msg: AnyMessage) => {
      this.emit(`gatt-error:${numberToMac(msg.address)}`, Number(msg.handle), Number(msg.error));
    });

    connection.connect();
    setTimeout(() => {
      if (!this.stopped && !this.everConnected) {
        this.log.warn(
          `Could not connect to the ESP32 Bluetooth proxy at ${this.options.host}:${this.options.port ?? 6053} yet${this.lastError ? ` (${this.lastError})` : ''}. Check the address, that the ESP32 is on, and the encryption key. Retrying in the background.`,
        );
      }
    }, 30_000).unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.readyFlag = false;
    const connection = this.connection;
    this.connection = undefined;
    this.removeAllListeners();
    if (!connection) return;
    // Close the socket ourselves: the library's disconnect() removes the socket's
    // error handler before writing, so a write to a dead socket would crash the process.
    connection.reconnect = false;
    clearTimeout(connection.reconnectTimer);
    clearInterval(connection.pingTimer);
    connection.removeAllListeners();
    const helper = connection.frameHelper;
    const socket = helper?.socket;
    helper?.removeAllListeners();
    socket?.on('error', () => undefined);
    try {
      if (connection.connected && socket?.writable) connection.sendMessage(new this.pb!.DisconnectRequest());
    } catch {
      // already closed
    }
    socket?.end();
    setTimeout(() => socket?.destroy(), 1000).unref?.();
  }

  private setDown(): void {
    if (!this.readyFlag) return;
    this.readyFlag = false;
    if (!this.stopped) this.log.info(`Lost the connection to the ESP32 Bluetooth proxy at ${this.options.host}; reconnecting...`);
    this.emit('down');
  }

  private handleAdvertisement(adv: AnyMessage): void {
    this.advertisementCount++;
    const list = (adv.manufacturerDataList ?? []) as AnyMessage[];
    if (!list.length || adv.address === undefined) return;
    const mac = numberToMac(adv.address);
    for (const md of list) {
      const uuid = String(md.uuid ?? '');
      const companyId = parseInt(uuid.startsWith('0x') ? uuid.slice(2) : uuid.slice(4, 8), 16);
      if (!Number.isFinite(companyId)) continue;
      const payload = md.legacyDataList?.length ? Buffer.from(md.legacyDataList) : toBuffer(md.data);
      const data = Buffer.concat([Buffer.from([companyId & 0xff, (companyId >> 8) & 0xff]), payload]);
      this.emit('advertisement', { mac, addressType: adv.addressType, rssi: adv.rssi, data } satisfies ManufacturerAdvertisement);
    }
  }

  private requireConnection(): AnyMessage {
    if (!this.connection || !this.readyFlag) throw new Error('the ESP32 Bluetooth proxy is not connected');
    return this.connection;
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private addressTypes = new Map<string, number>();

  rememberAddressType(mac: string, addressType: number | undefined): void {
    if (addressType !== undefined) this.addressTypes.set(normalizeMac(mac), addressType);
  }

  async connectDevice(mac: string, timeoutMs: number, _useCache = false): Promise<void> {
    const connection = this.requireConnection();
    const response: AnyMessage = await withTimeout(
      // Cached connections (CONNECT_V3_WITH_CACHE) left TTLock sessions hanging on real
      // hardware in 1.4.0-beta.2, so always connect with a fresh service discovery.
      connection.connectBluetoothDeviceService(macToNumber(mac), this.addressTypes.get(normalizeMac(mac)), false),
      timeoutMs,
      'connecting to the lock',
    );
    if (!response?.connected || Number(response.error ?? 0) !== 0) {
      throw new Error(`the ESP32 could not connect to the lock (error ${response?.error ?? 'unknown'})`);
    }
  }

  async disconnectDevice(mac: string): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.readyFlag) return;
    try {
      await withTimeout(connection.disconnectBluetoothDeviceService(macToNumber(mac)), 5000, 'disconnecting');
    } catch {
      // best effort
    }
  }

  async getServices(mac: string): Promise<GattService[]> {
    const connection = this.requireConnection();
    const result: AnyMessage = await withTimeout(connection.listBluetoothGATTServicesService(macToNumber(mac)), 10000, 'reading the lock services');
    return ((result.servicesList ?? []) as AnyMessage[]).map((s) => ({
      uuid: fullUuid(s.uuid, s.shortUuid),
      handle: Number(s.handle),
      characteristics: ((s.characteristicsList ?? []) as AnyMessage[]).map((c) => ({
        uuid: fullUuid(c.uuid, c.shortUuid),
        handle: Number(c.handle),
        properties: Number(c.properties ?? 0),
        descriptors: ((c.descriptorsList ?? []) as AnyMessage[]).map((d) => ({ uuid: fullUuid(d.uuid, d.shortUuid), handle: Number(d.handle) })),
      })),
    }));
  }

  async startNotify(mac: string, characteristic: GattCharacteristic): Promise<void> {
    const connection = this.requireConnection();
    await withTimeout(connection.notifyBluetoothGATTCharacteristicService(macToNumber(mac), characteristic.handle), 8000, 'enabling notifications');
    // Enable notifications in the CCCD too (newer proxies do this themselves; harmless twice).
    const cccd = characteristic.descriptors.find((d) => d.uuid.startsWith('00002902'));
    if (cccd) {
      const message = new this.pb!.BluetoothGATTWriteDescriptorRequest([macToNumber(mac), cccd.handle, new Uint8Array([0x01, 0x00])]);
      connection.sendMessage(message);
    }
  }

  async write(mac: string, handle: number, data: Buffer): Promise<void> {
    const connection = this.requireConnection();
    // Write without response, like the vendor app: ESPHome sends no reply for these.
    const message = new this.pb!.BluetoothGATTWriteRequest([macToNumber(mac), handle, false, new Uint8Array(data)]);
    connection.sendMessage(message);
  }

  async read(mac: string, handle: number): Promise<Buffer | undefined> {
    const connection = this.requireConnection();
    try {
      const response: AnyMessage = await withTimeout(connection.readBluetoothGATTCharacteristicService(macToNumber(mac), handle), 4000, 'reading');
      return toBuffer(response.data);
    } catch {
      return undefined;
    }
  }

  onNotify(mac: string, listener: (handle: number, data: Buffer) => void): () => void {
    const event = `notify:${normalizeMac(mac)}`;
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  onDisconnect(mac: string, listener: () => void): () => void {
    const event = `disconnect:${normalizeMac(mac)}`;
    this.on(event, listener);
    return () => this.off(event, listener);
  }
}
