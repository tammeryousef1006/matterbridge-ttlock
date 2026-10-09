import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebhookServer, buildWebhookUrl, parseCallbackBody } from '../dist/webhook.js';
import { classifyCloudRecord, classifyLockRecord } from '../dist/records.js';
import { keyFromLockData, keysFromConfigText } from '../dist/ble/keys.js';
import { codecDecode } from '../dist/ble/crypto.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('parses TTLock callback bodies (form data with a JSON records string)', () => {
  const records = JSON.stringify([{ lockId: 11, recordType: 8, recordTypeFromLock: 20, success: 1, username: 'Tamer', lockDate: 1760000000000, electricQuantity: 81 }]);
  const form = new URLSearchParams({ lockId: '11', notifyType: '1', records, admin: 'x' }).toString();
  const parsed = parseCallbackBody(form, 'application/x-www-form-urlencoded');
  assert.deepEqual(parsed, [{ lockId: 11, lockMac: undefined, recordType: 8, recordTypeFromLock: 20, success: true, username: 'Tamer', keyboardPwd: undefined, lockDate: 1760000000000, battery: 81 }]);
});

test('parses JSON callback bodies and single records', () => {
  assert.equal(parseCallbackBody(JSON.stringify({ lockMac: 'AA:BB', records: [{ recordType: 4, success: 0 }] }), 'application/json')[0].success, false);
  assert.equal(parseCallbackBody(JSON.stringify({ lockId: 3, recordType: 45 }), 'application/json')[0].recordType, 45);
  assert.deepEqual(parseCallbackBody('', 'application/json'), []);
  assert.deepEqual(parseCallbackBody(JSON.stringify({ hello: 1 }), 'application/json'), []);
});

test('classifies record types', () => {
  assert.deepEqual(classifyCloudRecord(8), { operation: 'unlock', method: 'fingerprint', success: true });
  assert.deepEqual(classifyLockRecord(20), { operation: 'unlock', method: 'fingerprint', success: true });
  assert.equal(classifyCloudRecord(45).operation, 'lock');
  assert.equal(classifyLockRecord(22).success, false);
  assert.equal(classifyCloudRecord(30), undefined); // door sensor: not a lock operation
});

test('builds the webhook URL from the public URL', () => {
  assert.equal(buildWebhookUrl('https://lock.example.com/', 'abc'), 'https://lock.example.com/ttlock/abc');
  assert.equal(buildWebhookUrl(' https://x.trycloudflare.com ', 't0k'), 'https://x.trycloudflare.com/ttlock/t0k');
});

test('webhook server accepts records only on the secret path and answers "success"', async () => {
  const received = [];
  const server = new WebhookServer(0, 'secret-token', (r) => received.push(...r), silentLog);
  await server.start();
  const base = `http://127.0.0.1:${server.listeningPort}`;
  try {
    const body = new URLSearchParams({ lockId: '5', records: JSON.stringify([{ recordType: 8, success: 1 }]) });
    const ok = await fetch(`${base}/ttlock/secret-token`, { method: 'POST', body });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'success');
    assert.equal(received.length, 1);
    assert.equal(received[0].lockId, 5);

    const wrong = await fetch(`${base}/ttlock/wrong`, { method: 'POST', body });
    assert.equal(wrong.status, 404);
    assert.equal(received.length, 1);

    const check = await fetch(`${base}/ttlock/secret-token`);
    assert.equal(await check.text(), 'success');

    const garbage = await fetch(`${base}/ttlock/secret-token`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    assert.equal(garbage.status, 200);
  } finally {
    await server.stop();
  }
});

test('webhook server reports a busy port', async () => {
  const a = new WebhookServer(0, 't', () => {}, silentLog);
  await a.start();
  const b = new WebhookServer(a.listeningPort, 't', () => {}, silentLog);
  await assert.rejects(b.start(), /already in use/);
  await a.stop();
});

test('reads keys pasted from Home Assistant or the TTLock app cloud', () => {
  const ha = { data: { keys: [{ lockMac: 'aa:bb:cc:dd:ee:ff', lockVersion: { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 1, orgId: 1 }, aesKeyStr: '00112233445566778899aabbccddeeff', unlockKey: '42', uid: 9 }] } };
  const [key] = keysFromConfigText(JSON.stringify(ha));
  assert.equal(key.lockMac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(key.unlockKey, '42');
  assert.equal(key.uid, 9);
  // Cloud-style: comma-separated AES key and lockVersion as a JSON string
  const cloud = [{ lockMac: 'AABBCCDDEEFF', lockVersion: JSON.stringify({ protocolType: 5, protocolVersion: 3, scene: 2 }), aesKeyStr: '00,11,22,33,44,55,66,77,88,99,aa,bb,cc,dd,ee,ff', lockKey: '7' }];
  assert.equal(keysFromConfigText(JSON.stringify(cloud))[0].aesKey.toString('hex'), '00112233445566778899aabbccddeeff');
  assert.deepEqual(keysFromConfigText(''), []);
  assert.throws(() => keysFromConfigText('{oops'), /not valid JSON/);
});

test('lockData decoding tries known encodings and explains failures', () => {
  const inner = { lockVersion: { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 0, orgId: 0 }, aesKeyStr: '00112233445566778899aabbccddeeff', lockKey: '99' };
  const plain = Buffer.from(JSON.stringify(inner));
  assert.equal(keyFromLockData(Buffer.from(JSON.stringify(inner)).toString('base64'), 'AA:BB:CC:DD:EE:FF', 1).key.unlockKey, '99');
  // codec-encoded: find a last byte so that decoding yields the plain JSON
  const encoded = Buffer.concat([plain, Buffer.from([0x33])]);
  const xor = codecDecode(Buffer.concat([Buffer.alloc(plain.length), Buffer.from([0x33])]))[0];
  for (let i = 0; i < plain.length; i++) encoded[i] = plain[i] ^ xor;
  assert.equal(keyFromLockData(encoded.toString('base64'), 'AA:BB:CC:DD:EE:FF', 1).key.source, 'lockData (base64 + codec)');
  const failed = keyFromLockData('bm90IGtleXM=', 'AA:BB:CC:DD:EE:FF', 1);
  assert.equal(failed.key, undefined);
  assert.match(failed.diagnostic, /could not decode lockData \(12 chars, base64-like\)/);
});
