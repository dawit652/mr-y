import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });
const id = 2757372;

const options = {
  hostname: 'api.hulusport.et',
  path: `/sport-data/matches/${id}/`,
  method: 'GET',
  agent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://hulusport.et',
    'Referer': 'https://hulusport.et/',
  },
};

https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    fs.writeFileSync(`C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\match-${id}.json`, data);
    const m = JSON.parse(data);

    console.log('Top-level keys:', Object.keys(m).join(', '));
    console.log('hom:', m.hom, '| awy:', m.awy);
    console.log('item_count (teaser):', m.item_count);
    console.log('win_odds count:', Array.isArray(m.win_odds) ? m.win_odds.length : 'n/a');
    console.log('');

    // Look for the big odds structure - try common field names
    for (const field of ['markets','market_groups','bet_groups','odds','all_odds','market_list','betting_markets']) {
      if (m[field] !== undefined) {
        const v = m[field];
        console.log(`FOUND field "${field}":`, Array.isArray(v) ? `array(${v.length})` : typeof v);
        if (Array.isArray(v) && v.length > 0) {
          console.log('  First entry keys:', Object.keys(v[0]).join(', '));
          console.log('  First entry sample:', JSON.stringify(v[0]).substring(0, 300));
        } else if (typeof v === 'object') {
          console.log('  Object keys:', Object.keys(v).slice(0, 10).join(', '));
        }
      }
    }

    // Whatever the largest array field is, that's likely the odds
    console.log('');
    console.log('=== All top-level fields, sorted by serialized size ===');
    const sizes = Object.entries(m)
      .map(([k, v]) => [k, JSON.stringify(v).length])
      .sort((a, b) => b[1] - a[1]);
    for (const [k, s] of sizes) {
      console.log(`  ${String(s).padStart(10)}B  ${k}`);
    }
  });
}).on('error', (e) => console.error('Error:', e.message)).end();