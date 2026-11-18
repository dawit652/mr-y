import fs from 'fs';

const lines = fs.readFileSync('C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\all-odds.csv', 'utf8').split('\n');
const headers = lines[0].split(',');
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

const matches = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols.length < headers.length) continue;
  if (cols[idx.market_name] !== '3 Way') continue;
  const id = cols[idx.match_id];
  if (!matches[id]) matches[id] = { id, hom: cols[idx.hom], awy: cols[idx.awy], odds: {} };
  matches[id].odds[cols[idx.outcome]] = Number(cols[idx.odd]);
}

const rows = [];
for (const m of Object.values(matches)) {
  const o = Object.values(m.odds);
  if (o.length !== 3 || o.some(x => !x)) continue;
  const overround = (1/o[0] + 1/o[1] + 1/o[2] - 1) * 100;
  rows.push({ ...m, overround: Number(overround.toFixed(2)) });
}

rows.sort((a, b) => a.overround - b.overround);

console.log(`Matches with complete 1X2: ${rows.length}`);
console.log('');
console.log('=== Tightest margins (sharpest pricing) ===');
for (const r of rows.slice(0, 10)) {
  console.log(`  ${r.overround.toFixed(2).padStart(6)}%  ${r.hom} vs ${r.awy}`);
}
console.log('');
console.log('=== Widest margins (largest house cut) ===');
for (const r of rows.slice(-10).reverse()) {
  console.log(`  ${r.overround.toFixed(2).padStart(6)}%  ${r.hom} vs ${r.awy}`);
}
console.log('');
const avg = rows.reduce((s, r) => s + r.overround, 0) / rows.length;
console.log(`Average overround: ${avg.toFixed(2)}%`);
console.log(`Median: ${rows[Math.floor(rows.length/2)].overround.toFixed(2)}%`);