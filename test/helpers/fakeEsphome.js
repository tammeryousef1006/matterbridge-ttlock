/**
 * A fake ESPHome Bluetooth proxy speaking the real native API (plaintext),
 * with a simulated TTLock lock behind it. Uses the same protobuf definitions
 * as the client library, so it exercises the plugin's real ESPHome code path.
 */
import net from 'node:net';
import { createRequire } from 'node:module';

import { aesDecrypt, aesEncrypt } from '../../dist/ble/crypto.js';
import { Frame, FrameReassembler } from '../../dist/ble/frame.js';

const require = createRequire(import.meta.url);
const { pb, id_to_type } = require('@2colors/esphome-native-api/lib/utils/messages.js');
const { varuint_to_bytes } = require('@2colors/esphome-native-api/lib/utils/index.js');
const { BinaryWriter } = createRequire(require.resolve('@2colors/esphome-native-api'))('google-protobuf');

const GATT_TABLE = [
  {
    uuid: '00001910-0000-1000-8000-00805f9b34fb',
    short: 0x1910,
    handle: 1,
    characteristics: [
      { uuid: '0000fff2-0000-1000-8000-00805f9b34fb', short: 0xfff2, handle: 0x10, properties: 0x04, descriptors: [] },
      { uuid: '0000fff4-0000-1000-8000-00805f9b34fb', short: 0xfff4, handle: 0x12, properties: 0x10, descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', short: 0x2902, handle: 0x13 }] },
    ],
  },
  { uuid: '0000180f-0000-1000-8000-00805f9b34fb', short: 0x180f, handle: 30, characteristics: [{ uuid: '00002a19-0000-1000-8000-00805f9b34fb', short: 0x2a19, handle: 0x20, properties: 0x02, descriptors: [] }] },
  // A vendor service with a 128-bit UUID, as real locks expose
  { uuid: '73631912-6965-6e65-7269-736669727374', short: 0, handle: 40, characteristics: [{ uuid: '73632b12-6965-6e65-7269-736669727374', short: 0, handle: 0x29, properties: 0x08, descriptors: [] }] },
];

/** Encode GetServicesResponse the way ESPHome's C++ does: each uuid half as its own (unpacked) field. */
function encodeServicesUnpacked(address, useShortUuids) {
  const w = new BinaryWriter();
  w.writeUint64String(1, BigInt(address).toString());
  const writeUuid = (writer, item, shortField) => {
    if (useShortUuids && item.short) return writer.writeUint32(shortField, item.short);
    const hex = item.uuid.replace(/-/g, '');
    writer.writeUint64String(1, BigInt('0x' + hex.slice(0, 16)).toString());
    writer.writeUint64String(1, BigInt('0x' + hex.slice(16)).toString());
  };
  for (const svc of GATT_TABLE) {
    w.writeMessage(2, svc, (s, sw) => {
      writeUuid(sw, s, 4);
      sw.writeUint32(2, s.handle);
      for (const ch of s.characteristics) {
        sw.writeMessage(3, ch, (c, cw) => {
          writeUuid(cw, c, 5);
          cw.writeUint32(2, c.handle);
          cw.writeUint32(3, c.properties);
          for (const d of c.descriptors) {
            cw.writeMessage(4, d, (dd, dw) => {
              writeUuid(dw, dd, 3);
              dw.writeUint32(2, dd.handle);
            });
          }
        });
      }
    });
  }
  return w.getResultBuffer();
}

const H = { service: 1, write: 0x10, notify: 0x12, cccd: 0x13, battery: 0x20 };

/** 128-bit UUID as ESPHome sends it: two uint64 halves (decoded lossily by the client). */
function uuidHalves(uuid) {
  const hex = uuid.replace(/-/g, '');
  return [Number(BigInt('0x' + hex.slice(0, 16))), Number(BigInt('0x' + hex.slice(16)))];
}

export class LockBrain {
  constructor({ aesKey, unlockKey, ps = 0xfffffff0 }) {
    this.aesKey = aesKey;
    this.unlockKey = unlockKey;
    this.ps = ps;
    this.reassembler = new FrameReassembler();
    this.locked = true;
    this.log = [];
    /** Pages answered to GET_OPERATE_LOG (decrypted payloads); empty -> "no records". */
    this.historyPages = [];
  }

  /** Feed written bytes; returns reply frames (wire bytes). */
  feed(chunk) {
    const replies = [];
    for (const frame of this.reassembler.feed(chunk)) {
      let plain;
      try {
        plain = aesDecrypt(frame.data, this.aesKey);
      } catch {
        continue;
      }
      const reply = (bytes) => replies.push(new Frame(frame.protocolType, frame.subVersion, frame.scene, frame.groupId, frame.orgId, 0x54, 0x02, aesEncrypt(Buffer.from(bytes), this.aesKey)).build());
      const cmd = frame.command;
      if (cmd === 0x55) reply([0x55, 0x01, ...Buffer.from(this.ps.toString(16).padStart(8, '0'), 'hex')]);
      else if (cmd === 0x47 || cmd === 0x58) {
        const expected = Number((BigInt(this.ps) + BigInt(this.unlockKey)) & 0xffffffffn);
        if (plain.readUInt32BE(0) !== expected) reply([cmd, 0x00, 0x05]);
        else {
          this.locked = cmd === 0x58;
          this.log.push(cmd === 0x58 ? 'lock' : 'unlock');
          reply([cmd, 0x01]);
        }
      } else if (cmd === 0x14) reply([0x14, 0x01, 80, this.locked ? 0 : 1]);
      else if (cmd === 0x25) reply(this.historyPages.shift() ?? [0x25, 0x01, 0x00, 0x00]);
    }
    return replies;
  }
}

export class FakeEsphome {
  /** uuidMode: 'unpacked' (like ESPHome), 'packed', or 'short' (16-bit short_uuid for v1.12 clients). */
  constructor({ lockMac, brain, uuidMode = 'unpacked' }) {
    this.lockMac = lockMac;
    this.address = parseInt(lockMac.replace(/:/g, ''), 16);
    this.brain = brain;
    this.uuidMode = uuidMode;
    this.sockets = new Set();
    this.subscribed = false;
    this.deviceConnected = false;
    this.writes = [];
    this.cccdWrites = 0;
    this.connectRequests = 0;
    this.writeResponseRequested = false;
  }

  start() {
    this.server = net.createServer((socket) => this.onSocket(socket));
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  send(message) {
    this.sendRaw(Number(message.constructor.id), message.serializeBinary());
  }

  sendRaw(id, encoded) {
    const frame = Buffer.from([0, ...varuint_to_bytes(encoded.length), ...varuint_to_bytes(id), ...encoded]);
    for (const s of this.sockets) s.write(frame);
  }

  /** Broadcast a raw advertisement with the given manufacturer data (company id bytes included). */
  advertise(manufacturerData) {
    const ad = Buffer.concat([Buffer.from([0x02, 0x01, 0x06]), Buffer.from([manufacturerData.length + 1, 0xff]), manufacturerData]);
    const adv = new pb.BluetoothLERawAdvertisement();
    adv.setAddress(this.address);
    adv.setRssi(-61);
    adv.setAddressType(0);
    adv.setData(new Uint8Array(ad));
    const msg = new pb.BluetoothLERawAdvertisementsResponse();
    msg.addAdvertisements(adv);
    this.send(msg);
  }

  onSocket(socket) {
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (buffer.length < 3 || buffer[0] !== 0) return;
        let offset = 1;
        const readVar = () => {
          let result = 0;
          let shift = 0;
          for (;;) {
            if (offset >= buffer.length) return null;
            const b = buffer[offset++];
            result |= (b & 0x7f) << shift;
            shift += 7;
            if (!(b & 0x80)) return result;
          }
        };
        const len = readVar();
        const id = readVar();
        if (len === null || id === null || offset + len > buffer.length) return;
        const body = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        const type = id_to_type[id];
        this.handle(type, pb[type].deserializeBinary(new Uint8Array(body)));
      }
    });
  }

  handle(type, msg) {
    switch (type) {
      case 'HelloRequest': {
        const r = new pb.HelloResponse();
        r.setApiVersionMajor(1);
        r.setApiVersionMinor(12);
        r.setServerInfo('fake-esphome');
        r.setName('fake-proxy');
        return this.send(r);
      }
      case 'PingRequest':
        return this.send(new pb.PingResponse());
      case 'DisconnectRequest':
        return this.send(new pb.DisconnectResponse());
      case 'SubscribeBluetoothLEAdvertisementsRequest':
        this.subscribed = true;
        return;
      case 'BluetoothDeviceRequest': {
        const r = new pb.BluetoothDeviceConnectionResponse();
        r.setAddress(msg.getAddress());
        const disconnect = msg.getRequestType() === pb.BluetoothDeviceRequestType.BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT;
        if (!disconnect) this.connectRequests++;
        this.deviceConnected = !disconnect && msg.getAddress() === this.address;
        r.setConnected(this.deviceConnected);
        r.setMtu(23);
        r.setError(!disconnect && !this.deviceConnected ? 133 : 0);
        return this.send(r);
      }
      case 'BluetoothGATTGetServicesRequest': {
        if (this.uuidMode === 'packed') {
          const r = new pb.BluetoothGATTGetServicesResponse();
          r.setAddress(msg.getAddress());
          for (const svcDef of GATT_TABLE) {
            const svc = new pb.BluetoothGATTService();
            svc.setUuidList(uuidHalves(svcDef.uuid));
            svc.setHandle(svcDef.handle);
            for (const chDef of svcDef.characteristics) {
              const ch = new pb.BluetoothGATTCharacteristic();
              ch.setUuidList(uuidHalves(chDef.uuid));
              ch.setHandle(chDef.handle);
              ch.setProperties(chDef.properties);
              for (const dDef of chDef.descriptors) {
                const d = new pb.BluetoothGATTDescriptor();
                d.setUuidList(uuidHalves(dDef.uuid));
                d.setHandle(dDef.handle);
                ch.addDescriptors(d);
              }
              svc.addCharacteristics(ch);
            }
            r.addServices(svc);
          }
          this.send(r);
        } else {
          this.sendRaw(71, encodeServicesUnpacked(msg.getAddress(), this.uuidMode === 'short'));
        }
        const done = new pb.BluetoothGATTGetServicesDoneResponse();
        done.setAddress(msg.getAddress());
        return this.send(done);
      }
      case 'BluetoothGATTNotifyRequest': {
        const r = new pb.BluetoothGATTNotifyResponse();
        r.setAddress(msg.getAddress());
        r.setHandle(msg.getHandle());
        return this.send(r);
      }
      case 'BluetoothGATTWriteDescriptorRequest': {
        if (msg.getHandle() === H.cccd) this.cccdWrites++;
        const r = new pb.BluetoothGATTWriteResponse();
        r.setAddress(msg.getAddress());
        r.setHandle(msg.getHandle());
        return this.send(r);
      }
      case 'BluetoothGATTReadRequest': {
        const r = new pb.BluetoothGATTReadResponse();
        r.setAddress(msg.getAddress());
        r.setHandle(msg.getHandle());
        r.setData(new Uint8Array([100]));
        return this.send(r);
      }
      case 'BluetoothGATTWriteRequest': {
        if (msg.getResponse()) this.writeResponseRequested = true;
        const data = Buffer.from(msg.getData_asU8());
        this.writes.push(data);
        for (const reply of this.brain.feed(data)) {
          setImmediate(() => {
            for (let i = 0; i < reply.length; i += 20) {
              const n = new pb.BluetoothGATTNotifyDataResponse();
              n.setAddress(this.address);
              n.setHandle(H.notify);
              n.setData(new Uint8Array(reply.subarray(i, i + 20)));
              this.send(n);
            }
          });
        }
        return;
      }
      default:
        return;
    }
  }
}
