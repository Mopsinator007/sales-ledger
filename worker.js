/**
 * Sales Ledger: multi-account worker
 *
 *  - Accounts, sessions and notification state live in one KV namespace (binding: LEDGER)
 *      acct:<username>   account record (password hash, Affiliatly + Pushover details)
 *      sess:<sha256>     login session (30 days, hashed so a KV leak can't be replayed)
 *      state:<username>  last seen totals, used to detect new sales for Pushover
 *      rl:<ip>:<user>    failed-login counter
 *  - /login      sign-in page
 *  - /           the ledger (needs a session)
 *  - /admin      create / edit accounts (needs an admin session OR the DASH_KEY secret)
 *  - cron        every couple of minutes: check each account, push to that person's Pushover
 *
 * Env vars / secrets:
 *   DASH_KEY       secret   master key for /admin (use it once to create the first admin)
 *   AFF_URL        var      Affiliatly report URL template with {base} {id} {hash} placeholders
 *   AFF_BASE       var      default Affiliatly program base (accounts can override)
 *   PUSHOVER_TOKEN var      optional default Pushover app token (accounts can override)
 *   TZ, DASH_URL   var      default timezone / link used in push notifications
 */
import INDEX_HTML from './index.html';
import LOGIN_HTML from './login.html';
import ADMIN_HTML from './admin.html';

const COOKIE = 'ledger_session';
const SESSION_TTL = 60 * 60 * 24 * 30;            // seconds
const REFRESH_AFTER = 7 * 24 * 60 * 60 * 1000;    // ms: re-extend sessions older than this
const PBKDF2_ITER = 100000;                       // Workers caps PBKDF2 at 100k
const enc = new TextEncoder();

/* ------------------------------------------------------------------ helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SEC = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC, ...extra } });
const page = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...SEC } });
const redirect = to => new Response(null, { status: 302, headers: { location: to, ...SEC } });
const fail = e => {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: 'Server error' }, 500);
};

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const usd = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function safeEq(a, b) {                           // constant-time string compare
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  for (let i = 0, n = Math.max(a.length, b.length); i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}

/* ---------------------------------------------------------------- passwords */

async function pbkdf2(password, salt, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function makePw(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await pbkdf2(password, salt)), iter: PBKDF2_ITER };
}
const checkPw = async (password, pw) => safeEq(b64(await pbkdf2(password, unb64(pw.salt), pw.iter)), pw.hash);
const DUMMY_SALT = new Uint8Array(16);            // burn the same time when the username doesn't exist

/* ----------------------------------------------------------------- accounts */

const validUser = u => /^[a-z0-9][a-z0-9_-]{1,23}$/.test(u);
const getAcct = (env, u) => env.LEDGER.get('acct:' + u, 'json');
const mask = s => (s ? '••••' + String(s).slice(-4) : '');

const publicAcct = a => ({
  username: a.username,
  name: a.name,
  admin: !!a.admin,
  goal: a.goal || 1000,
  tz: a.tz || '',
  notify: a.notify !== false,
  aff_base: a.aff_base || '',
  aff_id: a.aff_id || '',
  aff_hash: mask(a.aff_hash),
  has_aff_hash: !!a.aff_hash,
  pushover_user: mask(a.pushover_user),
  has_pushover_user: !!a.pushover_user,
  pushover_token: mask(a.pushover_token),
  has_pushover_token: !!a.pushover_token,
  created: a.created,
  updated: a.updated,
});

async function listAccounts(env) {
  const { keys } = await env.LEDGER.list({ prefix: 'acct:' });
  const all = (await Promise.all(keys.map(k => env.LEDGER.get(k.name, 'json')))).filter(Boolean);
  return all.sort((a, b) => (a.created || 0) - (b.created || 0));
}

