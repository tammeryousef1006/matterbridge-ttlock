import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalController } from '../dist/local.js';
import { FakeEsphome, LockBrain } from './helpers/fakeEsphome.js';

const MAC = 'C1:D2:E3:F4:A5:B6';
const AES_HEX = '00112233445566778899aabbccddeeff';
const UNLOCK_KEY = '123456789';
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// Shaped like a key stored by the Home Assistant "TTLock BLE" integration
const haEntry = JSON.stringify({
  data: {
    username: 'me@example.com',
    keys: [
      {
        keyId: 1,
        lockId: 0,
        lockMac: MAC,
        lockAlias: 'Front Door',
        lockVersion: { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 1, orgId: 7 },
        aesKeyStr: AES_HEX,
        unlockKey: UNLOCK_KEY,
        lockFlagPos: 0,
        adminPs: '',
        uid: 42,
      },
    ],
  },
});

function memoryStore() {
  const data = new Map();
  return { get: async (k, d) => (data.has(k) ? data.get(k) : d), set: async (k, v) => void data.set(k, v), data };
}

async function waitFor(predicate, what, ms = 5000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Manufacturer data of a V3 lock: 05 03 | scene | flags | battery | ... | MAC reversed. */
function advert({ unlocked, battery, newRecords = false }) {
  const flags = (unlocked ? 0x01 : 0) | (newRecords ? 0x02 : 0);
  const mac = Buffer.from(MAC.replace(/:/g, ''), 'hex').reverse();
  return Buffer.concat([Buffer.from([0x05, 0x03, 0x02, flags, battery, 0, 0, 0, 0]), mac]);
}

async function setup({ uuidMode = 'unpacked', keysJson = haEntry } = {}) {
  const brain = new LockBrain({ aesKey: Buffer.from(AES_HEX, 'hex'), unlockKey: UNLOCK_KEY });
  const fake = new FakeEsphome({ lockMac: MAC, brain, uuidMode });
  const port = await fake.start();
  const adverts = [];
  const local = new LocalController(
    { espHost: '127.0.0.1', espPort: port, manualKeysJson: keysJson, useAppAccount: false, readHistory: false },
    memoryStore(),
    silentLog,
    { onAdvertisement: (lockId, adv) => adverts.push({ lockId, adv }), onRecords() {} },
  );
  await local.start([{ lockId: 7, lockAlias: 'Front Door', lockMac: MAC.toLowerCase() }]);
  await waitFor(() => local.connected && fake.subscribed, 'the proxy connection');
  return { brain, fake, local, adverts };
}

test('connects to the ESPHome proxy and reads lock state from advertisements', async () => {
  const { fake, local, adverts } = await setup();
  try {
    assert.equal(local.hasKey(7), true);
    fake.advertise(advert({ unlocked: true, battery: 64 }));
    await waitFor(() => adverts.length === 1, 'an advertisement');
    assert.deepEqual(adverts[0], { lockId: 7, adv: { mac: MAC, locked: false, hasNewRecords: false, dormant: false, battery: 64 } });
    // Same state again is not reported twice; a change is.
    fake.advertise(advert({ unlocked: true, battery: 64 }));
    fake.advertise(advert({ unlocked: false, battery: 64 }));
    await waitFor(() => adverts.length === 2, 'the state change');
    assert.equal(adverts[1].adv.locked, true);
  } finally {
    local.stop();
    await fake.stop();
  }
});

for (const uuidMode of ['unpacked', 'packed', 'short']) {
  test(`unlocks and locks through the proxy (${uuidMode} UUIDs)`, async () => {
    const { brain, fake, local } = await setup({ uuidMode });
    try {
      await local.control(7, 'unlock', 10000);
      await local.control(7, 'lock', 10000);
      assert.deepEqual(brain.log, ['unlock', 'lock']);
      assert.ok(fake.writes.every((w) => w.length <= 20));
      assert.equal(fake.writeResponseRequested, false, 'writes without response, like the vendor app');
      assert.equal(fake.cccdWrites, 2, 'notifications enabled in the CCCD');
      assert.equal(fake.deviceConnected, false, 'disconnects after each command');
    } finally {
      local.stop();
      await fake.stop();
    }
  });
}

test('rejects commands for a lock without a key', async () => {
  const { fake, local } = await setup({ keysJson: '' });
  try {
    assert.equal(local.hasKey(7), false);
    await assert.rejects(local.control(7, 'unlock', 5000), /no Bluetooth key/);
  } finally {
    local.stop();
    await fake.stop();
  }
});

test('a wrong unlock key is reported as a refusal', async () => {
  const wrong = haEntry.replace(`"unlockKey":"${UNLOCK_KEY}"`, '"unlockKey":"1"');
  const { brain, fake, local } = await setup({ keysJson: wrong });
  try {
    await assert.rejects(local.control(7, 'unlock', 10000), /refused to unlock/);
    assert.deepEqual(brain.log, []);
  } finally {
    local.stop();
    await fake.stop();
  }
});

test('survives the ESP32 going away and stopping afterwards', async () => {
  const { fake, local } = await setup();
  await fake.stop();
  await waitFor(() => !local.connected, 'the disconnect');
  await assert.rejects(local.control(7, 'unlock', 3000), /not connected/);
  local.stop(); // must not throw or crash the process
  await new Promise((r) => setTimeout(r, 1200));
});

test('a wrong encryption key does not crash and is reported', async () => {
  const brain = new LockBrain({ aesKey: Buffer.from(AES_HEX, 'hex'), unlockKey: UNLOCK_KEY });
  const fake = new FakeEsphome({ lockMac: MAC, brain });
  const port = await fake.start();
  const warnings = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m) };
  const local = new LocalController(
    { espHost: '127.0.0.1', espPort: port, espEncryptionKey: Buffer.alloc(32, 7).toString('base64'), manualKeysJson: haEntry, useAppAccount: false, readHistory: false },
    memoryStore(),
    log,
    { onAdvertisement() {}, onRecords() {} },
  );
  try {
    await local.start([{ lockId: 7, lockAlias: 'Front Door', lockMac: MAC }]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(local.connected, false);
  } finally {
    local.stop();
    await fake.stop();
  }
});

