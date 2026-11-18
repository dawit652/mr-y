import fs from 'fs';
const parsed = JSON.parse(fs.readFileSync('narobet-catalog.json', 'utf8'));

console.log('Sections count:', parsed.sections.length);
console.log('Full games array count:', parsed.games ? parsed.games.length : 'Not an array');

if (parsed.games && parsed.games.length > 0) {
  console.log('\nFirst game in full array:');
  console.log(JSON.stringify(parsed.games[0], null, 2));
}