async function putAccount(req, env, u) {
  if (!validUser(u)) throw new HttpError(400, 'Username must be 2–24 characters: a–z, 0–9, _ or -');
  let b;
  try { b = await req.json(); } catch { throw new HttpError(400, 'Bad request'); }
  const old = await getAcct(env, u);
  const now = Date.now();
  const a = old ? { ...old } : { username: u, created: now, pwv: 1 };

  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  if (b.name !== undefined || !old) a.name = str(b.name, 40) || u;

  if (b.password) {
    const pw = String(b.password);
    if (pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (pw.length > 200) throw new HttpError(400, 'Password is too long');
    a.pw = await makePw(pw);
    a.pwv = (a.pwv || 0) + 1;                     // invalidates this person's existing sessions
  } else if (!old) {
    throw new HttpError(400, 'Set a password for the new account');
  }

  if (b.admin !== undefined) a.admin = !!b.admin;
  if (b.notify !== undefined) a.notify = !!b.notify;

  if (b.goal !== undefined && b.goal !== '') {
    const g = Number(b.goal);
    if (!(g > 0 && g < 1e9)) throw new HttpError(400, 'Monthly goal must be a positive number');
    a.goal = g;
  }
  if (b.tz !== undefined) {
    const tz = str(b.tz, 60);
    if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new HttpError(400, 'Unknown timezone, e.g. Europe/Berlin'); } }
    a.tz = tz;
  }
  if (b.aff_base !== undefined) {
    const base = str(b.aff_base, 200).replace(/\/+$/, '');
    if (base && !/^https:\/\/[^\s/]+/.test(base)) throw new HttpError(400, 'Affiliatly base must start with https://');
    a.aff_base = base;
  }
  if (b.aff_id !== undefined) a.aff_id = str(b.aff_id, 40);
  // secrets: blank means "keep what's stored"
  for (const k of ['aff_hash', 'pushover_user', 'pushover_token']) {
    const v = str(b[k], 200);
    if (v && !v.startsWith('••••')) a[k] = v;
  }

  a.updated = now;
  await env.LEDGER.put('acct:' + u, JSON.stringify(a));
  return json({ ok: true, account: publicAcct(a), created: !old });
}

async function deleteAccount(env, u) {
  if (!validUser(u) || !(await getAcct(env, u))) throw new HttpError(404, 'No such account');
  await Promise.all([env.LEDGER.delete('acct:' + u), env.LEDGER.delete('state:' + u)]);
  return json({ ok: true });                      // sessions die with the account (checked on every request)
}

/* ----------------------------------------------------------------- sessions */

const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
function readCookie(req, name) {
  const hit = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

async function createSession(env, a) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.LEDGER.put('sess:' + (await sha256hex(token)), JSON.stringify({ u: a.username, v: a.pwv || 0, iat: Date.now() }), { expirationTtl: SESSION_TTL });
  return token;
}

async function getSession(req, env) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const key = 'sess:' + (await sha256hex(token));
  const rec = await env.LEDGER.get(key, 'json');
  if (!rec) return null;
  const acct = await getAcct(env, rec.u);
  if (!acct || (acct.pwv || 0) !== rec.v) return null;
  return { acct, token, key, rec };
}

// failed-attempt counters (only failures are written, so normal logins cost no KV writes)
const strikes = async (env, id) => Number(await env.LEDGER.get('rl:' + id)) || 0;
const strike = async (env, id) => env.LEDGER.put('rl:' + id, String((await strikes(env, id)) + 1), { expirationTtl: 900 });
const clientIp = req => req.headers.get('cf-connecting-ip') || 'local';

