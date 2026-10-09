import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { aesDecrypt, aesEncrypt, aesKeyFromString, codecDecode, crc8, decodePassword } from '../dist/ble/crypto.js';
import { Frame, FrameReassembler } from '../dist/ble/frame.js';
import { parseAdvertisement, parseCheckUserTime, parseOperateLog, payloadCheckUserTime, payloadOperateLog, payloadQueryState, payloadUnlock } from '../dist/ble/commands.js';

// Generated from the reference Python library (ttlock-ble 0.3.2)
const v = JSON.parse(readFileSync(new URL('./fixtures/ble-vectors.json', import.meta.url)));
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const version = { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 1, orgId: 7 };

test('AES-128-CBC matches the reference', () => {
  for (const { plain, cipher } of v.aes) {
    assert.equal(aesEncrypt(Buffer.from(plain, 'hex'), key).toString('hex'), cipher);
    assert.equal(aesDecrypt(Buffer.from(cipher, 'hex'), key).toString('hex'), plain);
  }
});

test('CRC-8 matches the reference', () => {
  for (const { data, crc } of v.crc) assert.equal(crc8(Buffer.from(data, 'hex')), crc);
});

test('cloud field codec matches the reference', () => {
  assert.equal(codecDecode(Buffer.from(v.codec.in, 'hex')).toString('hex'), v.codec.out);
  assert.equal(decodePassword(v.password.field), v.password.plain);
  assert.equal(decodePassword('123456'), '123456');
  assert.equal(aesKeyFromString(v.aeskey.csv).toString('hex'), v.aeskey.hex);
  assert.equal(aesKeyFromString(v.aeskey.hex).toString('hex'), v.aeskey.hex);
  assert.throws(() => aesKeyFromString('nope'));
});

test('command payloads match the reference', () => {
  assert.equal(payloadCheckUserTime().toString('hex'), v.payload_check_user_time);
  assert.equal(payloadUnlock(0xfffffff0, '123456', 1700000000000).toString('hex'), v.payload_unlock);
  assert.equal(payloadOperateLog().toString('hex'), v.payload_operate_log);
});

test('encrypted command frames match the reference byte for byte', () => {
  assert.equal(Frame.forLock(version, 0x55, payloadCheckUserTime(), key).build().toString('hex'), v.frame_check_user_time);
  assert.equal(Frame.forLock(version, 0x14, payloadQueryState(), key).build().toString('hex'), v.frame_query_state);
});

test('reassembles a response split into notifications', () => {
  const wire = Buffer.from(v.response_frame, 'hex');
  const r = new FrameReassembler();
  const frames = [];
  // noise before the frame, then 7-byte chunks
  frames.push(...r.feed(Buffer.from([0x01, 0x02])));
  for (let i = 0; i < wire.length; i += 7) frames.push(...r.feed(wire.subarray(i, i + 7)));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames.map((f) => f.decrypt(key).toString('hex')), v.response_parsed);
  assert.equal(parseCheckUserTime(frames[0].decrypt(key)), v.ps_from_lock);
});

test('parses the operation log like the reference', () => {
  const { entries, lastSequence } = parseOperateLog(Buffer.from(v.operate_log.plain, 'hex'));
  assert.equal(lastSequence, v.operate_log.last);
  assert.equal(entries.length, v.operate_log.entries.length);
  entries.forEach((e, i) => {
    const ref = v.operate_log.entries[i];
    assert.equal(e.recordNumber, ref.record_number);
    assert.equal(e.recordType, ref.type);
    assert.equal(e.battery, ref.battery);
    assert.equal(e.credential, ref.password);
    const d = e.date;
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    assert.equal(local, ref.date);
  });
});

test('decodes advertisements like the reference', () => {
  for (const ref of v.adv) {
    const adv = parseAdvertisement(Buffer.from(ref.raw, 'hex'));
    assert.equal(adv.mac, ref.mac);
    assert.equal(adv.battery, ref.battery);
    assert.equal(adv.hasNewRecords, ref.records);
    assert.equal(adv.dormant, ref.dormant);
    assert.equal(adv.locked, ref.state === null ? undefined : ref.state === 0);
  }
  assert.equal(parseAdvertisement(Buffer.from('0503', 'hex')), undefined);
  assert.equal(parseAdvertisement(Buffer.from('1219' + '00'.repeat(13), 'hex')), undefined);
});
