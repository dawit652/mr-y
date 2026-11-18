import fs from 'fs';

const input = process.argv[2] || 'C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\match-2757372.json';
const marketsArg = process.argv[3];

const m = JSON.parse(fs.readFileSync(input, 'utf8'));
const hom = m.hom, awy = m.awy;

const filter = marketsArg
  ? new Set(marketsArg.split(',').map(s => s.trim().toLowerCase()))
  : null;

function mergeSpec(...specs) {
  const out = {};
  for (const s of specs) if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) out[k] = v;
  return out;
}

function renderLabel(name, spec) {
  return String(name || '')
    .replace(/\{\$competitor1\}/g, hom)
    .replace(/\{\$competitor2\}/g, awy)
    .replace(/\{\$competitorN\}/g, 'Draw')
    .replace(/\{([a-zA-Z]+)\}/g, (_, key) => spec[key] ?? `{${key}}`);
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const rows = [];
for (const market of m.items) {
  if (!market || !Array.isArray(market.odds)) continue;
  const g = market.bet_group || {};
  const marketName = g.name || '';
  if (filter && !filter.has(marketName.toLowerCase())) continue;

  for (const odd of market.odds) {
    if (!odd) continue;
    const bt = odd.bet_type || {};
    const spec = mergeSpec(market.specifier, odd.item?.specifier);
    const specStr = Object.entries(spec).map(([k, v]) => `${k}=${v}`).join(';');
    rows.push({
      match_id: m.id,
      hom, awy,
      kickoff_EAT: m.schedule,
      market_id: Number(market.id),
      market_key: g.mapping_key || slug(marketName),
      market_name: marketName,
      market_order: g.order ?? 999,
      specifier: specStr,
      bet_type_id: bt.id,
      bet_type_order: bt.order ?? 999,
      outcome: renderLabel(bt.name, spec),
      odd: odd.odd,
      is_available: odd.is_available,
    });
  }
}

rows.sort((a, b) =>
  (a.market_order - b.market_order) ||
  (a.market_id - b.market_id) ||
  (a.bet_type_order - b.bet_type_order) ||
  (Number(a.odd) - Number(b.odd))
);

const headers = Object.keys(rows[0]);
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
const outFile = input.replace(/\.json$/, '.csv');
fs.writeFileSync(outFile, csv);

console.log(`Wrote ${rows.length} odds rows from ${m.items.length} markets -> ${outFile}`);
console.log('');

const byName = {};
for (const r of rows) {
  const k = r.market_name;
  if (!byName[k]) byName[k] = { count: 0, sample: [] };
  byName[k].count++;
  if (byName[k].sample.length < 2) byName[k].sample.push(`${r.outcome}${r.specifier ? ` [${r.specifier}]` : ''} @ ${r.odd}`);
}
console.log('=== Markets present (by market_name) ===');
for (const [name, info] of Object.entries(byName).sort((a,b) => b[1].count - a[1].count)) {
  console.log(`  ${String(info.count).padStart(4)}x  ${name}`);
  for (const s of info.sample) console.log(`           ${s}`);
}