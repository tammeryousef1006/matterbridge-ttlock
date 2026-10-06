import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { TTLockApi, TTLockApiError, TTLockOpenState } from '../dist/ttlockApi.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// Minimal fake of the TTLock Open Platform API
const state = { requests: [], tokens: 0, validToken: null, rejectNextToken: false, locks: [], expiresIn: 7776000 };

function reset() {
  state.requests = [];
  state.tokens = 0;
  state.validToken = null;
  state.rejectNextToken = false;
  state.expiresIn = 7776000;
  state.locks = Array.from({ length: 150 }, (_, i) => ({ lockId: i + 1, lockAlias: `Lock ${i + 1}`, electricQuantity: 80, hasGateway: 1 }));
}

function send(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(raw);
    state.requests.push({ method: req.method, path: url.pathname, params });

    if (url.pathname === '/oauth2/token') {
      if (params.get('clientSecret') !== 'secret') return send(res, { errcode: 10001, errmsg: 'invalid client' });
      if (params.get('grant_type') !== 'refresh_token' && params.get('password') !== 'e10adc3949ba59abbe56e057f20f883e') {
        return send(res, { errcode: 10007, errmsg: 'invalid account or invalid password' });
      }
      state.tokens++;
      state.validToken = `token-${state.tokens}`;
      return send(res, { access_token: state.validToken, refresh_token: `refresh-${state.tokens}`, expires_in: state.expiresIn });
    }

    if (state.rejectNextToken || params.get('accessToken') !== state.validToken) {
      state.rejectNextToken = false;
      return send(res, { errcode: 10003, errmsg: 'invalid token' });
    }

    switch (url.pathname) {
      case '/v3/lock/list': {
        const pageNo = Number(params.get('pageNo'));
        const pageSize = Number(params.get('pageSize'));
        const list = state.locks.slice((pageNo - 1) * pageSize, pageNo * pageSize);
        return send(res, { list, pageNo, pageSize, pages: Math.ceil(state.locks.length / pageSize), total: state.locks.length });
      }
      case '/v3/lock/lock':
        return send(res, { errcode: 0, errmsg: 'none' });
      case '/v3/lock/unlock':
        return params.get('lockId') === '99' ? send(res, { errcode: -2012, errmsg: 'The lock is not connected to any gateway.' }) : send(res, { errcode: 0, errmsg: 'none' });
      case '/v3/lock/queryOpenState':
        return send(res, { state: params.get('lockId') === '2' ? 1 : params.get('lockId') === '3' ? 2 : 0 });
      default:
        res.writeHead(404);
        res.end();
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
after(() => server.close());
beforeEach(reset);

function createApi(overrides = {}) {
  return new TTLockApi({ baseUrl, clientId: 'client', clientSecret: 'secret', username: 'user', password: '123456', ...overrides }, silentLog);
}

test('logs in with an md5-hashed password', async () => {
  const api = createApi();
  await api.ensureAuthenticated();
  assert.equal(api.isAuthenticated, true);
  const login = state.requests.find((r) => r.path === '/oauth2/token');
  assert.equal(login.params.get('username'), 'user');
  assert.equal(login.params.get('password'), 'e10adc3949ba59abbe56e057f20f883e');
});

test('reports bad credentials', async () => {
  const api = createApi({ password: 'wrong' });
  await assert.rejects(api.ensureAuthenticated(), (error) => error instanceof TTLockApiError && error.errcode === 10007);
});

test('shares a single login between concurrent calls', async () => {
  const api = createApi();
  await Promise.all([api.lock(1), api.unlock(1), api.queryOpenState(1)]);
  assert.equal(state.tokens, 1);
});

test('lists locks across all pages', async () => {
  const locks = await createApi().listLocks();
  assert.equal(locks.length, 150);
  assert.equal(locks[149].lockId, 150);
  assert.equal(state.requests.filter((r) => r.path === '/v3/lock/list').length, 2);
});

test('re-authenticates once when the token is rejected', async () => {
  const api = createApi();
  await api.ensureAuthenticated();
  state.rejectNextToken = true;
  await api.lock(1);
  assert.equal(state.tokens, 2);
  // The second token should come from the refresh token, not a new password login
  const tokenRequests = state.requests.filter((r) => r.path === '/oauth2/token');
  assert.equal(tokenRequests[1].params.get('grant_type'), 'refresh_token');
  assert.equal(tokenRequests[1].params.get('refresh_token'), 'refresh-1');
});

test('refreshes a token that is about to expire', async () => {
  state.expiresIn = 60; // inside the refresh margin
  const api = createApi();
  await api.ensureAuthenticated();
  await api.lock(1);
  assert.equal(state.tokens, 2);
});

test('uses a static access token when no username/password is configured', async () => {
  state.validToken = 'static';
  const api = createApi({ username: undefined, password: undefined, accessToken: 'static' });
  await api.lock(1);
  assert.equal(state.tokens, 0);
});

test('surfaces TTLock command errors', async () => {
  await assert.rejects(createApi().unlock(99), (error) => error instanceof TTLockApiError && error.errcode === -2012 && /gateway/.test(error.message));
});

test('maps the lock open state', async () => {
  const api = createApi();
  assert.equal(await api.queryOpenState(1), TTLockOpenState.Locked);
  assert.equal(await api.queryOpenState(2), TTLockOpenState.Unlocked);
  assert.equal(await api.queryOpenState(3), TTLockOpenState.Unknown);
});

test('wraps network failures', async () => {
  const api = new TTLockApi({ baseUrl: 'http://127.0.0.1:1', clientId: 'c', clientSecret: 's', accessToken: 't', timeoutMs: 2000 }, silentLog);
  await assert.rejects(api.lock(1), TTLockApiError);
});
