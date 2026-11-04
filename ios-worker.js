// Sent Tweaks iOS — isolated Worker; does not import or modify Android auth.
// Configure DB, IOS_ADMIN_TOKEN, IOS_DEVICE_SALT and IOS_AUTH_PRIVATE_KEY_PEM.
const encoder = new TextEncoder();
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_RE = /^IOS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const LICENSE_HOURS = 24;
const LICENSE_MS = LICENSE_HOURS * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
let privateKeyCache = { source: null, promise: null };
const baseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
};

function apiJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: baseHeaders });
}
function apiError(code, status = 400) {
  return apiJson({ ok: false, error: code }, status);
}
function randomString(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(byte => KEY_CHARS[byte % KEY_CHARS.length]).join('');
}
function newKey() {
  return `IOS-${randomString(5)}-${randomString(5)}-${randomString(5)}`;
}
function hex(buffer) {
  return [...new Uint8Array(buffer)].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function sha256(s) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
}
async function hmacHash(secret, s) {
  if (!secret || secret.length < 32) throw new Error('IOS_DEVICE_SALT_NOT_CONFIGURED');
  const k = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, encoder.encode(s)));
}
function importPem(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const bin = atob(base64);
  return Uint8Array.from(bin, char => char.charCodeAt(0));
}
async function signingKey(env) {
  const pem = String(env.IOS_AUTH_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n').trim();
  if (!pem) throw new Error('IOS_SIGNING_KEY_NOT_CONFIGURED');
  if (pem !== privateKeyCache.source || !privateKeyCache.promise) {
    privateKeyCache.source = pem;
    privateKeyCache.promise = crypto.subtle.importKey('pkcs8', importPem(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
      .catch(err => { privateKeyCache.promise = null; throw err; });
  }
  return privateKeyCache.promise;
}
function base64url(buf) {
  let binary = '';
  for (const b of new Uint8Array(buf)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function parseJson(request) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw new Error('JSON_REQUIRED');
  }
  const size = Number(request.headers.get('content-length') || 0);
  if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  const raw = await request.text();
  if (encoder.encode(raw).length > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('INVALID_JSON');
  return parsed;
}
function getKey(value) {
  const key = String(value || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) throw new Error('INVALID_KEY_FORMAT');
  return key;
}
function getDeviceId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(id)) throw new Error('INVALID_DEVICE_ID');
  return id;
}
function getNonce(value) {
  const nonce = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error('INVALID_NONCE');
  return nonce;
}
function rateKey(request, group) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return `${group}:${ip}`;
}
async function enforceRateLimit(request, env, admin = false) {
  const limiter = admin ? env.IOS_ADMIN_LIMITER : env.IOS_API_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null; // Configure bindings in production.
  try {
    const result = await limiter.limit({ key: rateKey(request, admin ? 'admin' : 'public') });
    if (!result.success) return apiError('RATE_LIMITED', 429);
  } catch { return apiError('RATE_LIMIT_UNAVAILABLE', 503); }
  return null;
}
function adminAllowed(request, env) {
  const token = String(env.IOS_ADMIN_TOKEN || '');
  return token.length >= 32 && request.headers.get('authorization') === `Bearer ${token}`;
}
async function handleAdminCreate(request, env) {
  if (!adminAllowed(request, env)) return apiError('UNAUTHORIZED', 401);
  const input = await parseJson(request);
  // All newly issued iOS keys are always exactly 24 hours.
  if (input.planHours !== undefined && Number(input.planHours) !== LICENSE_HOURS)
    return apiError('ONLY_24H_SUPPORTED', 400);
  const hours = LICENSE_HOURS;
  const now = Date.now();
  const voucherDays = 7;
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = newKey();
    const voucher = `IOSPASS-${randomString(30)}`;
    const hash = await sha256(voucher);
    try {
      await env.DB.prepare(`INSERT INTO ios_keys
        (license_key, voucher_hash, voucher_deadline, duration_hours, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`)
        .bind(key, hash, now + voucherDays * 86400000, hours, now).run();
      return apiJson({ ok: true, data: { voucher, planHours: hours, voucherExpiresAt: new Date(now + voucherDays * 86400000).toISOString() } }, 201);
    } catch (e) {
      if (!/unique|constraint/i.test(String(e))) throw e;
    }
  }
  return apiError('GENERATION_FAILED', 503);
}
async function handleAdminRevoke(request, env) {
  if (!adminAllowed(request, env)) return apiError('UNAUTHORIZED', 401);
  const input = await parseJson(request);
  const key = getKey(input.key);
  const out = await env.DB.prepare("UPDATE ios_keys SET status = 'revoked' WHERE license_key = ? RETURNING license_key")
    .bind(key).first();
  return out ? apiJson({ ok: true, revoked: true }) : apiError('NOT_FOUND', 404);
}
async function handleRedeem(request, env) {
  const input = await parseJson(request);
  const voucher = String(input.voucher || '').trim().toUpperCase();
  if (!/^IOSPASS-[A-HJ-NP-Z2-9]{30}$/.test(voucher)) return apiError('INVALID_VOUCHER', 400);
  const hash = await sha256(voucher);
  const now = Date.now();
  // Exchange the single-use voucher for a key, without starting its 24h clock.
  // The first successful /claim starts the license and permanently locks the device.
  const row = await env.DB.prepare(`UPDATE ios_keys
      SET status = 'active', voucher_hash = NULL, activated_at = NULL, expires_at = NULL
      WHERE voucher_hash = ? AND status = 'pending' AND voucher_deadline > ?
      RETURNING license_key`)
    .bind(hash, now).first();
  if (!row) return apiError('VOUCHER_UNAVAILABLE', 403);
  return apiJson({ ok: true, data: { key: row.license_key, planHours: LICENSE_HOURS,
    expiresAt: null, status: 'unactivated' } });
}
async function handleStatus(request, env) {
  const input = await parseJson(request);
  const key = getKey(input.key);
  const row = await env.DB.prepare('SELECT status, expires_at, device_hash, claimed_at FROM ios_keys WHERE license_key = ?')
    .bind(key).first();
  if (!row || row.status === 'pending') return apiError('LICENSE_UNAVAILABLE', 404);
  const expiresAtMs = row.expires_at == null ? null : Math.min(
    Number(row.expires_at), Number(row.claimed_at ?? row.expires_at) + LICENSE_MS);
  const status = row.status === 'revoked' ? 'revoked'
    : expiresAtMs != null && Date.now() >= expiresAtMs ? 'expired'
    : !row.device_hash ? 'unactivated' : 'active';
  return apiJson({ ok: true, data: { status, planHours: LICENSE_HOURS,
    expiresAt: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null } });
}
async function handleAuth(request, env, action) {
  // Ensure signing is correctly configured *before* binding a key to an installation.
  const privateKey = await signingKey(env);
  const input = await parseJson(request);
  const key = getKey(input.key);
  const deviceId = getDeviceId(input.deviceId);
  const nonce = getNonce(input.nonce);
  const deviceHash = await hmacHash(String(env.IOS_DEVICE_SALT || ''), deviceId);
  const deviceDigest = await sha256(deviceId);
  const now = Date.now();
  let row;
  if (action === 'claim') {
    // Atomic compare-and-set: one device wins even when two claims race.
    // An already-bound device keeps the ORIGINAL expiry, never renews it.
    // Legacy unbound rows with an old expiry may be claimed only if not expired.
    row = await env.DB.prepare(`UPDATE ios_keys
      SET device_hash = COALESCE(device_hash, ?),
          claimed_at = COALESCE(claimed_at, ?),
          activated_at = CASE WHEN device_hash IS NULL THEN ? ELSE activated_at END,
          expires_at = CASE WHEN device_hash IS NULL THEN ? ELSE expires_at END
      WHERE license_key = ? AND status = 'active' AND
        ((device_hash IS NULL AND (expires_at IS NULL OR expires_at > ?))
          OR (device_hash = ? AND expires_at > ?
              AND (claimed_at IS NULL OR claimed_at + 86400000 > ?)))
      RETURNING license_key, expires_at, claimed_at`)
      .bind(deviceHash, now, now, now + LICENSE_MS, key, now, deviceHash, now, now).first();
  } else {
    // Verify NEVER binds an unclaimed key; it is a read-only check.
    row = await env.DB.prepare(`SELECT license_key, expires_at, claimed_at FROM ios_keys
      WHERE license_key = ? AND status = 'active' AND expires_at > ? AND device_hash = ?
      AND (claimed_at IS NULL OR claimed_at + 86400000 > ?)
      `)
      .bind(key, now, deviceHash, now).first();
  }
  if (!row) return apiError('LICENSE_UNAVAILABLE_OR_DEVICE_MISMATCH', 403);
  // Cap any previously-issued longer plan at 24h from first claim as well.
  const expiresAtMs = Math.min(Number(row.expires_at), Number(row.claimed_at ?? now) + LICENSE_MS);
  if (now >= expiresAtMs) return apiError('LICENSE_EXPIRED', 403);
  const signed = [
    'SENT-IOS-AUTH-V1', `action=${action}`, `nonce=${nonce}`, `key=${key}`,
    `deviceDigest=${deviceDigest}`, `expiresAtMs=${expiresAtMs}`, 
    `serverTimeMs=${now}`, 'product=ios', 'valid=1'
  ].join('\n');
  const signature = base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(signed)));
  return apiJson({ ok: true, valid: true,
    data: { key, product: 'ios', status: 'active', planHours: LICENSE_HOURS, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() },
    auth: { protocolVersion: 1, algorithm: 'RSASSA-PKCS1-v1_5-SHA256', action, nonce,
      deviceDigest, serverTimeMs: now, signature } });
}

