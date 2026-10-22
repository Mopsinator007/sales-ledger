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

const dmy = iso => iso.split('-').reverse().join('.');      // 2026-10-22 -> 22.10.2026
const ymOf = k => { const [, m, y] = k.split('.'); return `${y}-${m}`; }; // 22.10.2026 -> 2026-10

// Milestones, records, traffic spikes and the daily recap. Each fires once per day/month (tracked in flags).
async function milestones(c, L, silent) {
  const H = L.hist, F = L.flags, now = Date.now();
  const iso = fmtDate(c, now), today = dmy(iso), month = iso.slice(0, 7);
  const t = H[today] || { o: 0, s: 0, e: 0, v: 0 };
  const send = async (title, msg) => { if (!silent) await push(c, title, msg); };
  const gold = x => `<font color="#d4a017">${x}</font>`;

  const months = {}, orders = {};
  for (const [k, v] of Object.entries(H)) { const m = ymOf(k); months[m] = (months[m] || 0) + v.e; orders[m] = (orders[m] || 0) + v.o; }
  const mtd = months[month] || 0;
  const prevBestMonth = Math.max(0, ...Object.entries(months).filter(([m]) => m !== month).map(([, e]) => e));
  const prevBestDay = Math.max(0, ...Object.entries(H).filter(([k]) => k !== today).map(([, v]) => v.e));
  const goal = +c.GOAL || 1000;
  const dom = +iso.slice(8), dim = new Date(+iso.slice(0, 4), +iso.slice(5, 7), 0).getDate();

  if (mtd >= goal && F.goal !== month) {
    F.goal = month;
    await send('🎯 Monthly goal reached!', `<b>You hit ${gold(usd(goal))} commission this month</b>\nMonth so far: ${usd(mtd)} from ${orders[month]} sales`);
  }
  if (prevBestDay > 0 && t.e > prevBestDay && F.bestDay !== today) {
    F.bestDay = today;
    await send(`🏆 New best day: ${usd(t.e)}`, `<b>New record!</b> Your previous best day was ${gold(usd(prevBestDay))}.\n${t.o} sale${t.o > 1 ? 's' : ''} so far today`);
  }
  if (prevBestMonth > 0 && mtd > prevBestMonth && F.bestMonth !== month) {
    F.bestMonth = month;
    await send(`🏆 New best month: ${usd(mtd)}`, `<b>Record month!</b> You passed your previous best of ${gold(usd(prevBestMonth))}.\n${dim - dom} day${dim - dom === 1 ? '' : 's'} still to go this month`);
  }
  // traffic spike: at least 10 visits and 3x the average of the previous 14 days
  let sum = 0;
  for (let i = 1; i <= 14; i++) sum += (H[dmy(fmtDate(c, now - i * 864e5))] || {}).v || 0;
  const avg = sum / 14;
  if (t.v >= 10 && t.v >= 3 * avg && F.spike !== today) {
    F.spike = today;
    await send(`📈 Traffic spike: ${t.v} visits`, `<b>${t.v} visits today</b>, usually about ${avg.toFixed(1)} a day.\nSales so far today: ${t.o}`);
  }
  // daily recap
  const hour = +new Intl.DateTimeFormat('en-GB', { timeZone: c.TZ || 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(now);
  if (hour >= (c.RECAP_HOUR !== undefined ? +c.RECAP_HOUR : 20) && F.recap !== today) {
    F.recap = today;
    await send(`🌙 Daily recap: ${usd(t.e)}`,
      `<b>Today</b>  ${gold(usd(t.e))} commission from ${t.o} sale${t.o === 1 ? '' : 's'}\n` +
      `<b>Visits</b>  ${t.v}\n` +
      `<b>This month</b>  ${usd(mtd)} of ${usd(goal)} (${Math.round(mtd / goal * 100)}%)${mtd >= goal ? ' 🎯' : ''}`);
  }
}

async function check(env) {
  const c = await getConfig(env);
  const raw = await env.STATE.get('ledger');
  const fresh = !raw; // first run: load the whole year silently, no alerts
  const L = raw ? JSON.parse(raw) : { hist: {}, flags: {} };
  let data;
  try { data = await fetchStats(c, fresh ? 364 : 3); } catch (e) { console.log('fetch failed', String(e)); return; }

  for (const d of Object.values(data)) {
    const cur = { o: +d.orders, s: +d.sum_price_clean, e: +d.sum_earnings_clean, v: +d.visits };
    const prev = L.hist[d.date] || { o: 0, s: 0, e: 0, v: 0 };
    L.hist[d.date] = cur;
    if (!fresh && cur.o > prev.o) {
      const n = cur.o - prev.o, per = (cur.e - prev.e) / n; // commission per new sale
      const count = n > 10 ? 1 : n; // never spam more than 10 messages at once
      const amount = n > 10 ? cur.e - prev.e : per;
      for (let i = 0; i < count; i++) {
        let msg = `<b>You earned <font color="#d4a017">${usd(amount)}</font> commission</b>\n` +
                  `Today: <b>${usd(cur.e)}</b> from ${cur.o} sale${cur.o > 1 ? 's' : ''}`;
        if (n > 1) msg += `\n<i>${n} sales came in together${n > 10 ? ', combined commission' : ', commission split evenly'}</i>`;
        await push(c, `💰 New sale: +${usd(amount)}`, msg);
      }
    }
  }
  const cut = fmtDate(c, Date.now() - 400 * 864e5);
  for (const k of Object.keys(L.hist)) if (dmy(k.split('.').reverse().join('-')) && k.split('.').reverse().join('-') < cut) delete L.hist[k];

  await milestones(c, L, fresh);
  const out = JSON.stringify(L);
  if (out !== raw) await env.STATE.put('ledger', out); // only write when something changed (KV free tier: 1000 writes/day)
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
