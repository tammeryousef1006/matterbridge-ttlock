import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { TTLockAppCloud, signRequest } from '../dist/ble/appCloud.js';
import { LocalController } from '../dist/local.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const MAC = 'C1:D2:E3:F4:A5:B6';

// Encode a numeric unlock key the way the cloud does (base64 of encoded byte CSV).
const ENCODED_LOCK_KEY = 'MjQxLDI0MiwyNDMsMjQ0LDI0NSwyNDYsMjQ3LDI0OCwyNDksOTI='; // "123456789"

function fakeServlet() {
  const state = { approved: false, codesSent: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(raw));
      const path = new URL(req.url, 'http://x').pathname;
      state.requests.push({ path, params, headers: req.headers });
      const send = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers.signature !== signRequest(path, params)) return send({ errcode: -3, errmsg: 'bad signature' });
      switch (path) {
        case '/lock/system/getCountryAndSiteInfo':
          return send({ siteId: 1, countryId: 2 });
        case '/lock/user/login':
          if (params.password !== 'e10adc3949ba59abbe56e057f20f883e') return send({ errcode: -1003, errmsg: 'wrong password' });
          if (!state.approved) return send({ errcode: -1014, errmsg: 'new device' });
          return send({ uid: 77, accessToken: 'tok' });
        case '/lock/user/sendValidationCode':
          state.codesSent++;
          return send({ errcode: 0 });
        case '/lock/user/loginNewDeviceValidation':
          if (params.verificationCode !== '4321') return send({ errcode: -1, errmsg: 'wrong code' });
          state.approved = true;
          return send({ errcode: 0 });
        case '/lock/check/syncDataPage':
          if (req.headers.accesstoken !== 'tok') return send({ errcode: 10003 });
          return send({
            pages: 1,
            keyInfos: [
              { keyId: 1, lockId: 7, lockMac: MAC, lockAlias: 'Front', aesKeyStr: '00,11,22,33,44,55,66,77,88,99,aa,bb,cc,dd,ee,ff', lockKey: ENCODED_LOCK_KEY, lockVersion: { protocolType: 5, protocolVersion: 3, scene: 2, groupId: 1, orgId: 7 } },
              { keyId: 2, lockId: 8, lockMac: 'nope' },
            ],
          });
        default:
          return send({ errcode: -404 });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('logs in, handles new-device verification, and downloads keys', async () => {
  const { server, state, url } = await fakeServlet();
  try {
    const cloud = new TTLockAppCloud('unique-1', url);
    await assert.rejects(cloud.login('me@example.com', '123456'), (e) => e.needsVerification === true);
    await cloud.requestVerificationCode('me@example.com');
    await cloud.validateNewDevice('me@example.com', '4321');
    await cloud.login('me@example.com', '123456');
    const keys = await cloud.listKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].unlockKey, '123456789');
    assert.equal(keys[0].uid, 77);
    assert.equal(keys[0].lockMac, MAC);
    assert.equal(state.codesSent, 1);
  } finally {
    server.close();
  }
});

test('the local controller asks for the verification code once, then uses it', async () => {
  const { server, state, url } = await fakeServlet();
  const data = new Map();
  const store = { get: async (k, d) => (data.has(k) ? data.get(k) : d), set: async (k, v) => void data.set(k, v) };
  const warnings = [];
  const log = { ...silentLog, warn: (m) => warnings.push(m) };
  const lock = { lockId: 7, lockAlias: 'Front', lockMac: MAC };
  // Point the app cloud at the fake server.
  const realFetchBase = TTLockAppCloud.prototype.discoverSite;
  TTLockAppCloud.prototype.discoverSite = async function () {
    this.baseUrl = url;
  };
  try {
    const opts = { espHost: '127.0.0.1', espPort: 1, useAppAccount: true, appUsername: 'me@example.com', appPassword: '123456', readHistory: false };
    const first = new LocalController(opts, store, log, { onAdvertisement() {}, onRecords() {} });
    await first['loadKeys']([lock]);
    assert.equal(first.hasKey(7), false);
    assert.equal(state.codesSent, 1);
    assert.ok(warnings.some((w) => /verification code/.test(w)));

    const second = new LocalController({ ...opts, verificationCode: '4321' }, store, log, { onAdvertisement() {}, onRecords() {} });
    second['lockIdsByMac'].set(MAC, 7);
    await second['loadKeys']([lock]);
    assert.equal(second.hasKey(7), true);
    assert.equal(data.get('localKeyCache').length, 1);

    // Later starts use the cached key without logging in.
    const before = state.requests.length;
    const third = new LocalController(opts, store, log, { onAdvertisement() {}, onRecords() {} });
    third['lockIdsByMac'].set(MAC, 7);
    await third['loadKeys']([lock]);
    assert.equal(third.hasKey(7), true);
    assert.equal(state.requests.length, before);
  } finally {
    TTLockAppCloud.prototype.discoverSite = realFetchBase;
    server.close();
  }
});