// Link4M two-step browser redirect integration (compatibility with Android UX).
// IMPORTANT: Link4M shortening API does not provide an authenticated proof
// that a visitor completed advertising/CAPTCHA. This establishes only that
// callback URLs were visited, NOT verified monetized completion.
const LINK_SESSION_MS = 20 * 60 * 1000;
const SESSION_RE = /^[a-f0-9]{64}$/;
const STEP_PROOF_RE = /^[a-f0-9]{64}$/;
function newHexToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function linkSession(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!SESSION_RE.test(token)) throw new Error('INVALID_LINK_SESSION');
  return token;
}
function redirectNoStore(location) {
  return new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff' }
  });
}
function linkError(request, code) {
  const uri = new URL('/', request.url);
  uri.searchParams.set('link4m_error', code);
  return redirectNoStore(uri.toString());
}
// Strict upstream origin handling: an API token must never follow redirects to
// arbitrary third-party hosts. Only allow the Link4M API hosts to redirect.
const LINK4M_API_HOSTS = new Set(['link4m.co', 'www.link4m.co', 'link4m.com', 'www.link4m.com']);
const LINK4M_RESPONSE_MAX = 16 * 1024;
async function limitedProviderText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const buffers = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LINK4M_RESPONSE_MAX) {
        await reader.cancel();
        throw new Error('LINK4M_RESPONSE_TOO_LARGE');
      }
      buffers.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) { combined.set(buffer, offset); offset += buffer.length; }
  return new TextDecoder().decode(combined);
}
function validateApiDestination(url) {
  if (url.protocol !== 'https:' || !LINK4M_API_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username || url.password || !/^\/api-shorten\/v2\/?$/.test(url.pathname)) {
    throw new Error('LINK4M_UNTRUSTED_API_REDIRECT');
  }
}
async function shortenLink(env, destination) {
  const apiKey = String(env.LINK4M_API_TOKEN || '').trim();
  if (!apiKey) throw new Error('LINK4M_NOT_CONFIGURED');
  let link4m = new URL('https://link4m.co/api-shorten/v2');
  link4m.searchParams.set('api', apiKey);
  link4m.searchParams.set('url', destination);
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    validateApiDestination(link4m);
    try {
      response = await fetch(link4m.toString(), {
        method: 'GET', headers: { accept: 'application/json' },
        redirect: 'manual', signal: AbortSignal.timeout(12000)
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('LINK4M_TIMEOUT');
      throw new Error('LINK4M_NETWORK_ERROR');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('LINK4M_INVALID_API_REDIRECT');
    let next;
    try { next = new URL(location, link4m); }
    catch { throw new Error('LINK4M_INVALID_API_REDIRECT'); }
    validateApiDestination(next);
    // Preserve required query parameters if canonical-host redirects omit them.
    next.searchParams.set('api', apiKey);
    next.searchParams.set('url', destination);
    link4m = next;
    if (attempt === 2) throw new Error('LINK4M_REDIRECT_LOOP');
  }
  if (!response) throw new Error('LINK4M_NETWORK_ERROR');
  if (response.status === 401 || response.status === 403) throw new Error('LINK4M_AUTH_FAILED');
  if (response.status === 429) throw new Error('LINK4M_RATE_LIMITED');
  if (response.status >= 500) throw new Error('LINK4M_UPSTREAM_UNAVAILABLE');
  if (!response.ok) throw new Error('LINK4M_API_FAILED');
  const raw = await limitedProviderText(response);
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error('LINK4M_INVALID_RESPONSE'); }
  if (String(result?.status || '').toLowerCase() !== 'success') {
    // Avoid exposing upstream error messages containing account information.
    throw new Error('LINK4M_API_REJECTED');
  }
  const shortUrl = result.shortenedUrl || result.shortened_url ||
    result.shortUrl || result.short_url;
  if (typeof shortUrl !== 'string') throw new Error('LINK4M_INVALID_SHORT_URL');
  let target;
  try { target = new URL(shortUrl); }
  catch { throw new Error('LINK4M_INVALID_SHORT_URL'); }
  const host = target.hostname.toLowerCase();
  const allowed = String(env.LINK4M_ALLOWED_SHORT_HOSTS || 'link4m.co,link4m.com,www.link4m.co,www.link4m.com')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (target.protocol !== 'https:' || !allowed.includes(host) || target.username || target.password)
    throw new Error('LINK4M_UNTRUSTED_SHORT_URL');
  return target.toString();
}
async function handleLinkStart(request, env) {
  if (!env.LINK4M_API_TOKEN) return apiError('LINK4M_NOT_CONFIGURED', 503);
  await parseJson(request); // only accepts small JSON object, usually {}
  const now = Date.now();
  const token = newHexToken();
  const sessionHash = await sha256(token);
  await env.DB.prepare(`INSERT INTO ios_link_sessions
    (session_hash, created_at, expires_at, stage) VALUES (?, ?, ?, 'started')`)
    .bind(sessionHash, now, now + LINK_SESSION_MS).run();
  const callback = new URL('/senttwgetkey', request.url);
  callback.searchParams.set('session', token);
  try {
    const shortUrl = await shortenLink(env, callback.toString());
    return apiJson({ ok: true, shortUrl });
  } catch (e) {
    try {
      await env.DB.prepare("DELETE FROM ios_link_sessions WHERE session_hash = ? AND stage = 'started'")
        .bind(sessionHash).run();
    } catch { /* Do not hide the original Link4M error on cleanup failure. */ }
    throw e;
  }
}
async function handleLinkCallback(request, env, stage) {
  const url = new URL(request.url);
  let token;
  try { token = linkSession(url.searchParams.get('session')); }
  catch { return linkError(request, 'invalid_session'); }
  const hash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT stage, expires_at, stage2_hash
    FROM ios_link_sessions WHERE session_hash = ?`).bind(hash).first();
  if (!row || now >= Number(row.expires_at)) return linkError(request, 'session_expired');
  if (stage === 1) {
    if (row.stage !== 'started') return linkError(request, 'step1_unavailable');
    const proof = newHexToken();
    const proofHash = await sha256(proof);
    const callback2 = new URL('/senttwnhankey', request.url);
    callback2.searchParams.set('session', token);
    callback2.searchParams.set('proof', proof);
    let shortUrl;
    try { shortUrl = await shortenLink(env, callback2.toString()); }
    catch { return linkError(request, 'step2_creation_failed'); }
    const changed = await env.DB.prepare(`UPDATE ios_link_sessions
      SET stage = 'step1_seen', stage2_hash = ?
      WHERE session_hash = ? AND stage = 'started' AND expires_at > ?
      RETURNING session_hash`).bind(proofHash, hash, Date.now()).first();
    if (!changed) return linkError(request, 'step1_unavailable');
    return redirectNoStore(shortUrl);
  }
  const proof = String(url.searchParams.get('proof') || '').trim().toLowerCase();
  if (!STEP_PROOF_RE.test(proof) || row.stage !== 'step1_seen')
    return linkError(request, 'step2_unavailable');
  const proofHash = await sha256(proof);
  if (proofHash !== row.stage2_hash) return linkError(request, 'step2_invalid');
  const transitioned = await env.DB.prepare(`UPDATE ios_link_sessions
    SET stage = 'ready', stage2_hash = NULL
    WHERE session_hash = ? AND stage = 'step1_seen' AND stage2_hash = ? AND expires_at > ?
    RETURNING session_hash`).bind(hash, proofHash, Date.now()).first();
  if (!transitioned) return linkError(request, 'step2_unavailable');
  const home = new URL('/', request.url);
  home.searchParams.set('session', token);
  return redirectNoStore(home.toString());
}
async function handleLinkComplete(request, env) {
  const input = await parseJson(request);
  const token = linkSession(input.sessionToken);
  const hash = await sha256(token);
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT stage, license_key, expires_at
    FROM ios_link_sessions WHERE session_hash = ?`).bind(hash).first();
  if (!existing || now >= Number(existing.expires_at)) return apiError('LINK_SESSION_EXPIRED', 403);
  if (existing.stage === 'complete' && existing.license_key) {
    return apiJson({ ok: true, reused: true, data: { key: existing.license_key,
      planHours: LICENSE_HOURS, expiresAt: null, status: 'unactivated' } });
  }
  if (existing.stage !== 'ready') return apiError('LINK4M_STEPS_REQUIRED', 403);
  // D1 batch executes as one transaction. Only the caller that atomically
  // changes ready -> complete inserts the license; others reuse the winner.
  const key = newKey();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE ios_link_sessions SET stage = 'complete', license_key = ?, completed_at = ?
      WHERE session_hash = ? AND stage = 'ready' AND expires_at > ?
      RETURNING license_key`).bind(key, now, hash, now),
    env.DB.prepare(`INSERT INTO ios_keys
      (license_key, voucher_hash, voucher_deadline, duration_hours, status, created_at)
      SELECT ?, NULL, 0, 24, 'active', ? FROM ios_link_sessions
      WHERE session_hash = ? AND stage = 'complete' AND license_key = ?`)
      .bind(key, now, hash, key)
  ]);
  if ((results[0]?.results || []).length) {
    return apiJson({ ok: true, reused: false, data: { key, planHours: LICENSE_HOURS,
      expiresAt: null, status: 'unactivated' } }, 201);
  }
  const current = await env.DB.prepare('SELECT stage, license_key FROM ios_link_sessions WHERE session_hash = ?')
    .bind(hash).first();
  if (current?.stage === 'complete' && current.license_key)
    return apiJson({ ok: true, reused: true, data: { key: current.license_key,
      planHours: LICENSE_HOURS, expiresAt: null, status: 'unactivated' } });
  return apiError('LINK_SESSION_UNAVAILABLE', 409);
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === '/senttwgetkey' || pathname === '/senttwnhankey') {
    if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
    if (!env.DB) return apiError('D1_NOT_CONFIGURED', 503);
    const denied = await enforceRateLimit(request, env);
    if (denied) return denied;
    return handleLinkCallback(request, env, pathname === '/senttwgetkey' ? 1 : 2);
  }
  if (pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 405, headers: baseHeaders });
    if (request.method !== 'POST' && pathname !== '/api/ios/health') return apiError('METHOD_NOT_ALLOWED', 405);
    if (!env.DB) return apiError('D1_NOT_CONFIGURED', 503);
    if (pathname === '/api/ios/health' && request.method === 'GET') return apiJson({ ok: true, service: 'Sent Tweaks iOS' });
    const isAdmin = pathname.startsWith('/api/ios/admin/');
    const denied = await enforceRateLimit(request, env, isAdmin);
    if (denied) return denied;
    if (pathname === '/api/ios/admin/create-key') return handleAdminCreate(request, env);
    if (pathname === '/api/ios/admin/revoke-key') return handleAdminRevoke(request, env);
    if (pathname === '/api/ios/redeem') return handleRedeem(request, env);
    if (pathname === '/api/ios/link4m/start') return handleLinkStart(request, env);
    if (pathname === '/api/ios/link4m/complete') return handleLinkComplete(request, env);
    if (pathname === '/api/ios/status') return handleStatus(request, env);
    if (pathname === '/api/ios/claim') return handleAuth(request, env, 'claim');
    if (pathname === '/api/ios/verify') return handleAuth(request, env, 'verify');
    return apiError('NOT_FOUND', 404);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return apiError('METHOD_NOT_ALLOWED', 405);
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (err) {
      const code = String(err?.message || 'INTERNAL_ERROR');
      const known = new Set(['INVALID_KEY_FORMAT','INVALID_DEVICE_ID','INVALID_NONCE','INVALID_LINK_SESSION','JSON_REQUIRED','INVALID_JSON','BODY_TOO_LARGE']);
      if (known.has(code)) return apiError(code, code === 'BODY_TOO_LARGE' ? 413 : 400);
      if (code.endsWith('_NOT_CONFIGURED')) return apiError('SERVICE_NOT_CONFIGURED', 503);
      if (code.startsWith('LINK4M_')) return apiError(code, code === 'LINK4M_TIMEOUT' ? 504 : code === 'LINK4M_RATE_LIMITED' ? 429 : 502);
      console.error('iOS auth error:', err);
      return apiError('INTERNAL_ERROR', 500);
    }
  }
};
