import https from 'https';
const id = process.argv[2] || 2757372;
const DURATION_S = 360;
const SAMPLE_S = 30;

const agent = new https.Agent({ rejectUnauthorized: false });

function grab() {
  return new Promise(r => {
    https.request({
      hostname: 'api.hulusport.et',
      path: `/sport-data/matches/${id}/`,
      agent,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://hulusport.et' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } });
    }).on('error', () => r(null)).end();
  });
}

function fingerprint(m) {
  const parts = [];
  for (const market of m.items || []) {
    for (const odd of market.odds || []) {
      parts.push(`${market.id}:${odd.bet_type?.id}:${odd.odd}:${odd.is_available ? 1 : 0}`);
    }
  }
  return parts.sort().join('|');
}

console.log(`TTL discovery — sampling match ${id} every ${SAMPLE_S}s for ${DURATION_S}s`);
console.log('Watching for the first payload change...\n');

let lastFp = null;
let lastChangeAt = 0;
const t0 = Date.now();
let cycles = 0;

while ((Date.now() - t0) / 1000 < DURATION_S) {
  cycles++;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const m = await grab();
  if (!m) { console.log(`[t=${elapsed}s] fetch failed`); }
  else {
    const fp = fingerprint(m);
    const oddsCount = (m.items || []).reduce((s, mk) => s + (mk.odds?.length || 0), 0);
    if (lastFp === null) {
      console.log(`[t=${elapsed}s] baseline: ${m.items?.length} markets, ${oddsCount} odds`);
    } else if (fp === lastFp) {
      console.log(`[t=${elapsed}s] unchanged (${oddsCount} odds, ${(Date.now()-lastChangeAt)/1000|0}s since last change)`);
    } else {
      const sinceLast = ((Date.now() - lastChangeAt) / 1000).toFixed(0);
      console.log(`[t=${elapsed}s] *** CHANGED ***  (${sinceLast}s since previous change)`);
      lastChangeAt = Date.now();
    }
    lastFp = fp;
  }
  await new Promise(r => setTimeout(r, SAMPLE_S * 1000));
}

const total = (Date.now() - t0) / 1000;
console.log(`\n=== Result ===`);
console.log(`Duration: ${total.toFixed(0)}s, samples: ${cycles}`);
if (lastChangeAt === 0) {
  console.log(`=> NO CHANGES in ${total.toFixed(0)}s. TTL is longer than ${total.toFixed(0)}s.`);
} else {
  const avgGap = (total - (lastChangeAt - t0) / 1000) > 0
    ? ((lastChangeAt - t0) / 1000 / Math.max(1, cycles - 1)).toFixed(0)
    : 'n/a';
  console.log(`=> First change at t=${((lastChangeAt - t0)/1000).toFixed(0)}s.`);
  console.log(`   Approx cache TTL: <= ${((lastChangeAt - t0)/1000).toFixed(0)}s (likely 60-120s).`);
}