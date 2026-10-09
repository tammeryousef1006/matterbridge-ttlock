import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { aesDecrypt, aesEncrypt } from '../dist/ble/crypto.js';
import { Frame, FrameReassembler } from '../dist/ble/frame.js';
import { LockSession } from '../dist/ble/lockSession.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const MAC = 'AA:BB:CC:DD:EE:FF';
const AES = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const VERSION = { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 1, orgId: 7 };
const UNLOCK_KEY = '305419896';
const HANDLES = { write: 0x10, notify: 0x12, cccd: 0x13, battery: 0x20 };

/** A fake BLE central with a simulated TTLock lock behind it. */
class SimulatedLock {
  constructor({ connectFailures = 0, pushBeforeReply = false, silent = false } = {}) {
    this.events = new EventEmitter();
    this.connectFailures = connectFailures;
    this.pushBeforeReply = pushBeforeReply;
    this.silent = silent;
    this.reassembler = new FrameReassembler();
    this.ps = 0xfffffff0;
    this.locked = true;
    this.log = [];
    this.connected = false;
    this.notifying = false;
    this.historyPages = [];
  }

  async connectDevice(mac) {
    assert.equal(mac, MAC);
    if (this.connectFailures-- > 0) throw new Error('timeout');
    this.connected = true;
  }
  async disconnectDevice() {
    this.connected = false;
  }
  async getServices() {
    return [
      {
        uuid: '00001910-0000-1000-8000-00805f9b34fb',
        handle: 1,
        characteristics: [
          { uuid: '0000fff2-0000-1000-8000-00805f9b34fb', handle: HANDLES.write, properties: 4, descriptors: [] },
          { uuid: '0000fff4-0000-1000-8000-00805f9b34fb', handle: HANDLES.notify, properties: 16, descriptors: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: HANDLES.cccd }] },
        ],
      },
      { uuid: '0000180f-0000-1000-8000-00805f9b34fb', handle: 30, characteristics: [{ uuid: '00002a19-0000-1000-8000-00805f9b34fb', handle: HANDLES.battery, properties: 2, descriptors: [] }] },
    ];
  }
  async startNotify(_mac, characteristic) {
    assert.equal(characteristic.handle, HANDLES.notify);
    this.notifying = true;
  }
  async read() {
    return Buffer.from([100]);
  }
  onNotify(_mac, listener) {
    this.events.on('notify', listener);
    return () => this.events.off('notify', listener);
  }
  onDisconnect(_mac, listener) {
    this.events.on('disconnect', listener);
    return () => this.events.off('disconnect', listener);
  }
  async exclusive(fn) {
    return fn();
  }
  async write(_mac, handle, data) {
    assert.equal(handle, HANDLES.write);
    assert.ok(data.length <= 20, 'writes are chunked to 20 bytes');
    assert.ok(this.connected && this.notifying);
    for (const frame of this.reassembler.feed(data)) this.handle(frame);
  }

  reply(plain) {
    const wire = new Frame(5, 3, 2, 1, 7, 0x54, 0x02, aesEncrypt(plain, AES)).build();
    setImmediate(() => {
      for (let i = 0; i < wire.length; i += 20) this.events.emit('notify', HANDLES.notify, wire.subarray(i, i + 20));
    });
  }

  handle(frame) {
    assert.equal(frame.protocolType, 5);
    assert.equal(frame.groupId, 1);
    assert.equal(frame.orgId, 7);
    let plain;
    try {
      plain = aesDecrypt(frame.data, AES);
    } catch {
      return; // wrong key: a real lock stays silent
    }
    if (this.silent) return;
    if (this.pushBeforeReply) this.reply(Buffer.from([0x14, 0x01, 90, 1, 0]));
    const cmd = frame.command;
    if (cmd === 0x55) return this.reply(Buffer.concat([Buffer.from([0x55, 0x01]), Buffer.from('fffffff0', 'hex')]));
    if (cmd === 0x47 || cmd === 0x58) {
      const expected = Number((BigInt(this.ps) + BigInt(UNLOCK_KEY)) & 0xffffffffn);
      if (plain.readUInt32BE(0) !== expected) return this.reply(Buffer.from([cmd, 0x00, 0x05]));
      this.locked = cmd === 0x58;
      this.log.push(cmd === 0x58 ? 'lock' : 'unlock');
      return this.reply(Buffer.from([cmd, 0x01]));
    }
    if (cmd === 0x14) return this.reply(Buffer.from([0x14, 0x01, 77, this.locked ? 0 : 1]));
    if (cmd === 0x25) return this.reply(this.historyPages.shift() ?? Buffer.from([0x25, 0x01, 0x00, 0x00]));
  }
}

