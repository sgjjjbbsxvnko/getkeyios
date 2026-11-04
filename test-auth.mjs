import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifyRSA, webcrypto } from 'node:crypto';
import worker from './ios-worker.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const clock = { now: Date.parse('2026-11-03T00:00:00.000Z') };
Date.now = () => clock.now;
const DAY = 86400000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const rows = new Map();
const db = {
  prepare(sql) {
    const q = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    return {
      bind(...args) {
        return {
          async run() {
            if (q.startsWith('INSERT INTO IOS_KEYS')) {
              const [license_key, voucher_hash, voucher_deadline, duration_hours, created_at] = args;
              if (rows.has(license_key)) throw Error('UNIQUE constraint failed');
              rows.set(license_key, { license_key, voucher_hash, voucher_deadline, duration_hours,
                created_at, status: 'pending', device_hash: null, claimed_at: null,
                activated_at: null, expires_at: null });
              return { success: true };
            }
            throw Error('Unexpected run SQL: ' + q);
          },
          async first() {
            if (q.startsWith('UPDATE IOS_KEYS SET STATUS =') && q.includes('VOUCHER_HASH = NULL')) {
              const [hash, current] = args;
              const row = [...rows.values()].find(r => r.voucher_hash === hash && r.status === 'pending' && r.voucher_deadline > current);
              if (!row) return null;
              row.status = 'active'; row.voucher_hash = null; row.activated_at = null; row.expires_at = null;
              return { license_key: row.license_key };
            }
            if (q.startsWith('SELECT STATUS, EXPIRES_AT')) {
              const row = rows.get(args[0]);
              return row ? { status: row.status, expires_at: row.expires_at,
                device_hash: row.device_hash, claimed_at: row.claimed_at } : null;
            }
            if (q.startsWith('UPDATE IOS_KEYS SET DEVICE_HASH')) {
              const [hash, claimed, activated, expiry, key, now, allowedHash, nowForMatch, nowForCap] = args;
              const row = rows.get(key);
              if (!row || row.status !== 'active') return null;
              const firstUse = !row.device_hash && (row.expires_at == null || row.expires_at > now);
              const sameDevice = row.device_hash === allowedHash && row.expires_at > nowForMatch &&
                (row.claimed_at == null || row.claimed_at + DAY > nowForCap);
              if (!firstUse && !sameDevice) return null;
              if (!row.device_hash) { row.device_hash = hash; row.activated_at = activated; row.expires_at = expiry; }
              row.claimed_at ??= claimed;
              return { license_key: key, expires_at: row.expires_at, claimed_at: row.claimed_at };
            }
            if (q.startsWith('SELECT LICENSE_KEY, EXPIRES_AT')) {
              const [key, now, hash, capNow] = args;
              const row = rows.get(key);
              return row && row.status === 'active' && row.expires_at > now &&
                row.device_hash === hash && (row.claimed_at == null || row.claimed_at + DAY > capNow)
                ? { license_key: key, expires_at: row.expires_at, claimed_at: row.claimed_at } : null;
            }
            if (q.startsWith('UPDATE IOS_KEYS SET STATUS =') && q.includes("'REVOKED'")) {
              const row = rows.get(args[0]);
              if (!row) return null;
              row.status = 'revoked'; return { license_key: row.license_key };
            }
            throw Error('Unexpected first SQL: ' + q);
          }
        };
      }
    };
  }
};
const env = {
  DB: db,
  IOS_ADMIN_TOKEN: 'admin-test-123456789012345678901234567890',
  IOS_DEVICE_SALT: 'ios-device-salt-1234567890123456789012345',
  IOS_AUTH_PRIVATE_KEY_PEM: privateKey,
  IOS_API_LIMITER: { async limit() { return { success: true }; } },
  IOS_ADMIN_LIMITER: { async limit() { return { success: true }; } }
};
async function post(path, body, admin = false) {
  const res = await worker.fetch(new Request('https://ios.test' + path, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      ...(admin ? { authorization: 'Bearer ' + env.IOS_ADMIN_TOKEN } : {})
    }, body: JSON.stringify(body)
  }), env);
  return { status: res.status, payload: await res.json() };
}
const deviceA = '879cbddd-517e-4cd7-9a34-9bcabf57bff7';
const deviceB = '973cbddd-517e-4cd7-9a34-9bcabf57bff7';
const nonce = '0123456789abcdef'.repeat(3);
const createPath = '/api/ios/admin/create-key';
assert.equal((await post(createPath, { planHours: 72 }, true)).status, 400, 'reject all non-24h plans');
assert.equal((await post(createPath, { planHours: 12 }, true)).status, 400);
assert.equal((await post(createPath, { planHours: 24 })).status, 401, 'admin credential required');
const created = await post(createPath, {}, true);
assert.equal(created.status, 201);
assert.equal(created.payload.data.planHours, 24);
const voucher = created.payload.data.voucher;
const redeemed = await post('/api/ios/redeem', { voucher });
assert.equal(redeemed.status, 200);
assert.equal(redeemed.payload.data.status, 'unactivated');
assert.equal(redeemed.payload.data.expiresAt, null, '24h must not start at website redeem');
const key = redeemed.payload.data.key;
assert.match(key, /^IOS-/);
assert.equal((await post('/api/ios/redeem', { voucher })).status, 403, 'voucher is one use only');
assert.equal((await post('/api/ios/status', { key })).payload.data.status, 'unactivated');
assert.equal((await post('/api/ios/verify', { key, deviceId: deviceA, nonce })).status, 403,
  'verify cannot activate a key');