test('reads who/how from the lock history when it reports new records (opt-in)', async () => {
  const brain = new LockBrain({ aesKey: Buffer.from(AES_HEX, 'hex'), unlockKey: UNLOCK_KEY });
  const fake = new FakeEsphome({ lockMac: MAC, brain });
  const port = await fake.start();
  const records = [];
  const local = new LocalController(
    { espHost: '127.0.0.1', espPort: port, manualKeysJson: haEntry, useAppAccount: false, readHistory: true },
    memoryStore(),
    silentLog,
    { onAdvertisement() {}, onRecords: (lockId, r) => records.push({ lockId, r }) },
  );
  const page = (seq, rec) => [0x25, 0x01, 0x00, rec.length + 3, seq >> 8, seq & 0xff, rec.length, ...rec];
  const fingerprint = [20, 26, 10, 9, 14, 30, 5, 88, 0, 0, 0, 0, 0, 3];
  try {
    await local.start([{ lockId: 7, lockAlias: 'Front Door', lockMac: MAC }]);
    await waitFor(() => local.connected && fake.subscribed, 'the proxy connection');
    // First read: existing history is only remembered, not reported.
    brain.historyPages = [page(5, fingerprint)];
    fake.advertise(advert({ unlocked: true, battery: 60, newRecords: true }));
    await waitFor(() => brain.historyPages.length === 0 && !fake.deviceConnected, 'the first history read');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(records.length, 0);
    // A new record arrives later (after the retry cooldown).
    local['historyAttemptAt'].clear();
    brain.historyPages = [page(6, fingerprint)];
    fake.advertise(advert({ unlocked: false, battery: 60, newRecords: true }));
    await waitFor(() => records.length === 1, 'the new record');
    assert.equal(records[0].lockId, 7);
    assert.equal(records[0].r[0].recordType, 20);
    assert.equal(records[0].r[0].credential, '3');
  } finally {
    local.stop();
    await fake.stop();
  }
});