async function login(req, env) {
  let b;
  try { b = await req.json(); } catch { throw new HttpError(400, 'Bad request'); }
  const u = String(b.username || '').trim().toLowerCase();
  const p = String(b.password || '');
  if (!u || !p || p.length > 200) throw new HttpError(400, 'Enter your username and password');

  const rlId = `${clientIp(req)}:${u.slice(0, 24)}`;
  if ((await strikes(env, rlId)) >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

  const a = validUser(u) ? await getAcct(env, u) : null;
  const ok = a ? await checkPw(p, a.pw) : (await pbkdf2(p, DUMMY_SALT), false);
  if (!ok) {
    await strike(env, rlId);
    throw new HttpError(401, 'Wrong username or password');
  }

  const token = await createSession(env, a);
  return json({ ok: true, name: a.name }, 200, { 'set-cookie': cookieHeader(token, SESSION_TTL) });
}

async function logout(req, env) {
  const token = readCookie(req, COOKIE);
  if (token) await env.LEDGER.delete('sess:' + (await sha256hex(token)));
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
}

async function me(req, env) {
  const s = await getSession(req, env);
  if (!s) return json({ error: 'Not signed in' }, 401);
  const a = s.acct;
  const extra = {};
  if (Date.now() - s.rec.iat > REFRESH_AFTER) {   // sliding expiry for people who use it daily
    await env.LEDGER.put(s.key, JSON.stringify({ ...s.rec, iat: Date.now() }), { expirationTtl: SESSION_TTL });
    extra['set-cookie'] = cookieHeader(s.token, SESSION_TTL);
  }
  const base = (a.aff_base || env.AFF_BASE || '').replace(/\/+$/, '');
  return json({ username: a.username, name: a.name, admin: !!a.admin, goal: a.goal || 1000, tz: a.tz || env.TZ || '', panel: base ? base + '/affiliate.panel' : '' }, 200, extra);
}

// tolerate a stray space/newline or wrapping quotes in the stored secret (easy to paste in by accident)
const cleanSecret = s => String(s ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

async function adminAuth(req, env) {
  const key = (req.headers.get('x-admin-key') || '').trim();
  const secret = cleanSecret(env.DASH_KEY);
  if (key && secret && safeEq(key, secret)) return true;               // no lockout on the admin key
  const s = await getSession(req, env);
  return !!(s && s.acct.admin);
}

/* --------------------------------------------------------------- Affiliatly */
/*
 * The one integration point. Each account has its own aff_id + aff_hash (and optionally
 * aff_base); the URL comes from the AFF_URL template. The response must contain one row per
 * day: { date: 'dd.mm.yyyy', orders, visits, sum_price_clean, sum_earnings_clean }.
 *
 * Rows are normalized below, so the site and the push notifications always get real
 * numbers under those names, even if Affiliatly sends strings ("$12,50") or other key names.
 */

function affUrl(a, env, from = '', to = '') {
  if (!env.AFF_URL) throw new HttpError(500, 'AFF_URL is not set on the worker (see SETUP.md)');
  if (!a.aff_id || !a.aff_hash) throw new HttpError(409, 'Affiliatly is not linked to this account yet');
  const base = (a.aff_base || env.AFF_BASE || '').replace(/\/+$/, '');
  return env.AFF_URL
    .replaceAll('{base}', base)
    .replaceAll('{id}', encodeURIComponent(a.aff_id))
    .replaceAll('{hash}', encodeURIComponent(a.aff_hash))
    .replaceAll('{from}', from)
    .replaceAll('{to}', to);
}

function rowsOf(j, depth = 0) {
  const v = Array.isArray(j) ? j : j && typeof j === 'object' ? Object.values(j) : [];
  const rows = v.filter(r => r && typeof r === 'object' && typeof r.date === 'string');
  if (rows.length || depth > 1) return rows;
  for (const x of v) {
    if (x && typeof x === 'object') { const inner = rowsOf(x, depth + 1); if (inner.length) return inner; }
  }
  return [];
}

// Parse "12.50", "$1,234.50", "1.234,50 €", 12.5 → number
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

const pick = (r, names, re) => {
  for (const k of names) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  const hit = Object.keys(r).find(k => re.test(k));
  return hit ? r[hit] : 0;
};

function normRow(r) {
  return {
    ...r,
    date: r.date,
    orders: num(r.orders),
    visits: num(r.visits),
    sum_price_clean: num(pick(r, ['sum_price_clean', 'sum_price', 'sales', 'revenue'], /price|sale|revenue/i)),
    sum_earnings_clean: num(pick(r, ['sum_earnings_clean', 'sum_earnings', 'earnings', 'commission', 'sum_commission'], /earn|commis/i)),
  };
}

const ymd = (tz, d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

/** Fetches `days` days of history. With {from}/{to} in AFF_URL it asks in 30-day chunks (in case Affiliatly caps the range) and merges them. */
async function affiliatlyDays(a, env, debug = false, days = 365) {
  if (!env.AFF_URL || !env.AFF_URL.includes('{from}')) return fetchRange(a, env, '', '', debug);
  const tz = a.tz || env.TZ || 'UTC';
  const DAY = 864e5, CHUNK = 30, now = Date.now();
  const jobs = [];
  for (let off = 0; off < days; off += CHUNK) {
    jobs.push([ymd(tz, new Date(now - Math.min(off + CHUNK - 1, days - 1) * DAY)), ymd(tz, new Date(now - off * DAY))]);
  }
  const res = await Promise.allSettled(jobs.map(([f, t]) => fetchRange(a, env, f, t, debug)));
  if (res[0].status === 'rejected') throw res[0].reason;        // the newest chunk must work; older ones are best-effort
  const byDate = new Map();
  for (const r of res) if (r.status === 'fulfilled') for (const row of r.value) byDate.set(row.date, row);
  return [...byDate.values()];
}

async function fetchRange(a, env, from, to, debug = false) {
  const url = affUrl(a, env, from, to);
  let r;
  try { r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); }
  catch { throw new HttpError(502, 'Could not reach Affiliatly'); }
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `Affiliatly answered HTTP ${r.status}. Check the ID and hash.`);
  let j;
  try { j = JSON.parse(text); }
  catch { throw new HttpError(502, 'Affiliatly did not return JSON' + (debug ? `: ${JSON.stringify(text.slice(0, 160))}` : '. Check AFF_URL, the ID and the hash.')); }
  return rowsOf(j).map(normRow);
}

/* ----------------------------------------------------------------- Pushover */

async function pushover(a, env, { title, message, url }) {
  const token = a.pushover_token || env.PUSHOVER_TOKEN;
  if (!a.pushover_user || !token) throw new HttpError(409, 'Pushover is not set up for this account');
  const body = new URLSearchParams({ token, user: a.pushover_user, title, message });
  if (url) { body.set('url', url); body.set('url_title', 'Open ledger'); }
  let r;
  try { r = await fetch(env.PUSHOVER_URL || 'https://api.pushover.net/1/messages.json', { method: 'POST', body, signal: AbortSignal.timeout(10000) }); }
  catch { throw new HttpError(502, 'Could not reach Pushover'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 1) throw new HttpError(502, 'Pushover said: ' + ((j.errors || []).join(', ') || 'HTTP ' + r.status));
}

function ddmmyyyy(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}`;
}

/** Cron: compare each account's totals with what we saw last time; push when orders went up. */
async function checkAccount(env, u) {
  const a = await getAcct(env, u);
  if (!a || a.notify === false || !a.pushover_user || !a.aff_id || !a.aff_hash) return;

  const rows = await affiliatlyDays(a, env, false, 62);
  const cur = {};                                 // per-day snapshot, so a sliding window can't hide a new sale
  for (const r of rows) cur[r.date] = { o: +r.orders || 0, e: +r.sum_earnings_clean || 0 };
  const prev = await env.LEDGER.get('state:' + u, 'json');
  const save = () => env.LEDGER.put('state:' + u, JSON.stringify({ days: cur, ts: Date.now() }));

  if (!prev || !prev.days) return save();         // first run: remember, don't spam history
  let n = 0, gain = 0, changed = false;
  for (const d of Object.keys(cur)) {
    const p = prev.days[d] || { o: 0, e: 0 };
    if (cur[d].o > p.o) n += cur[d].o - p.o;
    if (cur[d].e > p.e) gain += cur[d].e - p.e;
    if (cur[d].o !== p.o || Math.abs(cur[d].e - p.e) > 0.004) changed = true;
  }
  if (n > 0) {
    const today = ddmmyyyy(a.tz || env.TZ || 'UTC');
    const sum = f => rows.filter(f).reduce((s, r) => s + (+r.sum_earnings_clean || 0), 0);
    await pushover(a, env, {
      title: n > 1 ? `💰 ${n} new sales` : '💰 New sale',
      message: `+${usd(gain)} commission\nToday ${usd(sum(r => r.date === today))} · Month ${usd(sum(r => r.date.slice(3) === today.slice(3)))}`,
      url: env.DASH_URL,
    });
    return save();                                // only after a successful push, so failures retry
  }
  if (changed) return save();                     // refunds / edits
}

/* ------------------------------------------------------------------- routes */

async function admin(req, env, path, m) {
  if (!(await adminAuth(req, env))) {
    const sent = req.headers.get('x-admin-key');
    throw new HttpError(401, !sent ? 'Admin access required'
      : !cleanSecret(env.DASH_KEY) ? 'This worker has no DASH_KEY secret. Add a secret named exactly DASH_KEY, then redeploy.'
      : 'That key didn’t match DASH_KEY.');
  }
  const parts = path.split('/').slice(3);         // ['accounts', 'emery', 'test-pushover']
  if (parts[0] === 'accounts') {
    if (parts.length === 1 && m === 'GET') {
      return json({
        accounts: (await listAccounts(env)).map(publicAcct),
        defaults: { aff_base: env.AFF_BASE || '', tz: env.TZ || '', has_aff_url: !!env.AFF_URL, has_pushover_token: !!env.PUSHOVER_TOKEN },
      });
    }
    const u = decodeURIComponent(parts[1] || '').toLowerCase();
    if (parts.length === 2 && m === 'PUT') return putAccount(req, env, u);
    if (parts.length === 2 && m === 'DELETE') return deleteAccount(env, u);
    if (parts.length === 3 && m === 'POST' && (parts[2] === 'test-pushover' || parts[2] === 'test-affiliatly')) {
      const a = validUser(u) && (await getAcct(env, u));
      if (!a) throw new HttpError(404, 'No such account');
      try {
        if (parts[2] === 'test-pushover') {
          await pushover(a, env, { title: 'Sales Ledger', message: `Hi ${a.name}, notifications are working ✅`, url: env.DASH_URL });
          return json({ ok: true });
        }
        const rows = await affiliatlyDays(a, env, true);
        return json({ ok: true, days: rows.length, sample: rows[0] || null });
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message });
        throw e;
      }
    }
  }
  throw new HttpError(404, 'Not found');
}

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  const m = req.method;

  if (m !== 'GET' && m !== 'HEAD') {              // same-origin only for anything that changes state
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'Bad origin');
  }

  if (path === '/' || path === '/index.html') return (await getSession(req, env)) ? page(INDEX_HTML) : redirect('/login');
  if (path === '/login') return (await getSession(req, env)) ? redirect('/') : page(LOGIN_HTML);
  if (path === '/admin') return page(ADMIN_HTML);

  if (path === '/api/login' && m === 'POST') return login(req, env);
  if (path === '/api/logout' && m === 'POST') return logout(req, env);
  if (path === '/api/me' && m === 'GET') return me(req, env);
  if (path === '/api/stats' && m === 'GET') {
    const s = await getSession(req, env);
    if (!s) throw new HttpError(401, 'Not signed in');
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 30, 1), 400);
    return json(await affiliatlyDays(s.acct, env, false, days));
  }
  if (path.startsWith('/api/admin/')) return admin(req, env, path, m);

  return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
}

export default {
  async fetch(req, env) {
    try { return await route(req, env); } catch (e) { return fail(e); }
  },

  async scheduled(event, env, ctx) {
    const { keys } = await env.LEDGER.list({ prefix: 'acct:' });
    ctx.waitUntil(Promise.allSettled(keys.map(k => checkAccount(env, k.name.slice(5)).catch(e => console.error(k.name, e.message)))));
  },
};