clock.now += 5 * DAY; // Key can wait before the first activation; usage clock has not started.
const activatedAt = clock.now;
const claimed = await post('/api/ios/claim', { key, deviceId: deviceA, nonce });
assert.equal(claimed.status, 200);
assert.equal(claimed.payload.data.expiresAtMs - activatedAt, DAY, 'exact 24h');
assert.equal(claimed.payload.data.planHours, 24);
assert.equal(rows.get(key).claimed_at, activatedAt);
const a = claimed.payload.auth;
const canonical = [ 'SENT-IOS-AUTH-V1', `action=${a.action}`, `nonce=${a.nonce}`, `key=${key}`,
  `deviceDigest=${a.deviceDigest}`, `expiresAtMs=${claimed.payload.data.expiresAtMs}`,
  `serverTimeMs=${a.serverTimeMs}`, 'product=ios', 'valid=1' ].join('\n');
assert.ok(verifyRSA('RSA-SHA256', Buffer.from(canonical), publicKey, Buffer.from(a.signature, 'base64url')),
  'RSA auth signature must verify');
assert.equal((await post('/api/ios/claim', { key, deviceId: deviceB, nonce })).status, 403,
  'second device cannot claim');
assert.equal((await post('/api/ios/verify', { key, deviceId: deviceB, nonce })).status, 403);
assert.equal((await post('/api/ios/status', { key })).payload.data.status, 'active');
clock.now = activatedAt + DAY - 1;
const repeat = await post('/api/ios/claim', { key, deviceId: deviceA, nonce });
assert.equal(repeat.status, 200, 'same device allowed before expiry');
assert.equal(repeat.payload.data.expiresAtMs, activatedAt + DAY, 'repeat claim MUST NOT renew');
assert.equal((await post('/api/ios/verify', { key, deviceId: deviceA, nonce })).status, 200);
clock.now = activatedAt + DAY;
assert.equal((await post('/api/ios/claim', { key, deviceId: deviceA, nonce })).status, 403,
  'cannot reactivate expired key');
assert.equal((await post('/api/ios/verify', { key, deviceId: deviceA, nonce })).status, 403,
  'verify fails exactly at 24h boundary');
assert.equal((await post('/api/ios/status', { key })).payload.data.status, 'expired');
assert.equal((await post('/api/ios/admin/revoke-key', { key }, true)).status, 200);
assert.equal((await post('/api/ios/status', { key })).payload.data.status, 'revoked');
assert.equal((await post('/api/ios/claim', { key, deviceId: deviceA, nonce })).status, 403);
console.log('PASS: ONLY 24H | redeem does not start timer | first claim starts 24h | RSA signature | strict one device | no renewal | exact expiry | revoke');
