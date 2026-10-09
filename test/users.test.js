import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMirror, findUser } from '../dist/users.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const creds = [
  { kind: 'fingerprint', id: 101, value: '47648314753024', name: 'Tamer' },
  { kind: 'fingerprint', id: 102, value: '47648314753025', name: 'Wife' },
  { kind: 'fingerprint', id: 103, value: '47648314753026', name: 'Daughter' },
  { kind: 'card', id: 201, value: '3735928559', name: 'tamer' },
  { kind: 'passcode', id: 301, value: '123456', name: 'Cleaner', endDate: NOW - 1000 },
  { kind: 'fingerprint', id: 104, value: '99', name: '' },
];
const empty = { users: {}, credentials: {} };

test('groups credentials by name into users', () => {
  const { users } = buildMirror(creds, empty, NOW);
  const byName = Object.fromEntries(users.map((u) => [u.name, u]));
  assert.equal(users.length, 5);
  assert.deepEqual(byName.Tamer.credentials.map((c) => c.kind).sort(), ['card', 'fingerprint']);
  assert.equal(byName.Wife.credentials.length, 1);
  assert.equal(byName.Cleaner.enabled, false, 'expired passcode -> disabled user');
  assert.ok(users.find((u) => u.name === 'Finger 99'), 'unnamed credential gets its own user');
  // Matter types: PIN 1, RFID 2, fingerprint 3
  assert.equal(byName.Tamer.credentials.find((c) => c.kind === 'card').type, 2);
  assert.equal(byName.Cleaner.credentials[0].type, 1);
  // Unique user and per-type credential indexes
  assert.equal(new Set(users.map((u) => u.index)).size, users.length);
  const fp = users.flatMap((u) => u.credentials).filter((c) => c.type === 3).map((c) => c.index);
  assert.equal(new Set(fp).size, fp.length);
});

test('keeps user and credential numbers stable across syncs', () => {
  const first = buildMirror(creds, empty, NOW);
  // The wife's fingerprint is removed and a new person is added.
  const next = creds.filter((c) => c.id !== 102).concat({ kind: 'fingerprint', id: 105, value: '7', name: 'Guest' });
  const second = buildMirror(next, first.indexes, NOW);
  const idx = (m, name) => m.users.find((u) => u.name === name)?.index;
  for (const name of ['Tamer', 'Daughter', 'Cleaner']) assert.equal(idx(second, name), idx(first, name));
  assert.equal(idx(second, 'Wife'), undefined);
  assert.equal(idx(second, 'Guest'), idx(first, 'Wife'), 'freed number is reused');
});

test('shortens names to the 10 characters Matter allows', () => {
  const { users } = buildMirror([{ kind: 'card', id: 1, name: 'Grandmother Fatima' }], empty, NOW);
  assert.equal(users[0].matterName, 'Grandmothe');
  assert.equal(users[0].name, 'Grandmother Fatima');
});

test('finds who used a credential from record data', () => {
  const mirror = buildMirror(creds, empty, NOW);
  assert.equal(findUser(mirror, 'fingerprint', '47648314753024').user.name, 'Tamer');
  assert.equal(findUser(mirror, 'card', '3735928559').credential.type, 2);
  assert.equal(findUser(mirror, 'passcode', '123456').user.name, 'Cleaner');
  assert.equal(findUser(mirror, 'fingerprint', '0047648314753025').user.name, 'Wife', 'leading zeros ignored');
  assert.equal(findUser(mirror, undefined, undefined, 'daughter').user.name, 'Daughter');
  assert.equal(findUser(mirror, 'fingerprint', '1'), undefined);
  assert.equal(findUser(undefined, 'fingerprint', '1'), undefined);
});
