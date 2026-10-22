// One Worker: serves the dashboard (public/), the stats API, and the cron that sends Pushover alerts.
const usd = n => '$' + n.toFixed(2);
const fmtDate = (env, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: env.TZ || 'Europe/Berlin' }).format(new Date(ms)); // YYYY-MM-DD
const statsUrl = (env, daysBack) => {
  const now = Date.now();
  return `${env.AFF_BASE}/affiliate/api/check_stats_by_date/${fmtDate(env, now - daysBack * 864e5)}/${fmtDate(env, now)}/${env.AFF_ID}?hash=${env.AFF_HASH}`;
};

async function push(env, title, message) {
  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: new URLSearchParams({ token: env.PUSHOVER_TOKEN, user: env.PUSHOVER_USER, title, message, sound: 'cashregister' }),
  });
}

async function check(env) {
  let data;
  try { data = await (await fetch(statsUrl(env, 3))).json(); } catch (e) { console.log('fetch failed', e); return; }
  const saved = await env.STATE.get('state', 'json');
  const next = {};
  for (const d of Object.values(data)) {
    const cur = { o: +d.orders, s: +d.sum_price_clean, e: +d.sum_earnings_clean };
    next[d.date] = cur;
    if (!saved) continue; // first run: remember current numbers, no alerts
    const prev = saved[d.date] || { o: 0, s: 0, e: 0 };
    if (cur.o > prev.o) {
      const n = cur.o - prev.o;
      await push(env, `New sale${n > 1 ? 's' : ''}: +${usd(cur.e - prev.e)}`,
        `${n} new order${n > 1 ? 's' : ''} worth ${usd(cur.s - prev.s)}.\nEarnings on ${d.date}: ${usd(cur.e)} (${cur.o} orders)`);
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
      if (env.DASH_KEY && req.headers.get('x-key') !== env.DASH_KEY) return json('{"error":"unauthorized"}', 401);
      const r = await fetch(statsUrl(env, 364));
      return r.ok ? json(await r.text()) : json('{"error":"upstream"}', 502);
    }
    if (u.pathname === '/test') {
      if (!env.DASH_KEY || u.searchParams.get('key') !== env.DASH_KEY) return new Response('unauthorized', { status: 401 });
      await push(env, 'Sales Ledger', 'Pushover is working.');
      return new Response('Test message sent');
    }
    return env.ASSETS.fetch(req);
  },
};
