const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_DAYS = 7;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function incrementKV(kv, key) {
  const current = parseInt((await kv.get(key)) ?? '0', 10);
  await kv.put(key, String(current + 1));
}

async function recordDownload(env) {
  await Promise.all([incrementKV(env.STATS, 'total'), incrementKV(env.STATS, `day:${isoDate(new Date())}`)]);
}

async function handleStats(env) {
  const days = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    days.push(isoDate(new Date(Date.now() - i * DAY_MS)));
  }

  const [total, ...counts] = await Promise.all([
    env.STATS.get('total'),
    ...days.map((date) => env.STATS.get(`day:${date}`)),
  ]);

  const daily = days.map((date, i) => ({ date, count: parseInt(counts[i] ?? '0', 10) }));

  return new Response(
    JSON.stringify({
      total: parseInt(total ?? '0', 10),
      today: daily[daily.length - 1].count,
      daily,
    }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/stats') {
      return handleStats(env);
    }

    if (url.pathname === '/download/Thawdrop.dmg' && request.method === 'GET') {
      const response = await env.ASSETS.fetch(request);
      if (response.ok) {
        // Don't let counting delay the actual download.
        ctx.waitUntil(recordDownload(env));
      }
      return response;
    }

    return env.ASSETS.fetch(request);
  },
};
