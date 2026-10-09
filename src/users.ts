/**
 * Mirrors a lock's TTLock credentials (fingerprints, cards, passcodes) as
 * Matter door-lock users. TTLock has no users, only named credentials, so
 * credentials with the same name become one user ("Tamer": fingerprint + card).
 */
import { TTLockCredential } from './ttlockApi.js';

/** Matter credential types (DoorLock.CredentialType). */
export const MATTER_CREDENTIAL_TYPE = { passcode: 1, card: 2, fingerprint: 3 } as const;
/** Matter limits user names to 10 characters. */
const MAX_USER_NAME = 10;

export interface MirrorIndexes {
  /** User index by normalised name, so a user keeps its number across syncs. */
  users: Record<string, number>;
  /** Credential index by "kind:ttlockId". */
  credentials: Record<string, number>;
}

export interface MirrorCredential {
  kind: TTLockCredential['kind'];
  ttlockId: number;
  value?: string;
  type: number;
  index: number;
}

export interface MirrorUser {
  index: number;
  /** Full name, for logs. */
  name: string;
  /** Name as shown in Matter (max 10 characters). */
  matterName: string;
  enabled: boolean;
  credentials: MirrorCredential[];
}

export interface Mirror {
  users: MirrorUser[];
  indexes: MirrorIndexes;
}

const KIND_LABEL: Record<TTLockCredential['kind'], string> = { fingerprint: 'Finger', card: 'Card', passcode: 'Code' };

function nextFree(used: Iterable<number>): number {
  const taken = new Set(used);
  let i = 1;
  while (taken.has(i)) i++;
  return i;
}

/** A credential is disabled once its validity period has ended. */
function isActive(c: TTLockCredential, now: number): boolean {
  return !(c.endDate && c.endDate > 0 && c.endDate < now);
}

export function buildMirror(credentials: TTLockCredential[], previous: MirrorIndexes, now = Date.now()): Mirror {
  const indexes: MirrorIndexes = { users: {}, credentials: {} };

  // Group by name; unnamed credentials each get their own user.
  const groups = new Map<string, { name: string; items: TTLockCredential[] }>();
  for (const c of credentials) {
    const name = c.name || `${KIND_LABEL[c.kind]} ${c.value && c.kind !== 'passcode' ? c.value.slice(-4) : c.id}`;
    const key = c.name ? `name:${c.name.toLowerCase()}` : `${c.kind}:${c.id}`;
    const group = groups.get(key) ?? { name, items: [] };
    group.items.push(c);
    groups.set(key, group);
  }

  // Keep previous indexes where possible, then hand out the lowest free ones.
  const keys = [...groups.keys()].sort();
  for (const key of keys) if (previous.users[key] !== undefined) indexes.users[key] = previous.users[key];
  for (const key of keys) if (indexes.users[key] === undefined) indexes.users[key] = nextFree(Object.values(indexes.users));

  const credentialKeys = credentials.map((c) => `${c.kind}:${c.id}`);
  for (const key of credentialKeys) if (previous.credentials[key] !== undefined) indexes.credentials[key] = previous.credentials[key];
  for (const c of credentials) {
    const key = `${c.kind}:${c.id}`;
    if (indexes.credentials[key] !== undefined) continue;
    // Indexes are per credential type.
    const sameType = credentials.filter((o) => o.kind === c.kind).map((o) => indexes.credentials[`${o.kind}:${o.id}`]).filter((i) => i !== undefined);
    indexes.credentials[key] = nextFree(sameType);
  }

  const users: MirrorUser[] = keys.map((key) => {
    const group = groups.get(key)!;
    return {
      index: indexes.users[key],
      name: group.name,
      matterName: group.name.slice(0, MAX_USER_NAME),
      enabled: group.items.some((c) => isActive(c, now)),
      credentials: group.items.map((c) => ({
        kind: c.kind,
        ttlockId: c.id,
        value: c.value,
        type: MATTER_CREDENTIAL_TYPE[c.kind],
        index: indexes.credentials[`${c.kind}:${c.id}`],
      })),
    };
  });
  users.sort((a, b) => a.index - b.index);
  return { users, indexes };
}

/**
 * Find who used a credential, from what a record carries: the fingerprint or
 * card number (lock history), the passcode digits, or a name (cloud record).
 */
export function findUser(mirror: Mirror | undefined, kind: TTLockCredential['kind'] | undefined, value: string | undefined, name?: string): { user: MirrorUser; credential?: MirrorCredential } | undefined {
  if (!mirror) return undefined;
  if (kind && value) {
    for (const user of mirror.users) {
      const credential = user.credentials.find((c) => c.kind === kind && c.value !== undefined && stripZeros(c.value) === stripZeros(value));
      if (credential) return { user, credential };
    }
  }
  if (name) {
    const user = mirror.users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase());
    if (user) return { user, credential: kind ? user.credentials.find((c) => c.kind === kind) : undefined };
  }
  return undefined;
}

function stripZeros(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, '');
}
