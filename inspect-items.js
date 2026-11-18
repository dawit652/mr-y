import fs from 'fs';

const m = JSON.parse(fs.readFileSync('C:\\\\Users\\\\dawit\\\\Desktop\\\\claude projects\\\\mr-y\\\\data\\\\match-2757372.json', 'utf8'));
const items = m.items;

console.log('items count:', items.length);
console.log('');
console.log('=== First item, full ===');
console.log(JSON.stringify(items[0], null, 2));
console.log('');
console.log('=== item keys ===');
console.log(Object.keys(items[0]).join(', '));
console.log('');
console.log('=== Unique bet_group values, with counts ===');
const groups = {};
for (const it of items) {
  const g = it.bet_group;
  groups[g] = (groups[g] || 0) + 1;
}
for (const [g, n] of Object.entries(groups).sort((a, b) => b[1] - a[1])) {
  console.log(`  group ${g}: ${n} outcomes`);
}
console.log('');
console.log('=== Sample items from the top 3 groups ===');
const topGroups = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
for (const g of topGroups) {
  console.log(`\n--- group ${g} ---`);
  const sample = items.filter(it => String(it.bet_group) === g).slice(0, 4);
  for (const it of sample) {
    console.log(`  bet_type=${it.bet_type}  odd=${it.odd}  avail=${it.is_available}  specifier=${JSON.stringify(it.item?.specifier || {})}  item.id=${it.item?.id}`);
  }
}
console.log('');
console.log('=== Items with non-empty specifier (line markets) ===');
const withSpec = items.filter(it => it.item?.specifier && Object.keys(it.item.specifier).length > 0).slice(0, 8);
for (const it of withSpec) {
  console.log(`  group=${it.bet_group}  bet_type=${it.bet_type}  odd=${it.odd}  specifier=${JSON.stringify(it.item.specifier)}`);
}