const key = (overrides = {}) => ({ lockMac: MAC, aesKey: AES, unlockKey: UNLOCK_KEY, lockVersion: VERSION, uid: 0, source: 'test', ...overrides });

async function withSession(lock, k, fn) {
  const session = new LockSession(lock, k, silentLog, 'test lock');
  await session.open(Date.now() + 10000);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

test('unlocks and locks over Bluetooth', async () => {
  const lock = new SimulatedLock();
  await withSession(lock, key(), async (s) => {
    await s.unlock();
    assert.deepEqual(await s.queryState(), { battery: 77, locked: false });
    await s.lock();
    assert.deepEqual(await s.queryState(), { battery: 77, locked: true });
  });
  assert.deepEqual(lock.log, ['unlock', 'lock']);
  assert.equal(lock.connected, false, 'disconnects afterwards');
});

test('retries the connection when the lock is asleep', async () => {
  const lock = new SimulatedLock({ connectFailures: 2 });
  await withSession(lock, key(), (s) => s.unlock());
  assert.deepEqual(lock.log, ['unlock']);
});

test('ignores push frames that arrive while waiting for a reply', async () => {
  const lock = new SimulatedLock({ pushBeforeReply: true });
  await withSession(lock, key(), (s) => s.unlock());
  assert.deepEqual(lock.log, ['unlock']);
});

test('reports a wrong unlock key as a refusal', async () => {
  const lock = new SimulatedLock();
  await assert.rejects(
    withSession(lock, key({ unlockKey: '1' }), (s) => s.unlock()),
    /refused to unlock/,
  );
  assert.deepEqual(lock.log, []);
});

test('times out when the lock does not answer (e.g. wrong AES key)', async () => {
  const lock = new SimulatedLock();
  const started = Date.now();
  await assert.rejects(
    withSession(lock, key({ aesKey: Buffer.alloc(16, 9) }), (s) => s.unlock()),
    /did not answer/,
  );
  assert.ok(Date.now() - started < 9000);
});

test('fails when the lock cannot be reached', async () => {
  const lock = new SimulatedLock({ connectFailures: 10 });
  const session = new LockSession(lock, key(), silentLog, 'test lock');
  await assert.rejects(session.open(Date.now() + 5000), /could not connect/);
});

test('reads new history records page by page', async () => {
  const lock = new SimulatedLock();
  const fingerprint = Buffer.concat([Buffer.from([20, 26, 10, 9, 14, 30, 5, 88]), Buffer.from('000000000003', 'hex')]);
  const passcode = Buffer.concat([Buffer.from([4, 26, 10, 9, 14, 31, 0, 87, 4]), Buffer.from('1234')]);
  const page = (seq, rec) => Buffer.concat([Buffer.from([0x25, 0x01, 0x00, rec.length + 3, seq >> 8, seq & 0xff, rec.length]), rec]);
  lock.historyPages = [page(11, fingerprint), page(12, passcode)];
  const records = await withSession(lock, key(), (s) => s.readNewRecords());
  assert.equal(records.length, 2);
  assert.equal(records[0].recordType, 20);
  assert.equal(records[0].credential, '3');
  assert.equal(records[1].recordType, 4);
  assert.equal(records[1].credential, '1234');
});
