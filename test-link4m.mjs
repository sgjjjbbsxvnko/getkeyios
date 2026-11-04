import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from './ios-worker.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const now = Date.parse('2026-11-04T00:00:00Z');
Date.now = () => now;
const sessions = new Map();
const keys = new Map();
const callbacks = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const apiUrl = new URL(url);
  assert.equal(apiUrl.hostname, 'link4m.co');
  assert.equal(apiUrl.pathname, '/api-shorten/v2');
  assert.equal(apiUrl.searchParams.get('api'), 'test-link4m-token');
  callbacks.push(apiUrl.searchParams.get('url'));
  return new Response(JSON.stringify({ status: 'success', shortenedUrl: `https://link4m.co/demo-${callbacks.length}` }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};
const normalized = sql => sql.replace(/\s+/g, ' ').trim().toUpperCase();
function prepare(sql) {
  const q = normalized(sql);
  return { bind(...args) {
    return {
      async run() {
        if (q.startsWith('INSERT INTO IOS_LINK_SESSIONS')) {
          const [hash, created_at, expires_at] = args;
          sessions.set(hash, {session_hash: hash, created_at, expires_at, stage: 'started', stage2_hash: null, license_key: null});
          return { meta: { changes: 1 } };
        }
        if (q.startsWith('DELETE FROM IOS_LINK_SESSIONS')) {
          const [hash] = args;
          if (sessions.get(hash)?.stage === 'started') sessions.delete(hash);
          return { meta: { changes: 1 } };
        }
        throw new Error('unknown run SQL: ' + q);
      },
      async first() {
        if (q.startsWith('SELECT STAGE, EXPIRES_AT, STAGE2_HASH')) {
          const row = sessions.get(args[0]); return row ? {...row} : null;
        }
        if (q.startsWith('SELECT STAGE, LICENSE_KEY, EXPIRES_AT')) {
          const row = sessions.get(args[0]); return row ? {...row} : null;
        }
        if (q.startsWith('SELECT STAGE, LICENSE_KEY FROM IOS_LINK_SESSIONS')) {
          const row = sessions.get(args[0]); return row ? {...row} : null;
        }
        if (q.startsWith('UPDATE IOS_LINK_SESSIONS SET STAGE = \'STEP1_SEEN\'')) {
          const [proof, hash, at] = args;
          const row = sessions.get(hash);
          if (!row || row.stage !== 'started' || row.expires_at <= at) return null;
          row.stage = 'step1_seen'; row.stage2_hash = proof;
          return {session_hash: hash};
        }
        if (q.startsWith('UPDATE IOS_LINK_SESSIONS SET STAGE = \'READY\'')) {
          const [hash, proof, at] = args;
          const row = sessions.get(hash);
          if (!row || row.stage !== 'step1_seen' || row.stage2_hash !== proof || row.expires_at <= at) return null;
          row.stage = 'ready'; row.stage2_hash = null;
          return {session_hash: hash};
        }
        throw new Error('unknown first SQL: ' + q);
      }
    };
  }};
}
const DB = {
  prepare,
  async batch(stmts) {
    // Simulate sequential, atomic transaction semantics.
    const [update, insert] = stmts;
    const [key, at, hash, checkAt] = update.args;
    const row = sessions.get(hash);
    let changed = false;
    if (row?.stage === 'ready' && row.expires_at > checkAt) {
      row.stage = 'complete'; row.license_key = key; row.completed_at = at; changed = true;
    }
    const [newKey, created, secondHash, compareKey] = insert.args;
    const linked = sessions.get(secondHash);
    if (linked?.stage === 'complete' && linked.license_key === compareKey) {
      if (keys.has(newKey)) throw new Error('duplicate key');
      keys.set(newKey, { license_key: newKey, duration_hours: 24, expires_at: null, device_hash: null, created_at: created });
    }
    return [{results: changed ? [{license_key:key}] : []}, {results: []}];
  }
};
// Instrument prepared statements with their binding arguments to emulate batch.
const basePrepare = DB.prepare;
DB.prepare = sql => {
  const stmt = basePrepare(sql);
  const baseBind = stmt.bind;
  stmt.bind = (...args) => ({ ...baseBind(...args), args });
  return stmt;
};
const env = {
  DB, LINK4M_API_TOKEN: 'test-link4m-token',
  IOS_API_LIMITER: { limit: async () => ({success: true}) },
  IOS_ADMIN_LIMITER: { limit: async () => ({success: true}) }
};
async function post(path, data) {
  const r = await worker.fetch(new Request(`https://ios.example${path}`, { method: 'POST',
    headers: {'content-type':'application/json'}, body: JSON.stringify(data) }), env);
  return { status: r.status, body: await r.json() };
}
async function getUrl(url) {
  const response = await worker.fetch(new Request(url), env);
  return {status: response.status, location: response.headers.get('location')};
}
const start = await post('/api/ios/link4m/start', {});
assert.equal(start.status, 200);
assert.equal(start.body.ok, true);
assert.equal(callbacks.length, 1);
const step1 = new URL(callbacks[0]);
const token = step1.searchParams.get('session');
assert.match(token, /^[a-f0-9]{64}$/);
assert.equal((await post('/api/ios/link4m/complete', {sessionToken: token})).status, 403, 'cannot complete right after start');
assert.equal((await getUrl(`https://ios.example/senttwnhankey?session=${token}`)).location.includes('link4m_error'), true);
const visitedStep1 = await getUrl(step1.toString());
assert.equal(visitedStep1.status, 303);
assert.equal(callbacks.length, 2);
assert.equal((await post('/api/ios/link4m/complete', {sessionToken: token})).status, 403, 'step1 is insufficient');
const step2 = new URL(callbacks[1]);
const forged = new URL(step2);
forged.searchParams.set('proof', 'f'.repeat(64));
assert.ok((await getUrl(forged.toString())).location.includes('link4m_error'));
const visitedStep2 = await getUrl(step2.toString());
assert.equal(visitedStep2.status, 303);
assert.equal(new URL(visitedStep2.location).searchParams.get('session'), token);
const issue = await post('/api/ios/link4m/complete', {sessionToken: token});
assert.equal(issue.status, 201);
assert.match(issue.body.data.key, /^IOS-/);
assert.equal(issue.body.data.planHours, 24);
assert.equal(issue.body.data.expiresAt, null);
assert.equal(issue.body.data.status, 'unactivated');
assert.equal(keys.size, 1);
const repeat = await post('/api/ios/link4m/complete', {sessionToken: token});
assert.equal(repeat.status, 200);
assert.equal(repeat.body.reused, true);
assert.equal(repeat.body.data.key, issue.body.data.key);
assert.equal(keys.size, 1);
assert.ok((await getUrl(step2.toString())).location.includes('link4m_error'), 'callback can only be consumed once');
// This is only a browser redirect test, not proof of ad/CAPTCHA completion by Link4M.
globalThis.fetch = originalFetch;
console.log('PASS: Link4M callback two-step state | required proof | 24h unactivated key | idempotent completion');
