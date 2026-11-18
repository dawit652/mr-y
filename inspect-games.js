import https from 'https';
import fs from 'fs';

const agent = new https.Agent({ rejectUnauthorized: false });

const options = {
  hostname: 'api.hulusport.com',
  path: '/casino-new/lobby/?device=desktop',
  method: 'GET',
  agent: agent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Origin': 'https://hulusport.com',
    'Referer': 'https://hulusport.com/games',
  },
};

https.request(options, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    fs.writeFileSync('catalog.json', data);
    const parsed = JSON.parse(data);
    
    console.log('Total Categories:', parsed.length);
    
    let totalGames = 0;
    for (const cat of parsed) {
      totalGames += (cat.games ? cat.games.length : 0);
    }
    console.log('Total Games across all categories:', totalGames);
    console.log('\n--- First Category ---');
    console.log('Name:', parsed[0].name, '| Slug:', parsed[0].slug);
    console.log('Games in this category:', parsed[0].games.length);
    
    console.log('\n--- First Game Structure ---');
    console.log(JSON.stringify(parsed[0].games[0], null, 2));
  });
}).on('error', (e) => console.error('Error:', e.message)).end();