import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

const checkIds = [2281709, 2757372, 2281725, 2947853, 2938500];
const livePaths = [
  '/sport-data/live/',
  '/sport-data/live-matches/',
  '/live-data/',
  '/live/',
  '/sport-data/matches/live/',
];

function get(path) {
  return new Promise((resolve) => {
    https.request({
      hostname: 'api.hulusport.et', path, method: 'GET', agent,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://hulusport.et' },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', e => resolve({ status: 0, error: e.message, body: '' })).end();
  });
}

console.log('=== Status of 5 in-play matches ===');
for (const id of checkIds) {
  const r = await get(`/sport-data/matches/${id}/`);
  if (r.status === 200) {
    try {
      const m = JSON.parse(r.body);
      const items = m.items || [];
      const names = {};
      for (const it of items) { const n = it.bet_group?.name || '?'; names[n] = (names[n] || 0) + 1; }
      console.log(`\n${id}  ${m.hom} vs ${m.awy}`);
      console.log(`  expired=${m.expired}  active=${m.is_active}  item_count=${m.item_count}  items=${items.length}`);
      if (items.length > 0) {
        Object.entries(names).sort((a,b)=>b[1]-a[1]).slice(0,6).forEach(([n,c])=>console.log(`    ${String(c).padStart(3)}x  ${n}`));
      }
    } catch (e) { console.log(`${id}  parse error: ${e.message}`); }
  } else {
    console.log(`${id}  status=${r.status}  bytes=${r.body.length}`);
  }
}

console.log('\n=== Probing live endpoint candidates ===');
for (const p of livePaths) {
  const r = await get(p);
  let hint = '';
  if (r.status === 200) {
    try {
      const j = JSON.parse(r.body);
      if (Array.isArray(j)) hint = `array(${j.length})`;
      else if (j && typeof j === 'object') hint = `keys: ${Object.keys(j).slice(0,5).join(',')}`;
    } catch { hint = `html?(${r.body.length}B)`; }
  } else {
    hint = r.error || '';
  }
  console.log(`  ${String(r.status).padEnd(4)} ${String(r.body.length).padStart(8)}B  ${hint.padEnd(30)} ${p}`);
}