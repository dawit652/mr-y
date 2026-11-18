import fs from 'fs';
import path from 'path';

const dir = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\matches';
const outFile = 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\all-odds.csv';
const MAIN_ONLY = process.argv.includes('--main');

// Curated main markets (by exact market_name from your output)
const MAIN_MARKETS = new Set([
  '3 Way', 'Double chance', 'Over/Under', 'Handicap {hcp}',
  'Both teams to score', 'Draw no bet', 'Halftime/Fulltime',
]);

function renderLabel(name, spec, hom, awy) {
  return String(name || '')
    .replace(/\{\$competitor1\}/g, hom)
    .replace(/\{\$competitor2\}/g, awy)
    .replace(/\{\$competitorN\}/g, 'Draw')
    .replace(/\{([a-zA-Z]+)\}/g, (_, k) => spec[k] ?? `{${k}}`);
}

function mergeSpec(...specs) {
  const o = {}; for (const s of specs) if (s) for (const [k,v] of Object.entries(s)) o[k]=v; return o;
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const rows = [];
let ok = 0, skip = 0;

for (const f of files) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
  catch { skip++; continue; }
  if (!m || !Array.isArray(m.items)) { skip++; continue; }
  ok++;
  const hom = m.hom, awy = m.awy;

  for (const market of m.items) {
    if (!market || !Array.isArray(market.odds)) continue;
    const g = market.bet_group || {};
    if (MAIN_ONLY && !MAIN_MARKETS.has(g.name)) continue;

    for (const odd of market.odds) {
      if (!odd) continue;
      const bt = odd.bet_type || {};
      const spec = mergeSpec(market.specifier, odd.item?.specifier);
      const specStr = Object.entries(spec).map(([k,v])=>`${k}=${v}`).join(';');
      rows.push({
        match_id: m.id, hom, awy, kickoff_EAT: m.schedule,
        market_id: Number(market.id),
        market_name: g.name || '',
        market_order: g.order ?? 999,
        specifier: specStr,
        bet_type_id: bt.id,
        outcome: renderLabel(bt.name, spec, hom, awy),
        odd: odd.odd,
        is_available: odd.is_available,
      });
    }
  }
}

const headers = Object.keys(rows[0] || {});
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
fs.writeFileSync(outFile, csv);

console.log(`Matches parsed: ${ok}, skipped: ${skip}`);
console.log(`Rows written: ${rows.length}${MAIN_ONLY ? ' (main markets only)' : ''}`);
console.log(`Output: ${outFile}`);