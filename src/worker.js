// One Worker: serves the dashboard (public/), the stats API, and the cron that sends Pushover alerts.
// All settings are read from the KV key "config" (JSON), so nothing is set in Worker variables.
const usd = n => '$' + n.toFixed(2);
const fmtDate = (c, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: c.TZ || 'Europe/Berlin' }).format(new Date(ms)); // YYYY-MM-DD

async function getConfig(env) {
  return (await env.STATE.get('config', 'json')) || {};
}

// Builds fresh date ranges on every run (always ending today), fetched in 60-day pieces.
async function fetchStats(c, daysBack, chunk = 60) {
  for (const k of ['AFF_BASE', 'AFF_ID', 'AFF_HASH']) if (!c[k]) throw new Error(`"${k}" is missing in the KV config`);
  const now = Date.now(), parts = [];
  for (let end = 0; end <= daysBack; end += chunk) {
    const to = now - end * 864e5, from = now - Math.min(end + chunk - 1, daysBack) * 864e5;
    const url = `${c.AFF_BASE}/affiliate/api/check_stats_by_date/${fmtDate(c, from)}/${fmtDate(c, to)}/${c.AFF_ID}?hash=${c.AFF_HASH}`;
    parts.push(fetch(url).then(async r => {
      const t = await r.text();
      try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch (e) {}
      throw new Error(`Affiliatly replied ${r.status}: ${t.slice(0, 120)}`);
    }));
  }
  const res = await Promise.allSettled(parts); // a failing chunk is skipped
  const ok = res.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!ok.length) throw res[0].reason;
  return Object.assign({}, ...ok);
}

async function push(c, title, message) {
  const body = { token: c.PUSHOVER_TOKEN, user: c.PUSHOVER_USER, title, message, html: '1', sound: 'cashregister' };
  if (c.DASH_URL) { body.url = c.DASH_URL; body.url_title = 'Open dashboard'; }
  await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: new URLSearchParams(body) });
}

async function check(env) {
  const c = await getConfig(env);
  let data;
  try { data = await fetchStats(c, 3); } catch (e) { console.log('fetch failed', String(e)); return; }
  const saved = await env.STATE.get('state', 'json');
  const next = {};
  for (const d of Object.values(data)) {
    const cur = { o: +d.orders, s: +d.sum_price_clean, e: +d.sum_earnings_clean };
    next[d.date] = cur;
    if (!saved) continue; // first run: remember current numbers, no alerts
    const prev = saved[d.date] || { o: 0, s: 0, e: 0 };
    if (cur.o > prev.o) {
      const n = cur.o - prev.o, per = (cur.e - prev.e) / n; // commission per new sale
      const count = n > 10 ? 1 : n; // never spam more than 10 messages at once
      const amount = count === 1 && n > 10 ? cur.e - prev.e : per;
      for (let i = 0; i < count; i++) {
        let msg = `<b>You earned <font color="#d4a017">${usd(amount)}</font> commission</b>\n` +
                  `Today: <b>${usd(cur.e)}</b> from ${cur.o} sale${cur.o > 1 ? 's' : ''}`;
        if (n > 1) msg += `\n<i>${n} sales came in together${n > 10 ? ', combined commission' : ', commission split evenly'}</i>`;
        await push(c, `💰 New sale: +${usd(amount)}`, msg);
      }
    }
  }
  await env.STATE.put('state', JSON.stringify(next));
}

const json = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  scheduled(_e, env, ctx) { ctx.waitUntil(check(env)); },

  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/api/stats') {
      const c = await getConfig(env);
      if (c.DASH_KEY && req.headers.get('x-key') !== c.DASH_KEY) return json('{"error":"unauthorized"}', 401);
      try { return json(JSON.stringify(await fetchStats(c, 364))); }
      catch (e) { return json(JSON.stringify({ error: String(e.message || e) }), 502); }
    }
    if (u.pathname === '/test') {
      const c = await getConfig(env);
      if (!c.DASH_KEY || u.searchParams.get('key') !== c.DASH_KEY) return new Response('unauthorized', { status: 401 });
      await push(c, '💰 Sales Ledger', '<b>Pushover is <font color="#d4a017">working</font></b>\nYou will get one message per sale.');
      return new Response('Test message sent');
    }
    return env.ASSETS.fetch(req);
  },
};
